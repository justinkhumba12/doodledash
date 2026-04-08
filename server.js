const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = express();
const server = http.createServer(app);

// Use Redis to support massive scaling across Node.js replicas
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate(); // Generic client for caching state

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let isRedisReady = false;
Promise.all([pubClient.connect(), subClient.connect(), redisClient.connect()]).then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    isRedisReady = true;
    console.log('Redis connected and Socket.IO Adapter attached.');
}).catch(e => console.error('Redis connection failed, falling back to in-memory state:', e.message));

// Fallback in-memory stores for when Redis is unavailable
const memCalls = new Map();
const memRedo = new Map();

const getActiveCalls = async () => {
    if (isRedisReady) return await redisClient.hGetAll('activeCalls');
    return Object.fromEntries(memCalls);
};
const setCall = async (id, val) => {
    if (isRedisReady) await redisClient.hSet('activeCalls', id, val);
    else memCalls.set(id, val);
};
const getCall = async (id) => {
    if (isRedisReady) return await redisClient.hGet('activeCalls', id);
    return memCalls.get(id);
};
const delCall = async (id) => {
    if (isRedisReady) await redisClient.hDel('activeCalls', id);
    else memCalls.delete(id);
};
const clearRedo = async (roomId) => {
    if (isRedisReady) await redisClient.del(`redo:${roomId}`);
    else memRedo.delete(roomId);
};
const pushRedo = async (roomId, val) => {
    if (isRedisReady) await redisClient.rPush(`redo:${roomId}`, val);
    else {
        if(!memRedo.has(roomId)) memRedo.set(roomId, []);
        memRedo.get(roomId).push(val);
    }
};
const popRedo = async (roomId) => {
    if (isRedisReady) return await redisClient.rPop(`redo:${roomId}`);
    else {
        const arr = memRedo.get(roomId);
        if (arr && arr.length > 0) return arr.pop();
        return null;
    }
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Service Worker for Caching
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
        const CACHE_NAME = 'doodledash-cache-v2';
        const urlsToCache = [
            '/',
            '/audio/mgs_notification.mp3',
            '/audio/guess_notification.mp3',
            '/audio/call.mp3',
            '/thememusic/themesongdefault.mp3',
            '/thememusic/Pencils%20Down.mp3',
            '/thememusic/Pencils%20Down%202.mp3',
            '/thememusic/Quick%20Draw%20Frenzy.mp3',
            'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
            'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
            'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap'
        ];
        self.addEventListener('install', event => {
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
        });
        self.addEventListener('fetch', event => {
            event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
        });
    `);
});

const toHex = (id) => id ? "0x" + Number(id).toString(16).toUpperCase().slice(-6) : '';

// Database Connection Pooling for Scalability
let pool;
async function initDB() {
    const dbUrl = process.env.MYSQL_URL || 'mysql://root:dKIKDNsnObjDvJlZawBHjzaEsoetaATX@mysql.railway.internal:3306/railway';
    try {
        pool = mysql.createPool({ 
            uri: dbUrl, 
            timezone: 'Z',
            connectionLimit: 100, // Handle high concurrency seamlessly
            queueLimit: 0,
            waitForConnections: true
        });
        console.log('Connected to MySQL Database via Pool.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                tg_id VARCHAR(50) PRIMARY KEY,
                credits INT DEFAULT 0,
                last_daily_claim DATE,
                ad_claims_today INT DEFAULT 0,
                last_ad_claim_time DATETIME,
                ad2_claims_today INT DEFAULT 0,
                last_ad2_claim_time DATETIME,
                profile_pic VARCHAR(255),
                last_active DATETIME,
                tg_username VARCHAR(100)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status VARCHAR(20) DEFAULT 'WAITING',
                current_drawer_id VARCHAR(50),
                word_to_draw VARCHAR(50),
                round_end_time DATETIME,
                break_end_time DATETIME,
                last_winner_id VARCHAR(50),
                next_drawer_id VARCHAR(50),
                modified_at DATETIME,
                is_private BOOLEAN DEFAULT FALSE,
                password VARCHAR(255),
                max_members INT DEFAULT 4,
                base_hints VARCHAR(255) DEFAULT '[]',
                creator_id VARCHAR(50),
                expire_at DATETIME
            )
        `);

        // Migration logic for modifying existing tables
        const migrations = [
            "ALTER TABLE rooms ADD COLUMN is_private BOOLEAN DEFAULT FALSE",
            "ALTER TABLE rooms ADD COLUMN password VARCHAR(255)",
            "ALTER TABLE rooms ADD COLUMN max_members INT DEFAULT 4",
            "ALTER TABLE rooms ADD COLUMN base_hints VARCHAR(255) DEFAULT '[]'",
            "ALTER TABLE rooms ADD COLUMN creator_id VARCHAR(50)",
            "ALTER TABLE rooms ADD COLUMN expire_at DATETIME",
            "ALTER TABLE guesses ADD COLUMN is_correct BOOLEAN DEFAULT FALSE",
            "ALTER TABLE room_members ADD COLUMN has_given_up BOOLEAN DEFAULT FALSE",
            "ALTER TABLE room_members ADD COLUMN purchased_hints VARCHAR(255) DEFAULT '[]'",
            "ALTER TABLE users ADD COLUMN tg_username VARCHAR(100)"
        ];
        
        for (let query of migrations) {
            try { await pool.query(query); } catch (e) { /* Ignore if column already exists */ }
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                room_id INT,
                user_id VARCHAR(50),
                is_ready BOOLEAN DEFAULT FALSE,
                consecutive_turns INT DEFAULT 0,
                total_turns INT DEFAULT 0,
                has_given_up BOOLEAN DEFAULT FALSE,
                purchased_hints VARCHAR(255) DEFAULT '[]',
                PRIMARY KEY(room_id, user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                line_data LONGTEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                guess_text VARCHAR(50),
                is_correct BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const [rooms] = await pool.query('SELECT COUNT(*) as count FROM rooms');
        if (rooms[0].count === 0) {
            for (let i = 0; i < 5; i++) {
                await pool.query(`INSERT INTO rooms (status, modified_at, is_private, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, 4)`);
            }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

app.post('/webhook', async (req, res) => {
    const update = req.body;
    res.sendStatus(200); // Acknowledge early

    const token = process.env.BOT_TOKEN; 
    const webAppUrl = process.env.WEBAPP_URL; 
    if (!token || !webAppUrl) return;

    const sendMsg = (chatId, text, replyMarkup) => {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
        }).catch(console.error);
    };

    if (update?.pre_checkout_query) {
        fetch(`https://api.telegram.org/bot${token}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        });
        return;
    }

    if (update?.message?.successful_payment) {
        try {
            const payload = JSON.parse(update.message.successful_payment.invoice_payload);
            const addedCredits = payload.amount;
            const buyerId = payload.tgId;
            
            await pool.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [addedCredits, buyerId]);
            sendMsg(update.message.chat.id, `✅ Successfully purchased ${addedCredits} Credits! Your balance has been updated.`);
            
            const userState = await getUserState(buyerId);
            if (userState) io.to(`user_${buyerId}`).emit('user_update', userState);
        } catch(e) { console.error('Payment processing error:', e); }
        return;
    }

    if (update?.message?.text && update.message.text.startsWith('/start')) {
        const chatId = update.message.chat.id;
        const tgId = update.message.from.id;
        const username = update.message.from.username;
        
        try {
            await pool.query('INSERT IGNORE INTO users (tg_id, credits, last_active, tg_username) VALUES (?, 5, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE tg_username = ?', [tgId.toString(), username || null, username || null]);
        } catch (e) {
            console.error('Webhook DB Error:', e);
        }

        if (update.message.text === '/start load_balance') {
            sendMsg(chatId, "💎 Select a package to top up your credits:\n\n*Rate: 1000 Credits = 500 Telegram Stars*", {
                inline_keyboard: [
                    [{ text: '50 Credits (25 ⭐️)', callback_data: 'buy_50' }],
                    [{ text: '100 Credits (50 ⭐️)', callback_data: 'buy_100' }],
                    [{ text: '200 Credits (100 ⭐️)', callback_data: 'buy_200' }],
                    [{ text: '500 Credits (250 ⭐️)', callback_data: 'buy_500' }],
                    [{ text: '1000 Credits (500 ⭐️)', callback_data: 'buy_1000' }]
                ]
            });
            return;
        }

        if (!username) {
            sendMsg(chatId, "⚠️ You need a Telegram username to play and receive credits!\n\nPlease set a username in your Telegram profile Settings, then click 'Check' below.", {
                inline_keyboard: [[{ text: '🔄 Check', callback_data: 'check_username' }]]
            });
        } else {
            const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
            sendMsg(chatId, 'Welcome to DoodleDash! Click below to play.', {
                inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
            });
        }
    } else if (update?.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const tgId = query.from.id;
        const username = query.from.username;
        const messageId = query.message.message_id;

        if (query.data.startsWith('buy_')) {
            const amount = parseInt(query.data.split('_')[1]);
            const stars = amount / 2; // 1000 creds = 500 stars
            
            const payload = JSON.stringify({ tgId: tgId.toString(), amount: amount });
            const invoice = {
                chat_id: chatId,
                title: `${amount} DoodleDash Credits`,
                description: `Top up your account with ${amount} credits.`,
                payload: payload,
                provider_token: "", // Empty for Telegram Stars
                currency: "XTR",
                prices: [{ label: `${amount} Credits`, amount: stars }]
            };
            
            fetch(`https://api.telegram.org/bot${token}/sendInvoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invoice)
            }).catch(console.error);
            
            fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: query.id })
            });
        } else if (query.data === 'check_username') {
            if (!username) {
                fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: query.id, text: "Username not set yet! Please set it in Settings.", show_alert: true })
                });
            } else {
                try {
                    await pool.query('UPDATE users SET tg_username = ? WHERE tg_id = ?', [username, tgId.toString()]);
                } catch(e) {}
                
                const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
                fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: messageId,
                        text: "Awesome! Your username is verified.\n\nWelcome to DoodleDash! Click below to play.",
                        reply_markup: {
                            inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
                        }
                    })
                });
            }
        }
    }
});

