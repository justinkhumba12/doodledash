const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const { createAdapter } = require('@socket.io/redis-adapter');

const config = require('./config');
const { pubClient, subClient, db } = require('./database');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.disable('x-powered-by');

const io = new Server(server, {
    cors: config.CORS_OPTIONS,
    adapter: createAdapter(pubClient, subClient)
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: false 
}));

app.use(cors(config.CORS_OPTIONS));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect application components
require('./routes')(app, io);
require('./sockets')(io);
require('./gameLoop')(io);
require('./adminBackend').setupAdminPanel(app, io);

const initWorkerDB = async () => {
    try {
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

        // NEW: Dynamic Style Tables
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

        const migrations = [
            "ALTER TABLE users MODIFY COLUMN credits DECIMAL(10,2) DEFAULT 0",
            "ALTER TABLE users ADD COLUMN gems DECIMAL(10,2) DEFAULT 0",
            "ALTER TABLE users ADD COLUMN streak_count INT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN last_streak_claim DATE",
            "ALTER TABLE users ADD COLUMN accepted_policy BOOLEAN DEFAULT FALSE",
            "ALTER TABLE users ADD COLUMN last_invite_claim_week VARCHAR(10)",
            "ALTER TABLE users ADD COLUMN status VARCHAR(20) DEFAULT 'active'",
            "ALTER TABLE users ADD COLUMN ban_until DATE DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN mute_until DATE DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN gender VARCHAR(10) DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN name VARCHAR(50) DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) DEFAULT NULL",
            "ALTER TABLE users ADD COLUMN ban_count INT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN equipped_style VARCHAR(50) DEFAULT NULL",
            "ALTER TABLE users DROP COLUMN username",
            "ALTER TABLE users DROP COLUMN tg_username",
            "ALTER TABLE referrals CHANGE created_at updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        ];
        
        for (let q of migrations) {
            try { await db.query(q); } catch(e) { /* Ignore existing columns / drops */ }
        }

        // Seed Default Styles
        const seedStyles = [
            { id: 'style-neon', class_name: 'style-neon', font_family: 'Righteous', css_content: `.style-neon { font-family: 'Righteous', cursive; color: #4f46e5; animation: neon-pulse 2s infinite alternate; display: inline-block; } @keyframes neon-pulse { 0% { text-shadow: 0 0 5px rgba(79, 70, 229, 0.2); } 100% { text-shadow: 0 0 15px rgba(79, 70, 229, 0.8); } }`, credit_price: 50, gem_price: 10, is_premium: false },
            { id: 'style-comic', class_name: 'style-comic', font_family: 'Bangers', css_content: `.style-comic { font-family: 'Bangers', cursive; color: #fde047; text-shadow: 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 3px 4px 0 #ef4444; letter-spacing: 1px; animation: comic-pop 2s infinite alternate; display: inline-block; } @keyframes comic-pop { 0% { transform: scale(1) rotate(-2deg); } 100% { transform: scale(1.05) rotate(2deg); } }`, credit_price: 100, gem_price: 20, is_premium: false },
            { id: 'style-god-tier', class_name: 'style-god-tier', font_family: 'Cinzel:wght@600;800', css_content: `.style-god-tier { font-family: 'Cinzel', serif; font-weight: 800; font-size: 1.1rem; background: linear-gradient(to right, #ffd700, #ffdf00, #d4af37, #ffdf00, #ffd700); background-size: 200% auto; -webkit-background-clip: text; -webkit-text-fill-color: transparent; animation: god-shine 2s linear infinite; display: inline-block; } .style-god-tier::before { content: '♛ '; font-size: 1.1rem; -webkit-text-fill-color: #d4af37; filter: drop-shadow(0 0 5px #ffd700); } @keyframes god-shine { to { background-position: 200% center; } }`, credit_price: 0, gem_price: 50, is_premium: true },
            { id: 'style-glitch', class_name: 'style-glitch', font_family: 'Courier Prime:wght@700', css_content: `.style-glitch { font-family: 'Courier Prime', monospace; font-weight: 700; position: relative; color: #1f2937; display: inline-block; } .style-glitch::before { content: attr(data-name); position: absolute; left: 2px; top: 0; text-shadow: -1px 0 #ff00c1; background: inherit; clip-path: polygon(0 0, 100% 0, 100% 45%, 0 45%); animation: glitch-anim 2s infinite linear alternate-reverse; } .style-glitch::after { content: attr(data-name); position: absolute; left: -2px; top: 0; text-shadow: -1px 0 #00fff9; background: inherit; clip-path: polygon(0 80%, 100% 20%, 100% 100%, 0 100%); animation: glitch-anim 2.5s infinite linear alternate-reverse; } @keyframes glitch-anim { 0% { clip-path: polygon(0 20%, 100% 20%, 100% 21%, 0 21%); } 20% { clip-path: polygon(0 33%, 100% 33%, 100% 33%, 0 33%); } 40% { clip-path: polygon(0 44%, 100% 44%, 100% 44%, 0 44%); } 60% { clip-path: polygon(0 50%, 100% 50%, 100% 20%, 0 20%); } 80% { clip-path: polygon(0 70%, 100% 70%, 100% 70%, 0 70%); } 100% { clip-path: polygon(0 80%, 100% 80%, 100% 80%, 0 80%); } }`, credit_price: 0, gem_price: 100, is_premium: true }
        ];

        for (const style of seedStyles) {
            await db.query(`
                INSERT INTO name_styles (id, class_name, font_family, css_content, credit_price, gem_price, is_premium)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE class_name = VALUES(class_name), font_family = VALUES(font_family), css_content = VALUES(css_content), is_premium = VALUES(is_premium)
            `, [style.id, style.class_name, style.font_family, style.css_content, style.credit_price, style.gem_price, style.is_premium]);
        }

        console.log(`[Worker ${process.pid}] DB Initialization verified.`);
    } catch(e) {
        console.error(`[Worker ${process.pid}] DB Init Error:`, e);
    }
};

initWorkerDB().then(() => {
    server.listen(config.PORT, () => console.log(`[Worker ${process.pid}] Server running on port ${config.PORT}`));
});
