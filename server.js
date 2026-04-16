const cluster = require('cluster');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config');

if (cluster.isPrimary) {
    console.log(`[Primary] Process ID: ${process.pid}`);
    console.log(`[Primary] Preparing to fork ${config.NUM_WORKERS} workers...`);

    const setupPrimary = async () => {
        let db;
        try {
            console.log('[Primary] Connecting to MySQL for initial setup...');
            db = await mysql.createConnection(config.MYSQL_URL);
            
            const tablesToDrop = ['rooms', 'room_members', 'drawings', 'chats', 'guesses', 'chat_messages', 'calls'];
            for (let table of tablesToDrop) {
                await db.query(`DROP TABLE IF EXISTS ${table}`);
            }

            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    tg_id VARCHAR(50) PRIMARY KEY,
                    credits DECIMAL(10,2) DEFAULT 0,
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
                    gender VARCHAR(10) DEFAULT NULL
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

            const migrations = [
                "ALTER TABLE users MODIFY COLUMN credits DECIMAL(10,2) DEFAULT 0",
                "ALTER TABLE users ADD COLUMN accepted_policy BOOLEAN DEFAULT FALSE",
                "ALTER TABLE users ADD COLUMN last_invite_claim_week VARCHAR(10)",
                "ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active'",
                "ALTER TABLE users ADD COLUMN ban_until DATE DEFAULT NULL",
                "ALTER TABLE users ADD COLUMN mute_until DATE DEFAULT NULL",
                "ALTER TABLE users ADD COLUMN gender VARCHAR(10) DEFAULT NULL",
                "ALTER TABLE users DROP COLUMN username",
                "ALTER TABLE users DROP COLUMN tg_username",
                "ALTER TABLE referrals CHANGE created_at updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
            ];
            for (let query of migrations) {
                try { await db.query(query); } catch (e) { /* Ignore existing columns / non-existing drops */ }
            }
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
    // If not the primary, bootstrap the worker process
    require('./worker');
}
