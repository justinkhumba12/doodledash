const cluster = require('cluster');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config');
const helmet = require('helmet');

// Integrate the helmet middleware for security headers.
// Configure the Content Security Policy (CSP) frame-ancestors directive to explicitly allow 'self', 
// https://*.telegram.org, and tg: so the application can be safely iframed inside Telegram Web Apps 
// while blocking unauthorized domains.
const helmetSecurity = helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "frame-ancestors": ["'self'", "https://*.telegram.org", "tg:"],
            "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"],
            "style-src": ["'self'", "'unsafe-inline'", "https:"],
            "img-src": ["'self'", "data:", "https:", "http:"],
            "connect-src": ["'self'", "ws:", "wss:", "http:", "https:"]
        },
    },
});

if (cluster.isPrimary) {
    console.log(`[Primary] Process ID: ${process.pid}`);
    console.log(`[Primary] Preparing to fork ${config.NUM_WORKERS} workers...`);

    const setupPrimary = async () => {
        let db;
        try {
            console.log('[Primary] Connecting to MySQL for initial setup...');
            db = await mysql.createConnection(config.MYSQL_URL);
            
            const tablesToDrop = ['users', 'calls'];
            for (let table of tablesToDrop) {
                await db.query(`DROP TABLE IF EXISTS ${table}`);
            }

            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    tg_id VARCHAR(50) PRIMARY KEY,
                    credits DECIMAL(10,2) DEFAULT 0,
                    gems DECIMAL(10,2) DEFAULT 0,
                    streak_count INT DEFAULT 0,
                    last_streak_claim DATE,
                    last_daily_claim DATE,
                    ad_claims_today INT DEFAULT 0,
                    last_ad_claim_time DATETIME,
                    ad2_claims_today INT DEFAULT 0,
                    last_ad2_claim_time DATETIME,
                    accepted_policy BOOLEAN DEFAULT FALSE,
                    last_invite_claim_week VARCHAR(10),
                    last_active DATETIME,
                    status VARCHAR(20) DEFAULT 'active',
                    ban_until DATE DEFAULT NULL,
                    mute_until DATE DEFAULT NULL,
                    gender VARCHAR(10) DEFAULT NULL,
                    name VARCHAR(50) DEFAULT NULL,
                    avatar_url VARCHAR(255) DEFAULT NULL,
                    ban_count INT DEFAULT 0,
                    equipped_style VARCHAR(50) DEFAULT NULL
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS referrals (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    inviter_id VARCHAR(50),
                    invited_id VARCHAR(50) UNIQUE,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS user_weekly_stats (
                    tg_id VARCHAR(50),
                    week_key VARCHAR(10),
                    invites INT DEFAULT 0,
                    guesses INT DEFAULT 0,
                    invites_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    guesses_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (tg_id, week_key)
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS donations (
                    tg_id VARCHAR(50) PRIMARY KEY,
                    total_donated INT DEFAULT 0
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS reports (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    reporter_id VARCHAR(50),
                    reported_id VARCHAR(50),
                    context VARCHAR(50),
                    reason VARCHAR(255),
                    snapshot_data LONGTEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS name_styles (
                    id VARCHAR(50) PRIMARY KEY,
                    class_name VARCHAR(50),
                    font_family VARCHAR(100),
                    css_content TEXT,
                    credit_price INT DEFAULT 0,
                    gem_price INT DEFAULT 0,
                    is_premium BOOLEAN DEFAULT FALSE
                )
            `);

            await db.query(`
                CREATE TABLE IF NOT EXISTS user_styles_inventory (
                    tg_id VARCHAR(50),
                    style_id VARCHAR(50),
                    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (tg_id, style_id)
                )
            `);

            console.log('[Primary] MySQL setup complete.');
        } catch (err) {
            console.error('[Primary] MySQL Init Error:', err);
        } finally {
            if (db) await db.end();
        }

        let redis;
        try {
            console.log('[Primary] Connecting to Redis for initial setup...');
            redis = new Redis(config.REDIS_URL);
            
            const nextId = await redis.get('next_room_id');
            if (!nextId) await redis.set('next_room_id', 1); 

            console.log('[Primary] Redis room setup complete.');
        } catch (err) {
            console.error('[Primary] Redis Init Error:', err);
        } finally {
            if (redis) await redis.quit();
        }

        for (let i = 0; i < config.NUM_WORKERS; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[Primary] Worker ${worker.process.pid} died. Restarting...`);
            cluster.fork();
        });
    };

    setupPrimary();
} else {
    require('./worker');
}
