const cluster = require('cluster');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MYSQL_URL = process.env.MYSQL_URL || 'mysql://root:password@localhost:3306/db';
const PORT = process.env.PORT || 3000;
const NUM_WORKERS = process.env.WORKERS ? parseInt(process.env.WORKERS) : (os.cpus().length || 8);
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Core Configuration (Dynamic Star Value)
const CREDITS_PER_STAR = parseInt(process.env.CREDITS_PER_STAR) || 1;

// Allowed Origins Control
const corsOptions = {
    origin: "*",
    methods: ["GET", "POST"]
};

// Cryptographic Validation of Telegram Init Data
function validateInitData(initData, token) {
    if (!initData || !token) return false;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const keys = Array.from(urlParams.keys()).sort();
        const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------
// PRIMARY PROCESS (Run once on startup)
// ---------------------------------------------------------
if (cluster.isPrimary) {
    console.log(`[Primary] Process ID: ${process.pid}`);
    console.log(`[Primary] Preparing to fork ${NUM_WORKERS} workers...`);

    const setupPrimary = async () => {
        let db;
        try {
            console.log('[Primary] Connecting to MySQL for initial setup...');
            db = await mysql.createConnection(MYSQL_URL);
            
            const tablesToDrop = ['rooms', 'room_members', 'drawings', 'chats', 'guesses', 'chat_messages', 'calls'];
            for (let table of tablesToDrop) {
                await db.query(`DROP TABLE IF EXISTS ${table}`);
            }

            // Core Users Table
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

            // New Referrals Table with updated_at tracking
            await db.query(`
                CREATE TABLE IF NOT EXISTS referrals (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    inviter_id VARCHAR(50),
                    invited_id VARCHAR(50) UNIQUE,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            // Weekly Stats Table (Handles the tie-breaker cleanly based on updated_at)
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

            // Donations Table
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
            redis = new Redis(REDIS_URL);
            
            const nextId = await redis.get('next_room_id');
            if (!nextId) await redis.set('next_room_id', 1); 

            console.log('[Primary] Redis room setup complete.');
        } catch (err) {
            console.error('[Primary] Redis Init Error:', err);
        } finally {
            if (redis) await redis.quit();
        }

        for (let i = 0; i < NUM_WORKERS; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[Primary] Worker ${worker.process.pid} died. Restarting...`);
            cluster.fork();
        });
    };

    setupPrimary();

} else {
    // ---------------------------------------------------------
    // WORKER PROCESS
    // ---------------------------------------------------------
    const app = express();
    const server = http.createServer(app);
    
    // CRITICAL FIX: Trust proxies (like Railway, Heroku, Cloudflare, etc.)
    // Without this, rate limiters will block everyone thinking they are on the same IP.
    app.set('trust proxy', 1); 
    app.disable('x-powered-by');

    const redis = new Redis(REDIS_URL);
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();

    redis.on('error', (err) => console.error(`[Worker ${process.pid}] Redis Error:`, err));

    const io = new Server(server, {
        cors: corsOptions,
        adapter: createAdapter(pubClient, subClient)
    });

    const db = mysql.createPool({ 
        uri: MYSQL_URL, 
        timezone: 'Z', 
        waitForConnections: true, 
        connectionLimit: 5,
        connectTimeout: 10000 // Prevent infinite hanging if DB connects slowly
    });

    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        frameguard: false 
    }));

    app.use(cors(corsOptions));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // Telegram API Helpers
    const tgApiCall = (method, data) => {
        if (!BOT_TOKEN) return;
        const https = require('https');
        const payload = JSON.stringify(data);
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${BOT_TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const request = https.request(options);
        request.on('error', console.error);
        request.write(payload);
        request.end();
    };

    const sendMsg = (chatId, text, replyMarkup) => {
        tgApiCall('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
    };

    // Get current ISO year-week format (e.g., "2024-W12")
    function getWeekKey() {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
        const weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
        return `${d.getUTCFullYear()}-W${weekNo}`;
    }

    app.get('/sw.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.send(`
            const CACHE_NAME = 'doodledash-cache-v5'; // Bumped version to ensure clean reload
            const urlsToCache = [
                '/audio/mgs_notification.mp3',
                '/audio/guess_notification.mp3',
                'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
                'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
                'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap'
            ];
            
            self.addEventListener('install', event => {
                self.skipWaiting();
                event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
            });

            self.addEventListener('activate', event => {
                event.waitUntil(
                    caches.keys().then(cacheNames => {
                        return Promise.all(
                            cacheNames.map(cacheName => {
                                if (cacheName !== CACHE_NAME) {
                                    return caches.delete(cacheName);
                                }
                            })
                        );
                    })
                );
                return self.clients.claim();
            });

            self.addEventListener('fetch', event => {
                if (event.request.mode === 'navigate' || event.request.url.includes('index.html')) {
                    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
                } else {
                    event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
                }
            });
        `);
    });

    app.get('/postback', async (req, res) => {
        const { ymid, event_type, reward_event_type, estimated_price, zone } = req.query;
        if (reward_event_type === 'valued' && ymid) {
            try {
                console.log(`[Monetag Postback] User ${ymid} successfully completed ad for Zone: ${zone}. Revenue: ${estimated_price}`);
            } catch (err) {
                console.error('[Monetag Postback DB Error]', err);
            }
        }
        res.sendStatus(200); 
    });

    const toHex = (id) => id ? "0x" + Number(id).toString(16).toUpperCase().slice(-6) : '';

    const INK_CONFIG = {
        black: { free: 2500, extra: 2500, cost: 0.5 }
    };

    async function getRoom(roomId) {
        const data = await redis.get(`room:${roomId}`);
        if (!data) return null;
        const room = JSON.parse(data);
        if (room.modified_at) room.modified_at = new Date(room.modified_at);
        if (room.expire_at) room.expire_at = new Date(room.expire_at);
        if (room.break_end_time) room.break_end_time = new Date(room.break_end_time);
        if (room.round_end_time) room.round_end_time = new Date(room.round_end_time);
        return room;
    }

    async function saveRoom(room) {
        room.modified_at = new Date();
        await redis.set(`room:${room.id}`, JSON.stringify(room));
        await redis.sadd('active_rooms', room.id);
    }

    async function releaseRoomMemory(roomId) {
        await redis.del(`room:${roomId}:drawings`, `room:${roomId}:redo`);
    }

    async function deleteRoomData(roomId) {
        if (!roomId) return;
        await redis.del(`room:${roomId}`, `room:${roomId}:chats`, `room:${roomId}:guesses`, `room:${roomId}:drawings`, `room:${roomId}:redo`);
        await redis.srem('active_rooms', roomId);
    }

    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, 
        max: 100, 
        message: { error: 'Too many authentication requests from this IP, please try again after 15 minutes.' },
        standardHeaders: true, 
        legacyHeaders: false,
    });

    app.post('/api/authenticate', authLimiter, async (req, res) => {
        const { initData, profile_pic } = req.body;
        if (!initData) return res.status(400).json({ error: 'Missing initData' });

        const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
        
        if (!isMock && BOT_TOKEN && !validateInitData(initData, BOT_TOKEN)) {
            return res.status(403).json({ error: 'Invalid authentication payload.' });
        }

        try {
            const urlParams = new URLSearchParams(initData);
            const userObjStr = urlParams.get('user');
            
            if (!userObjStr) return res.status(400).json({ error: 'No user data in payload.' });
            
            let userObj;
            try {
                userObj = JSON.parse(userObjStr);
            } catch (e) {
                return res.status(400).json({ error: 'Malformed user data format.' });
            }

            const tgId = userObj.id.toString();

            if (userObj.username) {
                await redis.hset('user_usernames', tgId, userObj.username);
            }

            const [rows] = await db.query(`SELECT status, DATE_FORMAT(ban_until, '%Y-%m-%d') as ban_until_str FROM users WHERE tg_id = ?`, [tgId]);
            
            if (rows.length === 0) {
                return res.json({ success: false, error: 'not_registered' });
            }
            
            const user = rows[0];
            if (user.status === 'ban' && user.ban_until_str) {
                const todayStr = new Date().toISOString().split('T')[0];
                if (user.ban_until_str >= todayStr) {
                    sendMsg(tgId, `🛑 You are currently banned until ${user.ban_until_str}.\n\nYou can lift this ban immediately for 50 Telegram Stars.`, {
                        inline_keyboard: [[{ text: '🔓 Unban (50 ⭐️)', callback_data: 'unban_action' }]]
                    });
                    return res.json({ success: false, error: 'banned' });
                } else {
                    await db.query(`UPDATE users SET status = 'active', ban_until = NULL WHERE tg_id = ?`, [tgId]);
                }
            }

            await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tgId]);
            
            if (profile_pic) {
                await redis.hset('user_profiles', tgId, profile_pic);
            }

            res.json({ success: true, userId: tgId });
        } catch (err) {
            console.error('/api/authenticate error:', err);
            res.status(500).json({ error: 'Internal server error during authentication.' });
        }
    });

    // ---------------------------------------------------------
    // WEBHOOK
    // ---------------------------------------------------------
    app.post('/webhook', async (req, res) => {
        const secretToken = req.headers['x-telegram-bot-api-secret-token'];
        if (WEBHOOK_SECRET && secretToken !== WEBHOOK_SECRET) {
            return res.status(403).send('Unauthorized');
        }

        const update = req.body;
        res.sendStatus(200); 

        if (!BOT_TOKEN) return;

        // Cache username from telegram webhook interactions
        if (update?.message?.from?.username) {
            redis.hset('user_usernames', update.message.from.id.toString(), update.message.from.username);
        }
        if (update?.callback_query?.from?.username) {
            redis.hset('user_usernames', update.callback_query.from.id.toString(), update.callback_query.from.username);
        }

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const fallbackUrl = `${protocol}://${host}/`;
        const webAppUrl = process.env.WEBAPP_URL || fallbackUrl; 

        if (update?.pre_checkout_query) {
            tgApiCall('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
            return;
        }

        if (update?.message?.successful_payment) {
            try {
                const payload = JSON.parse(update.message.successful_payment.invoice_payload);
                const buyerId = payload.tgId;
                const type = payload.type || 'credits'; 
                
                if (type === 'credits') {
                    const addedCredits = payload.amount * CREDITS_PER_STAR;
                    const currentCredits = parseFloat(await redis.hget('user_credits', buyerId)) || 0;
                    await redis.hset('user_credits', buyerId, currentCredits + addedCredits);
                    
                    await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [addedCredits, buyerId]);
                    sendMsg(update.message.chat.id, `✅ Successfully purchased ${addedCredits} Credits! Your balance has been updated.`);
                    
                    const userState = await getUserState(buyerId);
                    if (userState) io.to(`user_${buyerId}`).emit('user_update', userState);
                } else if (type === 'unban') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(ban_until, '%Y-%m-%d') as ban_until_str FROM users WHERE tg_id = ?`, [buyerId]);
                    let alreadyActive = false;
                    if (rows.length > 0) {
                        const u = rows[0];
                        if (u.status !== 'ban' || !u.ban_until_str) alreadyActive = true;
                        else if (u.ban_until_str < new Date().toISOString().split('T')[0]) alreadyActive = true;
                    } else { alreadyActive = true; }

                    if (alreadyActive) {
                        const refundCredits = 50 * CREDITS_PER_STAR;
                        await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [refundCredits, buyerId]);
                        await redis.hincrbyfloat('user_credits', buyerId, refundCredits);
                        sendMsg(update.message.chat.id, `✅ You were already unbanned! Your payment of 50 stars has been converted to ${refundCredits} Credits.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', ban_until = NULL WHERE tg_id = ?`, [buyerId]);
                        sendMsg(buyerId, "✅ Your account has been successfully unbanned! You can now access the app.");
                    }
                } else if (type === 'unmute') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [buyerId]);
                    let alreadyActive = false;
                    if (rows.length > 0) {
                        const u = rows[0];
                        if (u.status !== 'mute' || !u.mute_until_str) alreadyActive = true;
                        else if (u.mute_until_str < new Date().toISOString().split('T')[0]) alreadyActive = true;
                    } else { alreadyActive = true; }

                    if (alreadyActive) {
                        const refundCredits = 25 * CREDITS_PER_STAR;
                        await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [refundCredits, buyerId]);
                        await redis.hincrbyfloat('user_credits', buyerId, refundCredits);
                        sendMsg(update.message.chat.id, `✅ You were already unmuted! Your payment of 25 stars has been converted to ${refundCredits} Credits.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [buyerId]);
                        sendMsg(buyerId, "✅ You have been unmuted! You can now chat in rooms.");
                    }
                } else if (type === 'donate') {
                    const donAmount = payload.amount;
                    await db.query('INSERT INTO donations (tg_id, total_donated) VALUES (?, ?) ON DUPLICATE KEY UPDATE total_donated = total_donated + ?', [buyerId, donAmount, donAmount]);
                    await redis.del('donators_leaderboard'); // Reset donators cache immediately
                    sendMsg(buyerId, `💖 Thank you for donating ${donAmount} Stars! Your support keeps DoodleDash alive.`);
                }
            } catch(e) { console.error('Payment processing error:', e); }
            return;
        }

        if (update?.message?.text && update.message.text.startsWith('/start')) {
            const chatId = update.message.chat.id;
            const tgId = update.message.from.id.toString();
            const text = update.message.text;
            
            try {
                if (text === '/start unmute') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [tgId]);
                    if (rows.length > 0 && rows[0].status === 'mute' && rows[0].mute_until_str) {
                        const todayStr = new Date().toISOString().split('T')[0];
                        if (rows[0].mute_until_str >= todayStr) {
                            sendMsg(chatId, `🔇 You are currently muted until ${rows[0].mute_until_str}.\n\nYou can lift this mute immediately for 25 Telegram Stars.`, {
                                inline_keyboard: [[{ text: '🔊 Unmute (25 ⭐️)', callback_data: 'unmute_action' }]]
                            });
                            return;
                        } else {
                            await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [tgId]);
                        }
                    }
                    sendMsg(chatId, "You are not currently muted.");
                    return;
                }

                const [userRows] = await db.query('SELECT accepted_policy FROM users WHERE tg_id = ?', [tgId]);
                const hasAccepted = userRows.length > 0 && userRows[0].accepted_policy;

                if (text === '/start load_balance') {
                    sendMsg(chatId, `💎 Select a package to top up your credits:\n\n*Rate: 1 Telegram Star = ${CREDITS_PER_STAR} Credit(s)*`, {
                        inline_keyboard: [
                            [{ text: `${1 * CREDITS_PER_STAR} Credit(s) (1 ⭐️)`, callback_data: 'buy_1' }, { text: `${10 * CREDITS_PER_STAR} Credits (10 ⭐️)`, callback_data: 'buy_10' }],
                            [{ text: `${20 * CREDITS_PER_STAR} Credits (20 ⭐️)`, callback_data: 'buy_20' }, { text: `${50 * CREDITS_PER_STAR} Credits (50 ⭐️)`, callback_data: 'buy_50' }],
                            [{ text: `${100 * CREDITS_PER_STAR} Credits (100 ⭐️)`, callback_data: 'buy_100' }],
                            [{ text: `${500 * CREDITS_PER_STAR} Credits (500 ⭐️)`, callback_data: 'buy_500' }],
                            [{ text: `${1000 * CREDITS_PER_STAR} Credits (1000 ⭐️)`, callback_data: 'buy_1000' }]
                        ]
                    });
                    return;
                }
                
                if (text === '/start donate') {
                    sendMsg(chatId, "💖 Support DoodleDash!\nSelect an amount to donate in Telegram Stars:", {
                        inline_keyboard: [
                            [{ text: 'Donate 1 ⭐️', callback_data: 'donate_1' }, { text: 'Donate 5 ⭐️', callback_data: 'donate_5' }],
                            [{ text: 'Donate 10 ⭐️', callback_data: 'donate_10' }, { text: 'Donate 20 ⭐️', callback_data: 'donate_20' }],
                            [{ text: 'Donate 50 ⭐️', callback_data: 'donate_50' }, { text: 'Donate 100 ⭐️', callback_data: 'donate_100' }]
                        ]
                    });
                    return;
                }

                if (!hasAccepted) {
                    let inviterId = 'none';
                    const parts = text.split(' ');
                    if (parts.length > 1 && parts[1].startsWith('invite_')) {
                        inviterId = parts[1].replace('invite_', '');
                    }
                    sendMsg(chatId, "📜 *Welcome to DoodleDash!*\n\nPlease read and accept our Privacy Policy to start playing, earning rewards, and inviting friends.", {
                        inline_keyboard: [[{ text: "✅ I've read and accept", callback_data: `accept_policy_${inviterId}` }]]
                    });
                    return;
                }

                // Normal app start
                const urlWithParams = `${webAppUrl}`;
                sendMsg(chatId, 'Welcome back to DoodleDash! Click below to play.', {
                    inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
                });

            } catch (e) {
                console.error('Webhook DB Error:', e);
            }
        } else if (update?.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const tgId = query.from.id.toString();

            if (query.data.startsWith('claim_weekly_')) {
                const parts = query.data.split('_');
                const week = parts[2];
                const amount = parseInt(parts[3]);
                
                const lockKey = `claimed_weekly_${week}_${tgId}`;
                const locked = await redis.set(lockKey, '1', 'EX', 86400 * 30, 'NX'); 
                if (locked) {
                    await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [amount, tgId]);
                    await redis.hincrbyfloat('user_credits', tgId, amount);
                    
                    tgApiCall('deleteMessage', { chat_id: chatId, message_id: query.message.message_id });
                    sendMsg(chatId, `✅ You successfully claimed ${amount} credits for the weekly challenge!`);
                    
                    const userState = await getUserState(tgId);
                    if (userState) io.to(`user_${tgId}`).emit('user_update', userState);
                } else {
                    tgApiCall('answerCallbackQuery', { callback_query_id: query.id, text: "Already claimed!", show_alert: true });
                }
                return;
            }

            // Handle Privacy Policy Acceptance & Referrals
            if (query.data.startsWith('accept_policy_')) {
                const inviterId = query.data.replace('accept_policy_', '');

                try {
                    await db.query(`
                        INSERT INTO users (tg_id, credits, accepted_policy, status, last_active) 
                        VALUES (?, 5, TRUE, 'active', UTC_TIMESTAMP()) 
                        ON DUPLICATE KEY UPDATE accepted_policy = TRUE, last_active = UTC_TIMESTAMP()
                    `, [tgId]);

                    if (inviterId && inviterId !== 'none' && inviterId !== tgId) {
                        const [res] = await db.query('INSERT IGNORE INTO referrals (inviter_id, invited_id) VALUES (?, ?)', [inviterId, tgId]);
                        if (res.affectedRows > 0) {
                            // Valid new invite - Add to Database Leaderboard Stats
                            const weekKey = getWeekKey();
                            await db.query(`
                                INSERT INTO user_weekly_stats (tg_id, week_key, invites, invites_updated_at)
                                VALUES (?, ?, 1, UTC_TIMESTAMP())
                                ON DUPLICATE KEY UPDATE invites = invites + 1, invites_updated_at = UTC_TIMESTAMP()
                            `, [inviterId, weekKey]);
                            
                            sendMsg(inviterId, "🎉 A new user joined via your link! Check your Tasks to track your weekly progress and claim credits.");
                            
                            const userState = await getUserState(inviterId);
                            if (userState) io.to(`user_${inviterId}`).emit('user_update', userState);
                        }
                    }

                    tgApiCall('editMessageText', {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        text: "✅ Privacy Policy Accepted!\n\nWelcome to DoodleDash. Click below to play.",
                        reply_markup: {
                            inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: `${webAppUrl}` } }]]
                        }
                    });
                    tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
                } catch(e) { console.error('Policy Accept Error:', e); }
                return;
            }

            if (query.data.startsWith('buy_')) {
                const amount = parseInt(query.data.split('_')[1]); // stars
                const credits = amount * CREDITS_PER_STAR;
                
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'credits', amount: amount });
                
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `${credits} DoodleDash Credits`,
                    description: `Top up your account with ${credits} credits.`,
                    payload: payload,
                    provider_token: "", 
                    currency: "XTR",
                    prices: [{ label: `${credits} Credits`, amount: amount }]
                });
                
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            } else if (query.data.startsWith('donate_')) {
                const amount = parseInt(query.data.split('_')[1]);
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'donate', amount: amount });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Donate to DoodleDash`,
                    description: `Support DoodleDash with a donation of ${amount} Stars!`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Donation`, amount: amount }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            } else if (query.data === 'unban_action') {
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'unban' });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Unban Account`,
                    description: `Lift your ban immediately and regain access to DoodleDash.`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Unban Fee`, amount: 50 }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            } else if (query.data === 'unmute_action') {
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'unmute' });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Unmute Account`,
                    description: `Lift your chat mute immediately and regain chatting privileges.`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Unmute Fee`, amount: 25 }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            }
        }
    });

    async function getUserState(tg_id) {
        const weekKey = getWeekKey();
        
        const [statsRows] = await db.query('SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?', [tg_id, weekKey]);
        const weeklyInvites = statsRows.length > 0 ? statsRows[0].invites : 0;

        const [rows] = await db.query(`
            SELECT *,
            (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as daily_available,
            (last_ad_claim_time IS NULL OR DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad_claims_today < 3 AND TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()) >= 60)) as ad1_available,
            (last_ad2_claim_time IS NULL OR DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad2_claims_today < 5 AND TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()) >= 10)) as ad2_available,
            GREATEST(0, 60 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()), 60)) as ad1_wait_mins,
            GREATEST(0, 10 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()), 10)) as ad2_wait_mins,
            (DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad1_is_today,
            (DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad2_is_today,
            (last_invite_claim_week = ?) as invite_claimed_this_week
            FROM users WHERE tg_id = ?
        `, [weekKey, tg_id]);

        if (rows.length === 0) return null;
        let u = rows[0];
        
        // Attach DB weekly invites
        u.weekly_invites = weeklyInvites;

        await redis.hset('user_credits', tg_id, u.credits);
        
        if (!u.ad1_is_today) u.ad_claims_today = 0;
        if (!u.ad2_is_today) u.ad2_claims_today = 0;
        return u;
    }

    // ---------------------------------------------------------
    // LOBBY & ROOM FUNCTIONS
    // ---------------------------------------------------------
    const broadcastRooms = async () => {
        const activeIds = await redis.smembers('active_rooms');
        const roomsList = [];
        for (const id of activeIds) {
            const room = await getRoom(id);
            if (room) {
                roomsList.push({
                    id: room.id,
                    status: room.status,
                    is_private: room.is_private,
                    max_members: room.max_members,
                    creator_id: room.creator_id,
                    member_count: room.members.length
                });
            }
        }
        io.to('lobby').emit('lobby_rooms_update', roomsList);
    };

    const checkRoomReset = async (roomId) => {
        if (!roomId) return;
        const room = await getRoom(roomId);
        if (!room) return;

        if (room.members.length === 0) {
            if (!room.is_private) {
                await deleteRoomData(roomId);
            } else {
                room.status = 'WAITING';
                room.current_drawer_id = null;
                room.word_to_draw = null;
                room.break_end_time = null;
                room.round_end_time = null;
                room.end_reason = null;
                room.members.forEach(m => m.has_given_up = 0);
                await releaseRoomMemory(roomId); 
                await redis.del(`room:${roomId}:guesses`);
                await saveRoom(room);
            }
        } else if (room.members.length < 2) {
            room.status = 'WAITING';
            room.current_drawer_id = null;
            room.word_to_draw = null;
            room.break_end_time = null;
            room.round_end_time = null;
            room.end_reason = null;
            room.members.forEach(m => m.has_given_up = 0);
            await releaseRoomMemory(roomId); 
            await redis.del(`room:${roomId}:guesses`);
            await saveRoom(room);
        }
    };

    const syncRoom = async (roomId) => {
        if (!roomId) return;
        const room = await getRoom(roomId);
        if (!room) return;

        const members = room.members;
        const rawChats = await redis.lrange(`room:${roomId}:chats`, 0, -1);
        const chats = rawChats.map(c => JSON.parse(c));
        
        const rawGuesses = await redis.lrange(`room:${roomId}:guesses`, 0, -1);
        const guesses = rawGuesses.map(g => JSON.parse(g));

        const userIds = new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)]);
        const profiles = {};
        const genders = {};
        
        if (userIds.size > 0) {
            const idsArr = Array.from(userIds);
            const results = await redis.hmget('user_profiles', ...idsArr);
            idsArr.forEach((id, i) => profiles[id] = results[i] || null);
            
            try {
                const [genRows] = await db.query(`SELECT tg_id, gender FROM users WHERE tg_id IN (?)`, [idsArr]);
                genRows.forEach(r => genders[r.tg_id] = r.gender);
            } catch (e) {
                console.error('Gender fetch error in syncRoom:', e);
            }
        }

        const roomSockets = await io.in(`room_${roomId}`).fetchSockets();
        if (roomSockets) {
            for (const s of roomSockets) {
                const userId = s.data.currentUser;
                if (!userId) continue;

                const isDrawer = room.current_drawer_id === userId;
                
                const sanitizedGuesses = guesses.map(g => {
                    if (isDrawer || g.user_id === userId || room.status === 'REVEAL' || room.status === 'BREAK') {
                        return g;
                    }
                    return { ...g, guess_text: '••••••••' };
                });

                let masked_word = null;
                if (['DRAWING', 'REVEAL', 'BREAK'].includes(room.status)) {
                    const base_hints = JSON.parse(room.base_hints || '[]');
                    const actual_word = room.word_to_draw || '';
                    const memberData = members.find(m => m.user_id === userId);
                    const purchased_hints = JSON.parse(memberData?.purchased_hints || '[]');
                    const isReveal = room.status !== 'DRAWING';
                    
                    masked_word = actual_word.split('').map((char, index) => {
                        if (char === ' ') return { char: ' ', index, revealed: true };
                        if (isDrawer || isReveal || base_hints.includes(index) || purchased_hints.includes(index)) {
                            return { char, index, revealed: true };
                        }
                        return { char: null, index, revealed: false };
                    });
                }

                s.emit('room_sync', {
                    room: { 
                        ...room, 
                        expire_at: room.expire_at ? room.expire_at.toISOString() : null,
                        break_end_time: room.break_end_time ? room.break_end_time.toISOString() : null,
                        round_end_time: room.round_end_time ? room.round_end_time.toISOString() : null
                    },
                    members,
                    chats, 
                    guesses: sanitizedGuesses,
                    profiles,
                    genders,
                    masked_word: masked_word,
                    server_time: new Date().toISOString()
                });
            }
        }
    };

    // ---------------------------------------------------------
    // SOCKET.IO EVENTS
    // ---------------------------------------------------------
    io.on('connection', (socket) => {
        socket.data.lastActiveEvent = Date.now();
        socket.data.idleWarned = false;
        socket.data.currentUser = null;
        socket.data.currentRoom = null;
        socket.data.lastMessageTime = 0; 
        
        const checkRateLimit = () => {
            const now = Date.now();
            if (now - socket.data.lastMessageTime < 1000) return false;
            socket.data.lastMessageTime = now;
            return true;
        };

        socket.actionLock = Promise.resolve();
        const queuedAction = async (fn) => {
            const prev = socket.actionLock;
            let resolveLock;
            socket.actionLock = new Promise(r => resolveLock = r);
            await prev;
            try { await fn(); } catch(e){ console.error(e) } finally { resolveLock(); }
        };

        const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
            const room = await getRoom(roomIdNum);
            if (!room) return socket.emit('join_error', 'Room not found.');
            if (room.members.length >= room.max_members) return socket.emit('join_error', 'Room is full.');

            const existingMember = room.members.find(m => m.user_id === userId);
            if (existingMember) {
                socket.data.currentRoom = roomIdNum;
                socket.join(`room_${roomIdNum}`);
                socket.leave('lobby'); 
                socket.emit('join_success', roomIdNum);
                return await syncRoom(roomIdNum);
            }

            if (!bypassCost) {
                if (room.is_private) {
                    if (room.creator_id !== userId && room.password !== password) {
                        return socket.emit('join_error', 'Incorrect password.');
                    }
                }
            }

            const oldRoom = socket.data.currentRoom;
            if (oldRoom) {
                socket.leave(`room_${oldRoom}`);
                const oRoom = await getRoom(oldRoom);
                if (oRoom) {
                    oRoom.members = oRoom.members.filter(m => m.user_id !== userId);
                    await saveRoom(oRoom);
                    await checkRoomReset(oldRoom);
                }
            }

            room.members.push({
                room_id: roomIdNum,
                user_id: userId,
                is_ready: 0,
                consecutive_turns: 0,
                total_turns: 0,
                has_given_up: 0,
                purchased_hints: '[]',
                ink_used: {},      
                ink_extra: {},     
                joined_at: Date.now() 
            });

            await saveRoom(room);
            socket.data.currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.leave('lobby');
            socket.emit('join_success', roomIdNum);
            
            if (oldRoom) await syncRoom(oldRoom);
            await syncRoom(roomIdNum);
            await broadcastRooms();

            const userState = await getUserState(userId);
            if (userState) socket.emit('user_update', userState);
        };

        socket.on('auth', async ({ initData }) => {
            try {
                let currentUser;
                
                if (initData) {
                    const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
                    if (!isMock && BOT_TOKEN && !validateInitData(initData, BOT_TOKEN)) {
                        return socket.emit('auth_error', 'Invalid Telegram authentication payload.');
                    }
                    const urlParams = new URLSearchParams(initData);
                    const userObjStr = urlParams.get('user');
                    if (!userObjStr) return socket.emit('auth_error', 'Invalid user payload.');
                    const userObj = JSON.parse(userObjStr);
                    currentUser = userObj.id.toString(); 
                    if (userObj.username) {
                        await redis.hset('user_usernames', currentUser, userObj.username);
                    }
                } else {
                    return socket.emit('auth_error', 'Access Denied: Please open via Telegram.');
                }
                
                socket.data.currentUser = currentUser;
                await redis.hdel('user_disconnects', currentUser);

                socket.join(`user_${currentUser}`);

                const userState = await getUserState(currentUser);
                
                const activeRooms = await redis.smembers('active_rooms');
                let foundRoom = null;
                for (const id of activeRooms) {
                    const room = await getRoom(id);
                    if (room && room.members.some(m => String(m.user_id) === currentUser)) {
                        foundRoom = id;
                        socket.data.currentRoom = foundRoom;
                        socket.join(`room_${foundRoom}`);
                        await syncRoom(foundRoom);
                        break;
                    }
                }

                if (!foundRoom) {
                    socket.join('lobby');
                }

                const roomsList = [];
                for (const id of activeRooms) {
                    const room = await getRoom(id);
                    if(room) {
                        roomsList.push({
                            id: room.id, status: room.status, is_private: room.is_private, max_members: room.max_members,
                            creator_id: room.creator_id, member_count: room.members.length
                        });
                    }
                }

                socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom: socket.data.currentRoom });
            } catch (err) { 
                console.error('Auth Error', err); 
                socket.emit('auth_error', 'Authentication processing failed.');
            }
        });
        
        socket.on('get_leaderboard', async () => {
            try {
                const weekKey = getWeekKey();
                
                // Fetch top inviters
                const [inviterRows] = await db.query(`
                    SELECT tg_id, invites FROM user_weekly_stats 
                    WHERE week_key = ? AND invites > 0 
                    ORDER BY invites DESC, invites_updated_at ASC LIMIT 50
                `, [weekKey]);
                
                // Fetch top guessers
                const [guesserRows] = await db.query(`
                    SELECT tg_id, guesses FROM user_weekly_stats 
                    WHERE week_key = ? AND guesses > 0 
                    ORDER BY guesses DESC, guesses_updated_at ASC LIMIT 50
                `, [weekKey]);

                const populateProfiles = async (rows, scoreField) => {
                    const result = [];
                    for (const row of rows) {
                        const id = row.tg_id;
                        const username = await redis.hget('user_usernames', id) || 'unset';
                        const profile_pic = await redis.hget('user_profiles', id);
                        result.push({ tg_id: id, score: row[scoreField], username, profile_pic });
                    }
                    return result;
                };

                const inviters = await populateProfiles(inviterRows, 'invites');
                const guessers = await populateProfiles(guesserRows, 'guesses');
                
                // Fetch previous week's top 5 cached data
                const prevInvitersRaw = await redis.get('previous_week_top_inviters');
                const prevGuessersRaw = await redis.get('previous_week_top_guessers');
                const prevInvitersData = prevInvitersRaw ? JSON.parse(prevInvitersRaw) : [];
                const prevGuessersData = prevGuessersRaw ? JSON.parse(prevGuessersRaw) : [];

                const prevInviters = await populateProfiles(prevInvitersData, 'invites');
                const prevGuessers = await populateProfiles(prevGuessersData, 'guesses');

                socket.emit('leaderboard_data', { inviters, guessers, prevInviters, prevGuessers });
            } catch (err) {
                console.error('Leaderboard error:', err);
            }
        });

        socket.on('get_donators_leaderboard', async () => {
            try {
                const cached = await redis.get('donators_leaderboard');
                if (cached) {
                    return socket.emit('donators_leaderboard_data', JSON.parse(cached));
                }
                
                const [rows] = await db.query('SELECT tg_id, total_donated FROM donations ORDER BY total_donated DESC LIMIT 50');
                const leaderboard = [];
                for (const row of rows) {
                    const username = await redis.hget('user_usernames', row.tg_id) || 'unset';
                    const profile_pic = await redis.hget('user_profiles', row.tg_id);
                    leaderboard.push({ tg_id: row.tg_id, total_donated: row.total_donated, username, profile_pic });
                }
                await redis.set('donators_leaderboard', JSON.stringify(leaderboard), 'EX', 86400); // 24 hours
                socket.emit('donators_leaderboard_data', leaderboard);
            } catch (err) { console.error('Donators leaderboard error:', err); }
        });

        socket.on('set_gender', async ({ gender }) => {
            const currentUser = socket.data.currentUser;
            if (!currentUser || !['Male', 'Female', 'Other'].includes(gender)) return;
            try {
                const [rows] = await db.query('SELECT gender, credits FROM users WHERE tg_id = ?', [currentUser]);
                if (rows.length === 0) return;
                
                let cost = 0;
                if (rows[0].gender !== null) {
                    cost = 5;
                    if (rows[0].credits < 5) return socket.emit('create_error', 'Not enough credits to change gender.');
                }
                
                if (cost > 0) {
                    await db.query('UPDATE users SET credits = credits - ?, gender = ? WHERE tg_id = ?', [cost, gender, currentUser]);
                    await redis.hset('user_credits', currentUser, rows[0].credits - cost);
                } else {
                    await db.query('UPDATE users SET gender = ? WHERE tg_id = ?', [gender, currentUser]);
                }
                socket.emit('reward_success', `Gender updated to ${gender}.`);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            } catch (err) { console.error('Set Gender Error:', err); }
        });

        socket.on('request_initial_drawings', async () => {
            const currentRoom = socket.data.currentRoom;
            if (currentRoom) {
                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                socket.emit('sync_initial_drawings', drawings.map(d => ({ lines: d.lines, color: d.color })));
            }
        });

        socket.on('active_event', () => {
            socket.data.lastActiveEvent = Date.now();
            socket.data.idleWarned = false;
        });

        socket.on('send_reaction', ({ emoji, action }) => {
            const currentRoom = socket.data.currentRoom;
            const currentUser = socket.data.currentUser;
            if (currentRoom && currentUser) {
                io.to(`room_${currentRoom}`).emit('new_reaction', { user_id: currentUser, emoji, action });
            }
        });

        socket.on('claim_reward', async ({ type }) => {
            try {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;
                let success = false;
                let msg = '';
                let rewardAmount = 0;

                if (type === 'daily') {
                    const [res] = await db.query(`
                        UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                        WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
                    `, [currentUser]);
                    if (res.affectedRows > 0) { success = true; rewardAmount = 1; msg = 'Daily reward claimed! +1 Credit'; }
                    else { msg = 'Daily reward already claimed today.'; }
                } 
                else if (type === 'ad' || type === 'ad2') {
                    const prefix = type === 'ad' ? 'ad' : 'ad2';
                    const cooldown = prefix === 'ad' ? 60 : 10;
                    const maxClaims = prefix === 'ad' ? 3 : 5; 
                    
                    const [u] = await db.query(`SELECT
                        ${prefix}_claims_today as claims,
                        DATE_FORMAT(last_${prefix}_claim_time, '%Y-%m-%d') as last_date,
                        DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                        TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                        FROM users WHERE tg_id = ?`, [currentUser]);

                    if (u.length > 0) {
                        const user = u[0];
                        const isToday = user.last_date === user.today;

                        if (!user.last_date || !isToday) {
                            rewardAmount = 1;
                            await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, currentUser]);
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit`;
                        } else if (user.claims < maxClaims && (user.mins_passed === null || user.mins_passed >= cooldown)) {
                            const newClaimCount = user.claims + 1;
                            rewardAmount = 1;
                            if (prefix === 'ad' && newClaimCount === 3) rewardAmount = 2;
                            if (prefix === 'ad2' && (newClaimCount === 4 || newClaimCount === 5)) rewardAmount = 2;

                            await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = ?, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit${rewardAmount > 1 ? 's' : ''}`;
                        } else {
                            msg = `Ad reward not available yet. Max ${maxClaims} per day, ${cooldown} mins apart.`;
                        }
                    }
                } else if (type === 'invite_3') {
                    const weekKey = getWeekKey();
                    const [statsRows] = await db.query('SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?', [currentUser, weekKey]);
                    const weeklyInvites = statsRows.length > 0 ? statsRows[0].invites : 0;
                    const [u] = await db.query(`SELECT last_invite_claim_week FROM users WHERE tg_id = ?`, [currentUser]);

                    if (u.length > 0) {
                        const user = u[0];
                        const claimedThisWeek = user.last_invite_claim_week === weekKey;

                        if (weeklyInvites >= 3 && !claimedThisWeek) {
                            rewardAmount = 5;
                            await db.query(`UPDATE users SET credits = credits + ?, last_invite_claim_week = ? WHERE tg_id = ?`, [rewardAmount, weekKey, currentUser]);
                            success = true;
                            msg = 'Weekly task completed! +5 Credits claimed.';
                        } else if (claimedThisWeek) {
                            msg = 'You have already claimed this weekly reward. Keep inviting to top the leaderboard!';
                        } else {
                            msg = `Not enough invites yet. Progress: ${weeklyInvites}/3`;
                        }
                    }
                }

                if (success) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    await redis.hset('user_credits', currentUser, currentCredits + rewardAmount);
                    
                    socket.emit('reward_success', msg);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    socket.emit('create_error', msg);
                }
            } catch (err) {}
        });

        socket.on('create_room', async ({ is_private, password, max_members, expire_hours, auto_join }) => {
            try {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;

                const activeRooms = await redis.smembers('active_rooms');
                if (activeRooms.length >= 1250) {
                    return socket.emit('create_error', 'Maximum room limit (1250) reached. Cannot create more rooms at this time.');
                }

                const limit = [2, 3, 4].includes(max_members) ? max_members : 4;
                let cost = 0; 
                let expDate = null;
                
                if (is_private) {
                    let hasRoom = false;
                    for(const id of activeRooms) {
                        const r = await getRoom(id);
                        if(r && r.creator_id === currentUser) { hasRoom = true; break; }
                    }

                    if (hasRoom) return socket.emit('create_error', 'You can only have 1 private room active at a time.');
                    if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be exactly 6 to 10 characters.');
                    
                    const limitCost = limit === 2 ? 1 : (limit === 3 ? 3 : 4);
                    const durationCost = expire_hours === 2 ? 1 : (expire_hours === 4 ? 2 : 1);
                    
                    cost += limitCost + durationCost; 
                    const hours = [2, 4].includes(expire_hours) ? expire_hours : 2;
                    expDate = new Date(Date.now() + hours * 3600000);
                }

                if (cost > 0) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < cost) return socket.emit('create_error', `Not enough credits. Costs ${cost} credits.`);
                    
                    await redis.hset('user_credits', currentUser, currentCredits - cost);
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                }

                const newRoomId = await redis.incr('next_room_id');
                await saveRoom({
                    id: newRoomId, status: 'WAITING', current_drawer_id: null, word_to_draw: null,
                    round_end_time: null, break_end_time: null, last_winner_id: null, end_reason: null, turn_index: 0,
                    modified_at: new Date(), is_private: is_private ? 1 : 0, password: is_private ? password : null,
                    max_members: limit, base_hints: '[]', creator_id: is_private ? currentUser : null, expire_at: expDate,
                    undo_steps: 0, redo_steps: 0,
                    members: []
                });

                if (auto_join) {
                    await performJoinRoom(currentUser, newRoomId, password, true);
                } else {
                    socket.emit('room_created', { room_id: newRoomId });
                }
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await broadcastRooms();
            } catch (err) { console.error('Create room error:', err); }
        });

        socket.on('search_room', async ({ room_id }) => {
            const room = await getRoom(Number(room_id));
            if (!room) return socket.emit('join_error', 'Room not found.');
            socket.emit('search_result', { id: room.id, is_private: room.is_private });
        });

        socket.on('join_room', async ({ room_id, password }) => {
            try {
                if (!socket.data.currentUser) return;
                await performJoinRoom(socket.data.currentUser, Number(room_id), password, false);
            } catch (err) {}
        });

        socket.on('leave_room', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room) {
                if (room.current_drawer_id === currentUser && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                    room.status = 'BREAK';
                    room.end_reason = 'drawer_disconnected';
                    room.break_end_time = new Date(Date.now() + 5000); 
                    room.word_to_draw = null;
                    room.round_end_time = null;
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: 'Drawer left the game.', created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                }

                room.members = room.members.filter(m => m.user_id !== currentUser);
                await saveRoom(room);
                await checkRoomReset(currentRoom);
            }
            socket.leave(`room_${currentRoom}`);
            socket.join('lobby'); 
            await syncRoom(currentRoom);
            socket.data.currentRoom = null;
            await broadcastRooms();
        });

        socket.on('delete_room', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.creator_id !== currentUser) return;

            io.to(`room_${currentRoom}`).emit('room_expired'); 
            
            await deleteRoomData(currentRoom);
            
            const sockets = await io.in(`room_${currentRoom}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                s.join('lobby'); 
                s.data.currentRoom = null;
            });
            
            await broadcastRooms();
        });

        socket.on('extend_room', async ({ expire_hours }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                const hours = [2, 4].includes(expire_hours) ? expire_hours : 2;
                let cost = hours === 4 ? 2 : 1;
                
                const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                if (currentCredits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');
                
                const room = await getRoom(currentRoom);
                if (!room || !room.is_private || room.creator_id !== currentUser) return;

                await redis.hset('user_credits', currentUser, currentCredits - cost);
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                
                room.expire_at = new Date(room.expire_at.getTime() + hours * 3600000);
                await saveRoom(room);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await syncRoom(currentRoom);
            } catch(err) { console.error('Extend room error:', err); }
        });

        socket.on('change_password', async ({ password }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be 6-10 characters.');
            
            const room = await getRoom(currentRoom);
            if (!room || !room.is_private || room.creator_id !== currentUser) return socket.emit('create_error', 'Unauthorized.');

            room.password = password;
            await saveRoom(room);
            socket.emit('reward_success', `Room password updated successfully! New password: ${password}`);
            await broadcastRooms();
            await syncRoom(currentRoom);
        });

        socket.on('kick_player', async ({ target_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || !room.is_private || room.creator_id !== currentUser) return;

            room.members = room.members.filter(m => m.user_id !== target_id);
            await saveRoom(room);
            
            io.to(`user_${target_id}`).emit('kicked_by_admin');
            const sockets = await io.in(`user_${target_id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                s.join('lobby'); 
                if (s.data.currentRoom === currentRoom) s.data.currentRoom = null;
            });

            await syncRoom(currentRoom);
            await broadcastRooms();
        });

        socket.on('chat', async ({ message }) => {
            if (!message || typeof message !== 'string') return;
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const msgStr = message.trim();
            if (!msgStr) return;
            if (msgStr.length > 200) return socket.emit('create_error', 'Message exceeds 200 character limit.');
            if (!checkRateLimit()) return socket.emit('create_error', 'Rate limit active: Please wait 1 second between messages.');

            // Check if muted
            const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [currentUser]);
            if (rows.length > 0) {
                const user = rows[0];
                if (user.status === 'mute' && user.mute_until_str) {
                    const todayStr = new Date().toISOString().split('T')[0];
                    if (user.mute_until_str >= todayStr) {
                        return socket.emit('create_error', `You are muted until ${user.mute_until_str}. Open the bot and use /start unmute to lift this restriction.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [currentUser]);
                    }
                }
            }

            const cId = await redis.incr('global_chat_id');
            const newChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: msgStr, created_at: new Date() };
            
            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(newChat));
            await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);

            io.to(`room_${currentRoom}`).emit('new_chat', newChat);
        });

        socket.on('give_up', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || !['DRAWING', 'PRE_DRAW'].includes(room.status)) return;

            const isDrawer = room.current_drawer_id === currentUser;

            if (isDrawer) {
                if (room.status === 'PRE_DRAW') {
                    room.status = 'BREAK';
                    room.end_reason = 'drawer_skipped';
                } else {
                    room.status = 'REVEAL'; 
                    room.end_reason = 'drawer_gave_up';
                }
                room.break_end_time = new Date(Date.now() + 5000); 
                room.round_end_time = null;
                
                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: 'The drawer gave up their turn.', created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                await saveRoom(room);
            } else {
                if (room.status !== 'DRAWING') return; 
                const member = room.members.find(m => m.user_id === currentUser);
                if (member) member.has_given_up = 1;
                
                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} voted to give up.`, created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);

                const guessers = room.members.filter(m => m.user_id !== room.current_drawer_id);
                const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

                if (allGivenUp) {
                    room.status = 'REVEAL';
                    room.end_reason = 'all_gave_up';
                    room.break_end_time = new Date(Date.now() + 5000);
                    room.round_end_time = null;
                    room.last_winner_id = null;
                    
                    const cId2 = await redis.incr('global_chat_id');
                    const sysChat2 = { id: cId2, room_id: currentRoom, user_id: 'System', message: 'All guessers gave up.', created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat2));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                }
                await saveRoom(room);
            }
            await syncRoom(currentRoom);
        });

        socket.on('guess', async ({ guess }) => {
            try {
                if (!guess || typeof guess !== 'string') return;
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return socket.emit('create_error', 'Not logged in or in room.');
                
                const guessStr = guess.trim().toUpperCase();
                if (!guessStr) return;
                if (!checkRateLimit()) return socket.emit('create_error', 'Rate limit active: Please wait 1 second between guesses.');
                
                const room = await getRoom(currentRoom);
                if (!room) return;
                if (room.status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
                if (room.current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');

                if (guessStr.length !== room.word_to_draw.length) {
                    return socket.emit('create_error', `Guess must be exactly ${room.word_to_draw.length} characters long.`);
                }
                
                const rawGuesses = await redis.lrange(`room:${currentRoom}:guesses`, 0, -1);
                const myGuessCount = rawGuesses.map(g => JSON.parse(g)).filter(g => g.user_id === currentUser).length;
                
                if (myGuessCount >= 6) {
                    return socket.emit('create_error', 'No more guesses allowed this round.');
                }

                if (myGuessCount === 4) {
                    const lockKey = `guess_payment_lock:${currentUser}`;
                    const locked = await redis.set(lockKey, "1", "EX", 10, "NX");
                    if (!locked) return; 

                    try {
                        const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                        if (currentCredits < 1) {
                            await redis.del(lockKey);
                            return socket.emit('create_error', 'Not enough credits to unlock extra guesses! (Cost: 1 Credit)');
                        }
                        
                        await redis.hset('user_credits', currentUser, currentCredits - 1);
                        await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                        
                        const userState = await getUserState(currentUser);
                        if (userState) socket.emit('user_update', userState);
                    } catch (e) {
                        await redis.del(lockKey);
                        return console.error('Guess Payment Error:', e);
                    }
                    await redis.del(lockKey);
                }

                const isCorrect = room.word_to_draw && room.word_to_draw.toUpperCase() === guessStr;
                const gId = await redis.incr('global_guess_id');
                const newGuess = { id: gId, room_id: currentRoom, user_id: currentUser, guess_text: guessStr, is_correct: isCorrect ? 1 : 0, created_at: new Date() };
                
                await redis.rpush(`room:${currentRoom}:guesses`, JSON.stringify(newGuess));
                io.to(`room_${currentRoom}`).emit('new_guess', newGuess);

                if (isCorrect) {
                    // Log the weekly guess point in DB correctly for the tiebreaker
                    const weekKey = getWeekKey();
                    await db.query(`
                        INSERT INTO user_weekly_stats (tg_id, week_key, guesses, guesses_updated_at)
                        VALUES (?, ?, 1, UTC_TIMESTAMP())
                        ON DUPLICATE KEY UPDATE guesses = guesses + 1, guesses_updated_at = UTC_TIMESTAMP()
                    `, [currentUser, weekKey]);

                    room.status = 'REVEAL';
                    room.end_reason = 'guessed';
                    room.break_end_time = new Date(Date.now() + 5000); 
                    room.round_end_time = null;
                    room.last_winner_id = currentUser;
                    await saveRoom(room);
                    await syncRoom(currentRoom); 
                }

            } catch (err) { console.error('Guess Error:', err); }
        });

        socket.on('buy_hint', async ({ index }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                const room = await getRoom(currentRoom);
                if (!room) return;
                const member = room.members.find(m => m.user_id === currentUser);
                if (!member) return;

                let purchased = JSON.parse(member.purchased_hints || '[]');
                if (purchased.length >= 1) return socket.emit('create_error', 'You can only reveal 1 hint per round.');

                if (!purchased.includes(index)) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < 1) return socket.emit('create_error', 'Not enough credits to buy a hint.');

                    await redis.hset('user_credits', currentUser, currentCredits - 1);
                    await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                    
                    purchased.push(index);
                    member.purchased_hints = JSON.stringify(purchased);
                    await saveRoom(room);
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} used a hint for 1 Credit!`, created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                    
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                    
                    await syncRoom(currentRoom);
                }
            } catch (err) { console.error('Buy Hint Error:', err); }
        });

        socket.on('buy_hint_ad', async ({ index }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                const room = await getRoom(currentRoom);
                if (!room) return;
                const member = room.members.find(m => m.user_id === currentUser);
                if (!member) return;

                let purchased = JSON.parse(member.purchased_hints || '[]');
                if (purchased.length >= 1) return socket.emit('create_error', 'You can only reveal 1 hint per round.');

                if (!purchased.includes(index)) {
                    purchased.push(index);
                    member.purchased_hints = JSON.stringify(purchased);
                    await saveRoom(room);
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} used a hint by watching an ad!`, created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                    
                    await syncRoom(currentRoom);
                }
            } catch (err) { console.error('Buy Hint Ad Error:', err); }
        });

        socket.on('set_word', async ({ word }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.current_drawer_id !== currentUser) return;

            const wordClean = word.trim().toUpperCase();
            if (wordClean.length < 3 || wordClean.length > 10) return socket.emit('create_error', 'Word must be between 3 and 10 characters.');

            let hints = [];
            let validIndices = [];
            for (let i = 0; i < wordClean.length; i++) {
                if (wordClean[i] !== ' ') validIndices.push(i);
            }
            const len = wordClean.length;
            
            if (len >= 3 && len <= 4) {
                hints.push(Math.floor(len / 2));
            } else {
                let count = 0;
                if (len >= 5 && len <= 6) count = 2;
                else if (len >= 7 && len <= 9) count = 3;
                else if (len === 10) count = 4;
                
                while (hints.length < count && validIndices.length > 0) {
                    let randIdx = Math.floor(Math.random() * validIndices.length);
                    hints.push(validIndices[randIdx]);
                    validIndices.splice(randIdx, 1); 
                }
            }

            room.word_to_draw = wordClean;
            room.base_hints = JSON.stringify(hints);
            room.status = 'DRAWING';
            room.end_reason = null; 
            room.round_end_time = null; 
            
            room.undo_steps = 0;
            room.redo_steps = 0;

            room.members.forEach(m => {
                m.purchased_hints = '[]';
                m.has_given_up = 0;
                m.ink_used = {}; 
                m.ink_extra = {}; 
            });
            
            await saveRoom(room);
            await releaseRoomMemory(currentRoom); 
            await redis.del(`room:${currentRoom}:redo`);
            io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []); 
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            await syncRoom(currentRoom);
        });

        socket.on('set_ready', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room) return;
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                member.is_ready = 1;

                if (room.members.length >= 2 && room.members.every(m => m.is_ready)) {
                    const sortedMembers = [...room.members].sort((a, b) => a.joined_at - b.joined_at);

                    let idx = room.turn_index || 0;
                    if (idx >= sortedMembers.length) idx = 0;
                    const nextDrawer = sortedMembers[idx].user_id;

                    room.status = 'PRE_DRAW';
                    room.current_drawer_id = nextDrawer;
                    room.word_to_draw = null;
                    room.break_end_time = null;
                    room.end_reason = null; 
                    room.round_end_time = new Date(Date.now() + 30000); 
                    room.members.forEach(m => m.is_ready = 0);
                    room.turn_index = idx + 1; 

                    await releaseRoomMemory(currentRoom); 
                    await redis.del(`room:${currentRoom}:guesses`); 
                    io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []); 
                }

                await saveRoom(room);
                await syncRoom(currentRoom);
            }
        });

        socket.on('draw', ({ lines }) => queuedAction(async () => {
            if (!Array.isArray(lines) || lines.length > 2000) {
                return socket.emit('create_error', 'Drawing payload rejected: invalid or exceeded maximum points limit.');
            }

            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.status !== 'DRAWING') return;

            const member = room.members.find(m => m.user_id === currentUser);
            const activeColor = 'black'; 
            
            let strokeLength = 0;
            if (lines && lines.length > 0) {
                for (let i = 0; i < lines.length; i += 4) {
                    const x0 = lines[i], y0 = lines[i+1], x1 = lines[i+2], y1 = lines[i+3];
                    strokeLength += Math.sqrt(Math.pow(x1 - x0, 2) + Math.pow(y1 - y0, 2));
                }
            }

            if (member) {
                if (!member.ink_used) member.ink_used = {};
                member.ink_used[activeColor] = (member.ink_used[activeColor] || 0) + strokeLength;
                room.undo_steps = Math.min((room.undo_steps || 0) + 1, 3);
                room.redo_steps = 0;
                await saveRoom(room);
            }

            await redis.del(`room:${currentRoom}:redo`); 
            
            const dId = await redis.incr('global_drawing_id');
            const drawing = { id: dId, lines, ink_cost: strokeLength, color: activeColor, user_id: currentUser };
            await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawing));
            
            socket.to(`room_${currentRoom}`).emit('live_draw', { lines, color: activeColor });
            
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
        }));

        socket.on('undo', () => queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || (room.undo_steps || 0) <= 0 || room.current_drawer_id !== currentUser) return;
            
            const lastRaw = await redis.rpop(`room:${currentRoom}:drawings`);
            if (lastRaw) {
                await redis.rpush(`room:${currentRoom}:redo`, lastRaw);
                await redis.ltrim(`room:${currentRoom}:redo`, -3, -1);
                
                const toRestore = JSON.parse(lastRaw);
                
                room.undo_steps = (room.undo_steps || 0) - 1;
                room.redo_steps = Math.min((room.redo_steps || 0) + 1, 3);

                const member = room.members.find(m => m.user_id === toRestore.user_id);
                if (member && toRestore.ink_cost) {
                    if (!member.ink_used) member.ink_used = {};
                    member.ink_used[toRestore.color] = Math.max(0, (member.ink_used[toRestore.color] || 0) - toRestore.ink_cost);
                }
                await saveRoom(room);
                
                const allRaw = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const allDrawings = allRaw.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', allDrawings.map(d => ({ lines: d.lines, color: d.color })));
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                
                if (member) {
                    io.to(`user_${toRestore.user_id}`).emit('update_ink', { color: toRestore.color, used: member.ink_used[toRestore.color] || 0 });
                }
            }
        }));

        socket.on('redo', () => queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || (room.redo_steps || 0) <= 0 || room.current_drawer_id !== currentUser) return;

            const toRestoreRaw = await redis.rpop(`room:${currentRoom}:redo`);
            if (toRestoreRaw) {
                await redis.rpush(`room:${currentRoom}:drawings`, toRestoreRaw);
                const toRestore = JSON.parse(toRestoreRaw);
                
                room.redo_steps = (room.redo_steps || 0) - 1;
                room.undo_steps = Math.min((room.undo_steps || 0) + 1, 3);
                
                const member = room.members.find(m => m.user_id === toRestore.user_id);
                if (member && toRestore.ink_cost) {
                    if (!member.ink_used) member.ink_used = {};
                    member.ink_used[toRestore.color] = (member.ink_used[toRestore.color] || 0) + toRestore.ink_cost;
                }
                await saveRoom(room);
                
                const allRaw = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const allDrawings = allRaw.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', allDrawings.map(d => ({ lines: d.lines, color: d.color })));
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                
                if (member) {
                    io.to(`user_${toRestore.user_id}`).emit('update_ink', { color: toRestore.color, used: member.ink_used[toRestore.color] || 0 });
                }
            }
        }));

        socket.on('clear_all', () => queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.status !== 'DRAWING' || room.current_drawer_id !== currentUser) return;

            await redis.del(`room:${currentRoom}:drawings`, `room:${currentRoom}:redo`);
            room.undo_steps = 0;
            room.redo_steps = 0;
            
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                if (member.ink_used) member.ink_used['black'] = 0;
            }
            await saveRoom(room);
            
            io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []);
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            io.to(`user_${currentUser}`).emit('update_ink', { color: 'black', used: 0 });
        }));

        socket.on('buy_ink', async () => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                const room = await getRoom(currentRoom);
                if (!room || room.status !== 'DRAWING') return;
                
                const targetColor = 'black'; 
                const cost = INK_CONFIG[targetColor].cost;
                const extraInkAmount = INK_CONFIG[targetColor].extra; 

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    if (!member.ink_extra) member.ink_extra = {};
                    
                    const currentExtra = member.ink_extra[targetColor] || 0;
                    
                    if (currentExtra >= 2500) {
                        return socket.emit('create_error', 'Maximum ink refill limit reached for this round.');
                    }

                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < cost) {
                        return socket.emit('create_error', `Not enough credits to buy ink.`);
                    }

                    await redis.hset('user_credits', currentUser, currentCredits - cost);
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);

                    member.ink_extra[targetColor] = Math.min(currentExtra + extraInkAmount, 2500); 
                    await saveRoom(room);

                    socket.emit('reward_success', `+${extraInkAmount} Ink added!`);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                    
                    await syncRoom(currentRoom); 
                }
            } catch (err) { console.error('Buy Ink Error:', err); }
        });

        socket.on('disconnect', async () => {
            const currentUser = socket.data.currentUser;
            if (currentUser) {
                const activeSockets = await io.in(`user_${currentUser}`).fetchSockets();
                if (activeSockets.length === 0) {
                    await redis.hset('user_disconnects', currentUser, Date.now());
                }
            }
        });
    });

    // ---------------------------------------------------------
    // GAME ENGINE LOOP & WEEKLY REWARDS
    // ---------------------------------------------------------
    let isGameLoopRunning = false;
    setInterval(async () => {
        const lock = await redis.set('game_loop_lock', '1', 'EX', 9, 'NX');
        if (!lock) return; 

        if (isGameLoopRunning) return;
        isGameLoopRunning = true;

        try {
            const now = Date.now();

            // Check for weekly invite reward payout & data deletion
            const currentWeekKey = getWeekKey();
            const storedWeekKey = await redis.get('current_week_key');
            if (storedWeekKey && storedWeekKey !== currentWeekKey) {
                const [top5Inviters] = await db.query(`
                    SELECT tg_id, invites FROM user_weekly_stats 
                    WHERE week_key = ? AND invites > 0 
                    ORDER BY invites DESC, invites_updated_at ASC LIMIT 5
                `, [storedWeekKey]);
                
                const [top5Guessers] = await db.query(`
                    SELECT tg_id, guesses FROM user_weekly_stats 
                    WHERE week_key = ? AND guesses > 0 
                    ORDER BY guesses DESC, guesses_updated_at ASC LIMIT 5
                `, [storedWeekKey]);
                
                // Cache previous week's winners for leaderboard UI display
                await redis.set('previous_week_top_inviters', JSON.stringify(top5Inviters), 'EX', 7 * 86400); // Expiry 1 week
                await redis.set('previous_week_top_guessers', JSON.stringify(top5Guessers), 'EX', 7 * 86400);

                // Auto-delete the expired week's data from the database
                await db.query(`DELETE FROM user_weekly_stats WHERE week_key != ?`, [currentWeekKey]);

                for (const u of top5Inviters) {
                    const uId = u.tg_id;
                    const invites = u.invites;
                    if (invites > 0) {
                        sendMsg(uId, `🏆 The weekly invite challenge ended!\nYou ranked in the top 5 with ${invites} invites.\n\nClaim your reward of ${invites} credits!`, {
                            inline_keyboard: [[{ text: `🎁 Claim ${invites} Credits`, callback_data: `claim_weekly_${storedWeekKey}_${invites}` }]]
                        });
                    }
                }
                await redis.set('current_week_key', currentWeekKey);
            } else if (!storedWeekKey) {
                await redis.set('current_week_key', currentWeekKey);
            }

            const disconnects = await redis.hgetall('user_disconnects');
            for (const [userId, disconnectTimeStr] of Object.entries(disconnects)) {
                if (now - parseInt(disconnectTimeStr) >= 30000) {
                    
                    const activeRooms = await redis.smembers('active_rooms');
                    for (const roomId of activeRooms) {
                        const room = await getRoom(roomId);
                        if (room && room.members.some(m => String(m.user_id) === userId)) {
                            if (room.current_drawer_id === userId && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                                
                                const cId = await redis.incr('global_chat_id');
                                const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer disconnected.', created_at: new Date() };
                                await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                                await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                            }
                            room.members = room.members.filter(m => m.user_id !== userId);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            await syncRoom(roomId);
                        }
                    }
                    await redis.hdel('user_disconnects', userId);
                    await broadcastRooms();
                }
            }
            
            const activeRooms = await redis.smembers('active_rooms');
            let roomsChanged = false;

            for (const roomId of activeRooms) {
                const room = await getRoom(roomId);
                if (!room) continue;

                let needsSync = false;

                if (room.status === 'PRE_DRAW' && room.round_end_time && now >= room.round_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.end_reason = 'timeout_predraw';
                    room.break_end_time = new Date(now + 5000); 
                    room.word_to_draw = null;
                    room.round_end_time = null;
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer failed to choose a word in time. Turn skipped.', created_at: new Date() };
                    await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                    needsSync = true;
                }

                if (room.status === 'REVEAL' && room.break_end_time && now >= room.break_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.break_end_time = new Date(now + 10000); 
                    room.members.forEach(m => m.has_given_up = 0);
                    needsSync = true;
                }

                if (room.is_private && room.expire_at && now >= room.expire_at.getTime()) {
                    io.to(`room_${roomId}`).emit('room_expired');
                    await deleteRoomData(roomId);
                    
                    const roomSockets = await io.in(`room_${roomId}`).fetchSockets();
                    for (const s of roomSockets) {
                        s.leave(`room_${roomId}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    }
                    roomsChanged = true;
                    continue; 
                }

                if (needsSync) {
                    await saveRoom(room);
                    await syncRoom(roomId);
                }
            }

            if (roomsChanged) {
                await broadcastRooms();
            }
            
            const sockets = await io.fetchSockets();
            let idleChangedRooms = new Set();

            for (const s of sockets) {
                const idleTime = now - (s.data.lastActiveEvent || now);
                
                if (s.data.currentRoom) {
                    if (idleTime > 60000) {
                        s.emit('kick_idle');
                        const roomId = s.data.currentRoom;
                        const room = await getRoom(roomId);

                        if (room) {
                            if (room.current_drawer_id === s.data.currentUser && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                            }

                            room.members = room.members.filter(m => m.user_id !== s.data.currentUser);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            idleChangedRooms.add(roomId);
                        }
                        s.leave(`room_${roomId}`);
                        s.join('lobby'); 
                        s.data.currentRoom = null;
                        s.data.idleWarned = false;
                    } else if (idleTime > 30000 && !s.data.idleWarned) {
                        s.data.idleWarned = true;
                        s.emit('idle_warning', { timeLeft: Math.ceil((60000 - idleTime) / 1000) });
                    } else if (idleTime <= 30000) {
                        s.data.idleWarned = false;
                    }
                } else {
                    if (idleTime > 60000) {
                        s.emit('disconnect_idle');
                        s.disconnect(true);
                    }
                }
            }

            for (const roomId of idleChangedRooms) {
                await syncRoom(roomId);
            }
            if (idleChangedRooms.size > 0) {
                await broadcastRooms();
            }

        } catch (e) { 
            console.error(`[Worker ${process.pid}] Game Loop Error:`, e); 
        } finally {
            isGameLoopRunning = false;
        }
    }, 10000); 

    const initWorkerDB = async () => {
        try {
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
            
            for (let q of migrations) {
                try { await db.query(q); } catch(e) { /* Ignore existing columns / drops */ }
            }
            console.log(`[Worker ${process.pid}] DB Initialization verified.`);
        } catch(e) {
            console.error(`[Worker ${process.pid}] DB Init Error:`, e);
        }
    };

    initWorkerDB().then(() => {
        server.listen(PORT, () => console.log(`[Worker ${process.pid}] Server running on port ${PORT}`));
    });
}
