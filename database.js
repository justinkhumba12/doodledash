const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const config = require('./config');

const redis = new Redis(config.REDIS_URL);
const pubClient = redis.duplicate();
const subClient = redis.duplicate();

redis.on('error', (err) => console.error(`[Redis Error]:`, err));

const db = mysql.createPool({ 
    uri: config.MYSQL_URL, 
    timezone: 'Z', 
    waitForConnections: true, 
    connectionLimit: 5,
    connectTimeout: 10000 // Prevent infinite hanging if DB connects slowly
});

/**
 * Centralized Database Initialization
 * Applies comprehensive CREATE TABLE IF NOT EXISTS commands
 * inclusive of all historical updates and specific schema types.
 */
const initializeDatabase = async () => {
    try {
        console.log('[Database] Starting centralized schema initialization...');

        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                tg_id VARCHAR(50) PRIMARY KEY,
                credits VARCHAR(255) DEFAULT '0',
                gems VARCHAR(255) DEFAULT '0',
                streak_count MEDIUMINT DEFAULT 0,
                last_streak_claim DATE,
                last_daily_claim DATE,
                ad_claims_today MEDIUMINT DEFAULT 0,
                last_ad_claim_time DATETIME,
                ad2_claims_today MEDIUMINT DEFAULT 0,
                last_ad2_claim_time DATETIME,
                accepted_policy TINYINT(1) DEFAULT 0,
                last_invite_claim_week VARCHAR(255),
                last_active DATETIME,
                status VARCHAR(255) DEFAULT 'active',
                ban_until DATE DEFAULT NULL,
                mute_until DATE DEFAULT NULL,
                gender VARCHAR(255) DEFAULT NULL,
                name VARCHAR(255) DEFAULT NULL,
                avatar_url VARCHAR(255) DEFAULT NULL,
                ban_count MEDIUMINT DEFAULT 0,
                equipped_style VARCHAR(255) DEFAULT NULL,
                daily_correct_guesses MEDIUMINT DEFAULT 0,
                last_correct_guess_date DATE,
                last_guess_reward_claim DATE,
                last_top_inviter_claim_week VARCHAR(255)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_audit_logs (
                id MEDIUMINT AUTO_INCREMENT PRIMARY KEY,
                admin_id VARCHAR(50),
                action VARCHAR(255),
                details BLOB,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS donations (
                tg_id VARCHAR(50) PRIMARY KEY,
                total_donated MEDIUMINT DEFAULT 0
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS name_styles (
                id VARCHAR(50) PRIMARY KEY,
                class_name VARCHAR(50),
                font_family VARCHAR(100),
                css_content BLOB,
                credit_price MEDIUMINT DEFAULT 0,
                gem_price MEDIUMINT DEFAULT 0,
                is_premium TINYINT(1) DEFAULT 0,
                is_hidden TINYINT(1) DEFAULT 0
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS referrals (
                id MEDIUMINT AUTO_INCREMENT PRIMARY KEY,
                inviter_id VARCHAR(50),
                invited_id VARCHAR(50) UNIQUE,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS reports (
                id MEDIUMINT AUTO_INCREMENT PRIMARY KEY,
                reporter_id VARCHAR(50),
                reported_id VARCHAR(50),
                context VARCHAR(255),
                reason VARCHAR(255),
                snapshot_data VARCHAR(255),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

        await db.query(`
            CREATE TABLE IF NOT EXISTS user_weekly_stats (
                tg_id VARCHAR(50),
                week_key VARCHAR(50),
                invites MEDIUMINT DEFAULT 0,
                guesses MEDIUMINT DEFAULT 0,
                invites_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                guesses_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (tg_id, week_key)
            )
        `);

        // Seed default Premium Name Styles
        const seedStyles = [
            { id: 'style-neon', class_name: 'style-neon', font_family: 'Righteous', css_content: `.style-neon { font-family: 'Righteous', cursive; color: #4f46e5; animation: neon-pulse 2s infinite alternate; display: inline-block; } @keyframes neon-pulse { 0% { text-shadow: 0 0 5px rgba(79, 70, 229, 0.2); } 100% { text-shadow: 0 0 15px rgba(79, 70, 229, 0.8); } }`, credit_price: 50, gem_price: 10, is_premium: false, is_hidden: false },
            { id: 'style-comic', class_name: 'style-comic', font_family: 'Bangers', css_content: `.style-comic { font-family: 'Bangers', cursive; color: #fde047; text-shadow: 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 3px 4px 0 #ef4444; letter-spacing: 1px; animation: comic-pop 2s infinite alternate; display: inline-block; } @keyframes comic-pop { 0% { transform: scale(1) rotate(-2deg); } 100% { transform: scale(1.05) rotate(2deg); } }`, credit_price: 100, gem_price: 20, is_premium: false, is_hidden: false },
            { id: 'style-god-tier', class_name: 'style-god-tier', font_family: 'Cinzel:wght@600;800', css_content: `.style-god-tier { font-family: 'Cinzel', serif; font-weight: 800; font-size: 1.1rem; background: linear-gradient(to right, #ffd700, #ffdf00, #d4af37, #ffdf00, #ffd700); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; animation: god-shine 2s linear infinite; display: inline-block; } .style-god-tier::before { content: '♛ '; font-size: 1.1rem; -webkit-text-fill-color: #d4af37; filter: drop-shadow(0 0 5px #ffd700); } @keyframes god-shine { to { background-position: 200% center; } }`, credit_price: 0, gem_price: 50, is_premium: true, is_hidden: false },
            { id: 'style-glitch', class_name: 'style-glitch', font_family: 'Courier Prime:wght@700', css_content: `.style-glitch { font-family: 'Courier Prime', monospace; font-weight: 700; position: relative; color: #1f2937; display: inline-block; } .style-glitch::before { content: attr(data-name); position: absolute; left: 2px; top: 0; text-shadow: -1px 0 #ff00c1; background: inherit; clip-path: polygon(0 0, 100% 0, 100% 45%, 0 45%); animation: glitch-anim 2s infinite linear alternate-reverse; } .style-glitch::after { content: attr(data-name); position: absolute; left: -2px; top: 0; text-shadow: -1px 0 #00fff9; background: inherit; clip-path: polygon(0 80%, 100% 20%, 100% 100%, 0 100%); animation: glitch-anim 2.5s infinite linear alternate-reverse; } @keyframes glitch-anim { 0% { clip-path: polygon(0 20%, 100% 20%, 100% 21%, 0 21%); } 20% { clip-path: polygon(0 33%, 100% 33%, 100% 33%, 0 33%); } 40% { clip-path: polygon(0 44%, 100% 44%, 100% 44%, 0 44%); } 60% { clip-path: polygon(0 50%, 100% 50%, 100% 20%, 0 20%); } 80% { clip-path: polygon(0 70%, 100% 70%, 100% 70%, 0 70%); } 100% { clip-path: polygon(0 80%, 100% 80%, 100% 80%, 0 80%); } }`, credit_price: 0, gem_price: 100, is_premium: true, is_hidden: false }
        ];

        for (const style of seedStyles) {
            await db.query(`
                INSERT INTO name_styles (id, class_name, font_family, css_content, credit_price, gem_price, is_premium, is_hidden)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE class_name = VALUES(class_name), font_family = VALUES(font_family), css_content = VALUES(css_content), is_premium = VALUES(is_premium), is_hidden = VALUES(is_hidden)
            `, [style.id, style.class_name, style.font_family, style.css_content, style.credit_price, style.gem_price, style.is_premium, style.is_hidden]);
        }

        console.log('[Database] Initialization completed successfully.');
    } catch (e) {
        console.error('[Database Init Error]:', e);
    }
};

module.exports = { db, redis, pubClient, subClient, initializeDatabase };