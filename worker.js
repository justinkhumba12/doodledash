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
                avatar_url VARCHAR(255) DEFAULT NULL
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
            "ALTER TABLE users DROP COLUMN username",
            "ALTER TABLE users DROP COLUMN tg_username",
            "ALTER TABLE referrals CHANGE created_at updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
        ];
        
        for (let q of migrations) {
            try { await db.query(q); } catch(e) { /* Ignore existing columns / drops */ }
        }
        console.log(`[Worker ${process.pid}] DB Initialization verified.`);
    } catch(e) {
        console.error(`[Worker ${process.pid}] DB Init Error:`, e);
    }
};

initWorkerDB().then(() => {
    server.listen(config.PORT, () => console.log(`[Worker ${process.pid}] Server running on port ${config.PORT}`));
});