async function getUserState(tg_id) {
    const [rows] = await pool.query(`
        SELECT *,
        (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as daily_available,
        (last_ad_claim_time IS NULL OR DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad_claims_today < 3 AND TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()) >= 180)) as ad1_available,
        (last_ad2_claim_time IS NULL OR DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad2_claims_today < 3 AND TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()) >= 180)) as ad2_available,
        GREATEST(0, 180 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()), 180)) as ad1_wait_mins,
        GREATEST(0, 180 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()), 180)) as ad2_wait_mins,
        (DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad1_is_today,
        (DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad2_is_today
        FROM users WHERE tg_id = ?
    `, [tg_id]);

    if (rows.length === 0) return null;
    let u = rows[0];
    if (!u.ad1_is_today) u.ad_claims_today = 0;
    if (!u.ad2_is_today) u.ad2_claims_today = 0;
    return u;
}

const broadcastRooms = async () => {
    // Send both Private and Public Rooms
    const [rooms] = await pool.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
    
    // Iterating sockets globally works effectively via adapter
    const sockets = await io.fetchSockets();
    sockets.forEach(s => {
        const userId = s.currentUser;
        const customizedRooms = rooms.map(r => {
            if (r.creator_id === userId) {
                return r; // Send password if they created it
            } else {
                const { password, ...safeRoom } = r;
                return safeRoom;
            }
        });
        s.emit('lobby_rooms_update', customizedRooms);
    });
};

const deleteRoom = async (roomId) => {
    if (!roomId) return;
    try {
        await pool.query("DELETE FROM rooms WHERE id = ?", [roomId]);
        await pool.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
        await clearRedo(roomId);
    } catch (e) {
        console.error("Error completely deleting room:", roomId, e);
    }
};

// Auto Room Resetter and Deleter
const checkRoomReset = async (roomId) => {
    if (!roomId) return;
    try {
        const [members] = await pool.query('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', [roomId]);
        if (members[0].c === 0) {
            const [roomInfo] = await pool.query('SELECT is_private FROM rooms WHERE id = ?', [roomId]);
            const isPrivate = roomInfo.length > 0 && roomInfo[0].is_private;

            // Delete room completely if empty unless it's the fallback base rooms (1 or 2) OR it's a private room (let expire_at handle it)
            if (roomId !== 1 && roomId !== 2 && !isPrivate) {
                await deleteRoom(roomId);
            } else {
                await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
                await pool.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
                await clearRedo(roomId);
            }
        } else if (members[0].c < 2) {
            await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
            await pool.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [roomId]);
        }
    } catch(err) {
        console.error("Auto delete room error:", err);
    }
};

const syncRoom = async (roomId) => {
    if (!roomId) return;
    try {
        const [roomData] = await pool.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        if (roomData.length === 0) return; 

        const [members] = await pool.query('SELECT * FROM room_members WHERE room_id = ?', [roomId]);
        const [chats] = await pool.query('SELECT * FROM chats WHERE room_id = ? ORDER BY id ASC', [roomId]); 
        const [guesses] = await pool.query('SELECT * FROM guesses WHERE room_id = ? ORDER BY id ASC', [roomId]);
        const [drawings] = await pool.query('SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC', [roomId]);
        
        const userIds = [...new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)])];
        let profiles = {};
        if (userIds.length > 0) {
            const [users] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (?)`, [userIds]);
            users.forEach(u => profiles[u.tg_id] = u.profile_pic);
        }

        const allCallsMap = await getActiveCalls();
        const activeCallsList = Object.values(allCallsMap)
            .map(c => JSON.parse(c))
            .filter(c => c.room_id === roomId)
            .map(c => ({
                id: c.id, caller: c.caller, receiver: c.receiver, status: c.status, room_id: c.room_id
            }));

        const socketsInRoom = await io.in(`room_${roomId}`).fetchSockets();
        
        for (const s of socketsInRoom) {
            const userId = s.currentUser;
            const isDrawer = roomData[0].current_drawer_id === userId;
            
            const sanitizedGuesses = guesses.map(g => {
                if (isDrawer || g.user_id === userId || roomData[0].status === 'REVEAL' || roomData[0].status === 'BREAK') {
                    return g;
                }
                return { ...g, guess_text: '••••••••' };
            });

            let masked_word = null;
            if (['DRAWING', 'REVEAL', 'BREAK'].includes(roomData[0].status)) {
                const base_hints = JSON.parse(roomData[0].base_hints || '[]');
                const actual_word = roomData[0].word_to_draw || '';
                const memberData = members.find(m => m.user_id === userId);
                const purchased_hints = JSON.parse(memberData?.purchased_hints || '[]');
                const isReveal = roomData[0].status !== 'DRAWING';
                
                masked_word = actual_word.split('').map((char, index) => {
                    if (char === ' ') return { char: ' ', index, revealed: true };
                    if (isDrawer || isReveal || base_hints.includes(index) || purchased_hints.includes(index)) {
                        return { char, index, revealed: true };
                    }
                    return { char: null, index, revealed: false };
                });
            }

            s.emit('room_sync', {
                room: roomData[0],
                members,
                chats, 
                guesses: sanitizedGuesses,
                drawings: drawings.map(d => d.line_data),
                profiles,
                activeCalls: activeCallsList,
                masked_word: masked_word,
                server_time: new Date()
            });
        }
    } catch (error) {
        console.error("syncRoom error:", error);
    }
};

const terminateCallsForUser = async (userId) => {
    const allCallsMap = await getActiveCalls();
    for (const [callId, callStr] of Object.entries(allCallsMap)) {
        const call = JSON.parse(callStr);
        if (call.caller === userId || call.receiver === userId) {
            await delCall(callId);
            io.to(`room_${call.room_id}`).emit('call_ended', callId);
            syncRoom(call.room_id);
        }
    }
};

// Architectural Event-Driven Revisions
const checkRoomReadiness = async (roomId) => {
    try {
        const [room] = await pool.query("SELECT status FROM rooms WHERE id = ?", [roomId]);
        if (room.length === 0 || !['WAITING', 'BREAK'].includes(room[0].status)) return;

        const [members] = await pool.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [roomId]);
        if (members.length >= 2 && members.every(m => m.is_ready)) {
            const nextDrawer = members[Math.floor(Math.random() * members.length)].user_id;
            await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?", [nextDrawer, roomId]);
            await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [roomId]);
            
            // Clear drawings and guesses for the upcoming round automatically
            await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
            await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
            await clearRedo(roomId);
            syncRoom(roomId);
        }
    } catch(e) { console.error('Room Readiness Error:', e); }
};

const scheduleBreakTransition = (roomId) => {
    setTimeout(async () => {
        const [room] = await pool.query("SELECT status, break_end_time FROM rooms WHERE id = ?", [roomId]);
        if (room.length > 0 && room[0].status === 'REVEAL' && new Date(room[0].break_end_time) <= new Date()) {
            await pool.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 600 SECOND) WHERE id = ?", [roomId]);
            await pool.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [roomId]);
            syncRoom(roomId);
            checkRoomReadiness(roomId); // Check immediately if players got antsy
        }
    }, 5500); 
};

const scheduleRoomExpiration = (roomId, expireMs) => {
    setTimeout(async () => {
        const [r] = await pool.query("SELECT is_private, expire_at FROM rooms WHERE id = ?", [roomId]);
        if (r.length > 0 && r[0].is_private) {
            if (new Date(r[0].expire_at) <= new Date()) {
                io.to(`room_${roomId}`).emit('room_expired');
                await deleteRoom(roomId); 
                const sockets = await io.in(`room_${roomId}`).fetchSockets();
                sockets.forEach(s => { s.leave(`room_${roomId}`); s.currentRoom = null; });
                broadcastRooms();
            }
        }
    }, expireMs);
};

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;

    // Distributive Scaling: Track localized socket interactions with event-driven timeouts
    const startIdleTimer = () => {
        if (socket.idleTimeout) clearTimeout(socket.idleTimeout);
        if (socket.warnTimeout) clearTimeout(socket.warnTimeout);
        socket.idleWarned = false;

        socket.warnTimeout = setTimeout(() => {
            if (socket.currentRoom) {
                socket.idleWarned = true;
                socket.emit('idle_warning');
            }
        }, 50000); 

        socket.idleTimeout = setTimeout(async () => {
            if (socket.currentRoom) {
                socket.emit('kick_idle');
                await pool.query('DELETE FROM room_members WHERE user_id = ?', [socket.currentUser]);
                await checkRoomReset(socket.currentRoom);
                syncRoom(socket.currentRoom);
                broadcastRooms();
                socket.leave(`room_${socket.currentRoom}`);
                socket.currentRoom = null;
            }
        }, 60000); 
    };

    // Extracted robust helper logic for joining rooms gracefully behind the scenes
    const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
        const [roomData] = await pool.query('SELECT * FROM rooms WHERE id = ?', [roomIdNum]);
        if (roomData.length === 0) return socket.emit('join_error', 'Room not found.');
        const room = roomData[0];

        const [members] = await pool.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [roomIdNum]);
        if (members[0].count >= room.max_members) return socket.emit('join_error', 'Room is full.');

        const [existing] = await pool.query('SELECT room_id FROM room_members WHERE user_id = ?', [userId]);
        if (existing.length > 0 && existing[0].room_id === roomIdNum) {
            currentRoom = roomIdNum;
            socket.currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.emit('join_success', roomIdNum);
            return syncRoom(roomIdNum);
        }

        if (!bypassCost) {
            if (room.is_private) {
                if (room.password !== password) return socket.emit('join_error', 'Incorrect password.');
            } else if (roomIdNum !== 1 && roomIdNum !== 2) {
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [userId]);
                if (u[0].credits < 1) return socket.emit('join_error', 'Not enough credits. Public rooms cost 1 credit.');
                await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [userId]);
            }
        }

        const oldRoom = currentRoom;
        if (oldRoom) {
            await terminateCallsForUser(userId); 
            socket.leave(`room_${oldRoom}`);
            await pool.query('DELETE FROM room_members WHERE user_id = ?', [oldRoom]); 
            await checkRoomReset(oldRoom);
        }

        await pool.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [roomIdNum, userId]);
        currentRoom = roomIdNum;
        socket.currentRoom = roomIdNum;
        socket.join(`room_${currentRoom}`);
        
        socket.emit('join_success', currentRoom);
        
        if (oldRoom) {
            syncRoom(oldRoom);
            checkRoomReadiness(oldRoom);
        }
        syncRoom(currentRoom);
        checkRoomReadiness(currentRoom);
        broadcastRooms();

        const userState = await getUserState(userId);
        if (userState) socket.emit('user_update', userState);
    };

    socket.on('auth', async ({ tg_id, profile_pic }) => {
        try {
            if (!tg_id) return;
            currentUser = tg_id;
            socket.currentUser = tg_id; 
            
            socket.join(`user_${tg_id}`);
            startIdleTimer();
            
            await pool.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [tg_id]);
            if (profile_pic) {
                await pool.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, tg_id]);
            } else {
                await pool.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tg_id]);
            }

            const userState = await getUserState(tg_id);
            const [rooms] = await pool.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
            const customizedRooms = rooms.map(r => r.creator_id === tg_id ? r : { ...r, password: null });
            
            const [existing] = await pool.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
            if (existing.length > 0) {
                currentRoom = existing[0].room_id;
                socket.currentRoom = currentRoom;
                socket.join(`room_${currentRoom}`);
                syncRoom(currentRoom);
            }

            socket.emit('lobby_data', { user: userState, rooms: customizedRooms, currentRoom });
        } catch (err) {}
    });

    socket.on('active_event', () => startIdleTimer());

    socket.on('claim_reward', async ({ type }) => {
        try {
            if (!currentUser) return;
            startIdleTimer();
            let success = false;
            let msg = '';

            if (type === 'daily') {
                const [res] = await pool.query(`
                    UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                    WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
                `, [currentUser]);
                if (res.affectedRows > 0) { success = true; msg = 'Daily reward claimed! +1 Credit'; }
                else { msg = 'Daily reward already claimed today.'; }
            } 
            else if (type === 'ad' || type === 'ad2') {
                const prefix = type === 'ad' ? 'ad' : 'ad2';
                const [u] = await pool.query(`SELECT
                    ${prefix}_claims_today as claims,
                    DATE_FORMAT(last_${prefix}_claim_time, '%Y-%m-%d') as last_date,
                    DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                    TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                    FROM users WHERE tg_id = ?`, [currentUser]);

                if (u.length > 0) {
                    const user = u[0];
                    const isToday = user.last_date === user.today;

                    if (!user.last_date || !isToday) {
                        await pool.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                        success = true; msg = 'Reward claimed! +2 Credits';
                    } else if (user.claims < 3 && (user.mins_passed === null || user.mins_passed >= 180)) {
                        await pool.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = ${prefix}_claims_today + 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                        success = true; msg = 'Reward claimed! +2 Credits';
                    } else {
                        msg = 'Ad reward not available yet. Max 3 per day, 3 hours apart.';
                    }
                }
            }

            if (success) {
                socket.emit('reward_success', msg);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            } else {
                socket.emit('create_error', msg);
            }
        } catch (err) {}
    });

    socket.on('transfer_credits', async ({ target_id, amount }) => {
        try {
            if (!currentUser || currentUser === target_id) return;
            startIdleTimer();
            const amt = Number(amount);
            if (![50, 100, 200, 500, 1000].includes(amt)) return socket.emit('create_error', 'Invalid transfer amount.');

            const totalCost = amt + 2; 
            const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            
            if (u[0].credits < totalCost) {
                return socket.emit('create_error', `Not enough credits! You need ${totalCost} credits (includes 2 credit fee).`);
            }

            await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [totalCost, currentUser]);
            await pool.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [amt, target_id]);

            socket.emit('reward_success', `Successfully sent ${amt} credits to ${toHex(target_id)}!`);
            
            const token = process.env.BOT_TOKEN;
            const sendMsg = (chatId, text, replyMarkup) => {
                if (!token) return;
                fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
                }).catch(console.error);
            };

            const [targetUser] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [target_id]);
            const [senderUser] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [currentUser]);
            
            const targetUsername = targetUser.length > 0 ? targetUser[0].tg_username : null;
            const senderUsername = senderUser.length > 0 ? senderUser[0].tg_username : null;

            if (amt >= 200) {
                let sMarkup = targetUsername ? { inline_keyboard: [[{ text: '💬 Start Chatting', url: `https://t.me/${targetUsername}` }]] } : {};
                sendMsg(currentUser, `You successfully sent ${amt} credits to ${targetUsername ? '@' + targetUsername : toHex(target_id)}.`, sMarkup);
            }

            if (targetUser.length > 0) {
                let rMarkup = senderUsername ? { inline_keyboard: [[{ text: '💬 Start Chatting', url: `https://t.me/${senderUsername}` }]] } : {};
                sendMsg(target_id, `🎁 You received a gift of ${amt} credits from ${senderUsername ? '@' + senderUsername : toHex(currentUser)}!`, rMarkup);
                
                const targetState = await getUserState(target_id);
                io.to(`user_${target_id}`).emit('user_update', targetState);
                io.to(`user_${target_id}`).emit('reward_success', `🎁 You received a gift of ${amt} credits!`);
            }
            
            const myState = await getUserState(currentUser);
            socket.emit('user_update', myState);

        } catch (err) {
            console.error('Transfer credits error:', err);
        }
    });

    socket.on('create_room', async ({ is_private, password, max_members, expire_hours, auto_join }) => {
        try {
            if (!currentUser) return;
            startIdleTimer();
            const limit = [2, 3, 4].includes(max_members) ? max_members : 4;
            let insertRes;
            
            let cost = (auto_join && !is_private) ? 1 : 0;
            const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
            
            if (is_private) {
                if (!password || password.length < 6 || password.length > 10) {
                    return socket.emit('create_error', 'Password must be exactly 6 to 10 characters.');
                }
                let timeCost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
                cost += limit + timeCost;
            }

            if (cost > 0) {
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < cost) return socket.emit('create_error', `Not enough credits. Costs ${cost} credits.`);
                await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            }

            if (is_private) {
                [insertRes] = await pool.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members, creator_id, expire_at) VALUES ('WAITING', UTC_TIMESTAMP(), 1, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`, [password, limit, currentUser, hours]);
            } else {
                [insertRes] = await pool.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, NULL, ?)`, [limit]);
            }

            const newRoomId = insertRes.insertId;
            
            if (is_private) {
                scheduleRoomExpiration(newRoomId, hours * 3600 * 1000);
            }

            if (auto_join) {
                await performJoinRoom(currentUser, newRoomId, password, true);
            } else {
                socket.emit('room_created', { room_id: newRoomId });
            }
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            broadcastRooms();
        } catch (err) { console.error('Create room error:', err); }
    });

    socket.on('search_room', async ({ room_id }) => {
        try {
            startIdleTimer();
            const [rows] = await pool.query('SELECT id, is_private FROM rooms WHERE id = ?', [Number(room_id)]);
            if (rows.length === 0) return socket.emit('join_error', 'Room not found.');
            socket.emit('search_result', rows[0]);
        } catch (err) {}
    });

    socket.on('join_room', async ({ room_id, password }) => {
        try {
            if (!currentUser) return;
            startIdleTimer();
            await performJoinRoom(currentUser, Number(room_id), password, false);
        } catch (err) {}
    });

    socket.on('leave_room', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            await terminateCallsForUser(currentUser); 
            await pool.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            await checkRoomReset(currentRoom);
            socket.leave(`room_${currentRoom}`);
            const leftRoom = currentRoom;
            currentRoom = null;
            socket.currentRoom = null;
            
            syncRoom(leftRoom);
            checkRoomReadiness(leftRoom);
            broadcastRooms();
        } catch (err) {}
    });

    socket.on('extend_room', async ({ expire_hours }) => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
            let cost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
            
            const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');
            
            await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            await pool.query('UPDATE rooms SET expire_at = DATE_ADD(expire_at, INTERVAL ? HOUR) WHERE id = ?', [hours, currentRoom]);
            
            scheduleRoomExpiration(currentRoom, hours * 3600 * 1000); // Overlay robust new duration
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            syncRoom(currentRoom);
        } catch(err) { console.error('Extend room error:', err); }
    });

    socket.on('change_password', async ({ password }) => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be 6-10 characters.');
            
            const [room] = await pool.query('SELECT creator_id FROM rooms WHERE id = ? AND is_private = 1', [currentRoom]);
            if (room.length === 0 || room[0].creator_id !== currentUser) return socket.emit('create_error', 'Unauthorized.');

            await pool.query('UPDATE rooms SET password = ? WHERE id = ?', [currentRoom]);
            socket.emit('reward_success', 'Room password updated successfully!');
            broadcastRooms();
            syncRoom(currentRoom);
        } catch (err) { console.error('Change password error:', err); }
    });

    socket.on('kick_player', async ({ target_id }) => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            const [roomRows] = await pool.query('SELECT is_private, creator_id FROM rooms WHERE id = ?', [currentRoom]);
            if (roomRows.length === 0 || !roomRows[0].is_private || roomRows[0].creator_id !== currentUser) return;

            await pool.query('DELETE FROM room_members WHERE user_id = ? AND room_id = ?', [target_id, currentRoom]);
            
            io.to(`user_${target_id}`).emit('kicked_by_admin');
            
            const sockets = await io.in(`user_${target_id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                if (s.currentRoom === currentRoom) s.currentRoom = null;
            });

            syncRoom(currentRoom);
            checkRoomReadiness(currentRoom);
            broadcastRooms();
        } catch(err) { console.error('Kick player error:', err); }
    });

    socket.on('chat', async ({ message }) => {
        try {
            if (!currentUser || !currentRoom || !message.trim()) return;
            startIdleTimer();
            await pool.query('INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)', [currentRoom, currentUser, message]);
            
            // Inline Database Garbage collection for Chats
            const [countRes] = await pool.query('SELECT COUNT(*) as c FROM chats WHERE room_id = ?', [currentRoom]);
            if (countRes[0].c >= 40) {
                await pool.query(`
                    DELETE FROM chats 
                    WHERE room_id = ? AND id NOT IN (
                        SELECT id FROM (
                            SELECT id FROM chats WHERE room_id = ? ORDER BY id DESC LIMIT 20
                        ) t
                    )
                `, [currentRoom, currentRoom]);
            }

            syncRoom(currentRoom);
        } catch (err) {}
    });

    socket.on('give_up', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            const [room] = await pool.query('SELECT current_drawer_id, status FROM rooms WHERE id = ?', [currentRoom]);
            if (room.length === 0 || room[0].status !== 'DRAWING') return;

            const isDrawer = room[0].current_drawer_id === currentUser;

            if (isDrawer) {
                await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [currentRoom]);
                await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', 'The drawer gave up.']);
                scheduleBreakTransition(currentRoom);
            } else {
                await pool.query('UPDATE room_members SET has_given_up = 1 WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
                await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', `${toHex(currentUser)} voted to give up.`]);

                const [members] = await pool.query('SELECT user_id, has_given_up FROM room_members WHERE room_id = ?', [currentRoom]);
                const guessers = members.filter(m => m.user_id !== room[0].current_drawer_id);
                const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

                if (allGivenUp) {
                    await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [currentRoom]);
                    await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', 'All guessers gave up.']);
                    scheduleBreakTransition(currentRoom);
                }
            }
            syncRoom(currentRoom);
        } catch (err) {
            console.error('Give Up Error:', err);
        }
    });

    socket.on('guess', async ({ guess }) => {
        try {
            if (!currentUser || !currentRoom) return socket.emit('create_error', 'Not logged in or in room.');
            if (!guess || !guess.trim()) return;
            startIdleTimer();
            
            const [room] = await pool.query('SELECT word_to_draw, current_drawer_id, status FROM rooms WHERE id = ?', [currentRoom]);
            if (room.length === 0) return;
            if (room[0].status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
            if (room[0].current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');
            
            const [guessCount] = await pool.query('SELECT COUNT(*) as count FROM guesses WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            
            if (guessCount[0].count >= 5) {
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < 1) {
                    return socket.emit('create_error', 'Not enough credits for extra guesses! (Cost: 1 Credit)');
                }
                await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
            }
            
            const isCorrect = room[0].word_to_draw && room[0].word_to_draw.toLowerCase() === guess.trim().toLowerCase();
            
            await pool.query('INSERT INTO guesses (room_id, user_id, guess_text, is_correct) VALUES (?, ?, ?, ?)', [currentRoom, currentUser, guess.trim(), isCorrect]);
            if (isCorrect) {
                await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [currentUser, currentRoom]);
                scheduleBreakTransition(currentRoom);
            }
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);

            syncRoom(currentRoom);
        } catch (err) {
            console.error('Guess Error:', err);
        }
    });

    socket.on('buy_hint', async ({ index }) => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();

            const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < 2) return socket.emit('create_error', 'Not enough credits to buy a hint.');

            const [member] = await pool.query('SELECT purchased_hints FROM room_members WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            if(member.length === 0) return;

            let purchased = JSON.parse(member[0].purchased_hints || '[]');
            if (!purchased.includes(index)) {
                purchased.push(index);
                await pool.query('UPDATE users SET credits = credits - 2 WHERE tg_id = ?', [currentUser]);
                await pool.query('UPDATE room_members SET purchased_hints = ? WHERE room_id = ? AND user_id = ?', [JSON.stringify(purchased), currentRoom, currentUser]);
                
                await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', `${toHex(currentUser)} used a hint for 2 Credits!`]);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                
                syncRoom(currentRoom);
            }
        } catch (err) {
            console.error('Buy Hint Error:', err);
        }
    });

    socket.on('set_word', async ({ word }) => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            const wordClean = word.trim().toUpperCase();
            if (wordClean.length < 3 || wordClean.length > 10) {
                return socket.emit('create_error', 'Word must be between 3 and 10 characters.');
            }

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

            const activeRoomId = currentRoom;

            await pool.query("UPDATE rooms SET word_to_draw = ?, base_hints = ?, status = 'DRAWING', round_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [wordClean, JSON.stringify(hints), currentRoom, currentUser]);
            await pool.query("UPDATE room_members SET purchased_hints = '[]', has_given_up = 0 WHERE room_id = ?", [currentRoom]);
            
            await pool.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
            await pool.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
            await clearRedo(currentRoom);
            syncRoom(currentRoom);

            // Timeout protected against race conditions 
            setTimeout(async () => {
                const [r] = await pool.query("SELECT status, round_end_time FROM rooms WHERE id = ?", [activeRoomId]);
                if (r.length > 0 && r[0].status === 'DRAWING' && new Date(r[0].round_end_time) <= new Date()) {
                    await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [activeRoomId]);
                    syncRoom(activeRoomId);
                    scheduleBreakTransition(activeRoomId);
                }
            }, 120000);

        } catch (err) {
            console.error('Set Word Error:', err);
        }
    });

    socket.on('set_ready', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            startIdleTimer();
            await pool.query('UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            syncRoom(currentRoom);
            checkRoomReadiness(currentRoom);
        } catch (err) {}
    });

    socket.on('draw', async ({ lines }) => {
        try {
            if (!currentUser || !currentRoom) return;
            await clearRedo(currentRoom);
            await pool.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [currentRoom, JSON.stringify(lines)]);
            socket.to(`room_${currentRoom}`).emit('live_draw', lines);
        } catch (err) {}
    });

    socket.on('undo', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            const [last] = await pool.query('SELECT * FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1', [currentRoom]);
            if (last.length > 0) {
                await pushRedo(currentRoom, JSON.stringify(last[0]));
                await pool.query('DELETE FROM drawings WHERE id = ?', [last[0].id]);
                syncRoom(currentRoom);
            }
        } catch (err) {}
    });

    socket.on('redo', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            const toRestoreStr = await popRedo(currentRoom);
            if (toRestoreStr) {
                const toRestore = JSON.parse(toRestoreStr);
                await pool.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [currentRoom, toRestore.line_data]);
                syncRoom(currentRoom);
            }
        } catch (err) {}
    });

    socket.on('initiate_call', async ({ receiver_id }) => {
        if (!currentUser || !currentRoom) return;
        startIdleTimer();
        
        const allCallsMap = await getActiveCalls();
        const isInCall = Object.values(allCallsMap).map(c => JSON.parse(c)).some(
            c => c.caller === currentUser || c.receiver === currentUser ||
                 c.caller === receiver_id || c.receiver === receiver_id
        );
        
        if (isInCall) {
            return socket.emit('create_error', 'Cannot initiate call: User is already busy.');
        }

        const callId = `call_${Date.now()}_${Math.random()}`;
        const callObj = { id: callId, caller: currentUser, receiver: receiver_id, status: 'RINGING', room_id: currentRoom };
        
        await setCall(callId, JSON.stringify(callObj));
        io.to(`room_${currentRoom}`).emit('call_update', callObj);
        syncRoom(currentRoom);
    });

    socket.on('accept_call', async ({ call_id }) => {
        const callData = await getCall(call_id);
        if(!callData) return;
        const call = JSON.parse(callData);

        if (call.receiver === currentUser) {
            call.status = 'ACTIVE';
            call.startTime = Date.now();
            await setCall(call_id, JSON.stringify(call));
            io.to(`room_${call.room_id}`).emit('call_update', call);
            
            // Assign billing responsibility locally to whichever server node accepted the call.
            socket.activeBillingIntervals = socket.activeBillingIntervals || {};
            socket.activeBillingIntervals[call_id] = setInterval(async () => {
                const cData = await getCall(call_id);
                if(!cData) return clearInterval(socket.activeBillingIntervals[call_id]);
                const c = JSON.parse(cData);
                
                await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ? AND credits > 0', [c.caller]);
                const [u1] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [c.caller]);
                
                if (u1[0].credits <= 0) {
                    clearInterval(socket.activeBillingIntervals[call_id]);
                    await delCall(call_id);
                    io.to(`room_${c.room_id}`).emit('call_ended', call_id);
                    syncRoom(c.room_id);
                } else {
                    const uState1 = await getUserState(c.caller);
                    if(uState1) io.to(`user_${c.caller}`).emit('user_update', uState1);
                }
            }, 60000);

            syncRoom(currentRoom);
        }
    });

    socket.on('end_call', async ({ call_id }) => {
        await delCall(call_id);
        io.to(`room_${currentRoom || 'all'}`).emit('call_ended', call_id);
        syncRoom(currentRoom);
        
        if (socket.activeBillingIntervals && socket.activeBillingIntervals[call_id]) {
            clearInterval(socket.activeBillingIntervals[call_id]);
            delete socket.activeBillingIntervals[call_id];
        }
    });

    socket.on('webrtc_signal', ({ call_id, target_id, signal }) => {
        socket.to(`user_${target_id}`).emit('webrtc_signal_receive', { call_id, sender_id: currentUser, target_id, signal });
    });

    socket.on('disconnect', async () => {
        if (socket.idleTimeout) clearTimeout(socket.idleTimeout);
        if (socket.warnTimeout) clearTimeout(socket.warnTimeout);
        
        if (socket.activeBillingIntervals) {
            Object.values(socket.activeBillingIntervals).forEach(clearInterval);
        }

        if (currentUser) {
            await terminateCallsForUser(currentUser); 
            if (currentRoom) {
                await pool.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
                await checkRoomReset(currentRoom);
                syncRoom(currentRoom);
                checkRoomReadiness(currentRoom);
                broadcastRooms();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DoodleDash Scalable Cluster instance listening on port ${PORT}`));
