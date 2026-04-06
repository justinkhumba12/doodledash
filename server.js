const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Environment Variables (Railway Strict) ---
const PORT = process.env.PORT || 3306;
const DB_HOST = process.env.DB_HOST || 'mysql.railway.internal';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || 'sPOjadCTXgnleiWulhlkRyyDQytFrHGH';
const DB_NAME = process.env.DB_NAME || 'railway';
const BOT_TOKEN = process.env.BOT_TOKEN || '8370801985:AAH42vuVLp_XnP3G3wE6PdytYHj39lXacFE';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://doodledash-production-34a6.up.railway.app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '9f7c2a6d4b8e1c3f0a5d9e7b2c4f6a1e';

app.use(express.json());
app.use(express.static('public'));

let pool;

// --- Auto Database Initialization & Tables ---
async function initDB() {
    pool = mysql.createPool({
        host: DB_HOST, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
        waitForConnections: true, connectionLimit: 10, queueLimit: 0,
        timezone: '+00:00' // Global Timing
    });

    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY, tg_id VARCHAR(50) UNIQUE,
            registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            profile_pic VARCHAR(500), credits INT DEFAULT 0, last_daily_claim DATE, ad_claims_today INT DEFAULT 0,
            last_ad_claim_time DATETIME, last_ad_claim_date DATE, ad2_claims_today INT DEFAULT 0,
            last_ad2_claim_time DATETIME, last_ad2_claim_date DATE, last_notified_date DATE
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
            id INT AUTO_INCREMENT PRIMARY KEY, status ENUM('WAITING', 'PRE_DRAW', 'DRAWING', 'REVEAL', 'BREAK') DEFAULT 'WAITING',
            current_drawer_id VARCHAR(50), word_to_draw VARCHAR(30), round_end_time DATETIME, break_end_time DATETIME,
            last_winner_id VARCHAR(50), next_drawer_id VARCHAR(50), modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS room_members (
            room_id INT, user_id VARCHAR(50), is_ready TINYINT(1) DEFAULT 0, joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            consecutive_turns INT DEFAULT 0, total_turns INT DEFAULT 0, join_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (room_id, user_id)
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
            id INT AUTO_INCREMENT PRIMARY KEY, room_id INT, user_id VARCHAR(50), message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS drawings (
            id INT AUTO_INCREMENT PRIMARY KEY, room_id INT, line_data LONGTEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS guesses (
            id INT AUTO_INCREMENT PRIMARY KEY, room_id INT, user_id VARCHAR(50), guess_text VARCHAR(50), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS calls (
            id INT AUTO_INCREMENT PRIMARY KEY, room_id INT, caller_id VARCHAR(255), receiver_id VARCHAR(255),
            status ENUM('RINGING','ACTIVE','ENDED','DECLINED'), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMP NULL, last_billed_at TIMESTAMP NULL
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS webrtc_signals (
            id INT AUTO_INCREMENT PRIMARY KEY, call_id INT, sender_id VARCHAR(255), receiver_id VARCHAR(255),
            type VARCHAR(50), payload TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("Database & Tables Verified Successfully.");
    } catch (e) {
        console.error("DB Init Error:", e);
    }
}

// --- Telegram Webhook Setup ---
async function setupWebhook() {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEB_APP_URL}/webhook&secret_token=${WEBHOOK_SECRET}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        console.log("Telegram Webhook Status:", data.description);
    } catch (e) { console.error("Webhook Error:", e); }
}

app.post('/webhook', async (req, res) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return res.status(403).send('Forbidden');
    const update = req.body;
    
    if (update.message && update.message.text === '/start') {
        const tgId = update.message.from.id;
        const chatId = update.message.chat.id;
        try { await pool.query("INSERT IGNORE INTO users (tg_id) VALUES (?)", [tgId]); } catch (e) {}
        
        const payload = {
            chat_id: chatId, text: "Welcome! Click below to join DoodleDash!",
            reply_markup: { inline_keyboard: [[{ text: '🎮 Play Draw & Guess', web_app: { url: WEB_APP_URL } }]] }
        };
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        }).catch(console.error);
    }
    res.sendStatus(200);
});

// --- Security ---
function verifyTelegramData(initData, botToken) {
    if(!initData) return false;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const sortedKeys = Array.from(params.keys()).sort();
    const dataCheckString = sortedKeys.map(key => `${key}=${params.get(key)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return checkHash === hash;
}

// --- Global Memory Game State (Economy Optimization) ---
// We hold volatile things like active drawings in-memory to prevent thousands of DB inserts.
const activeDrawings = {}; 

// --- Socket Events ---
io.use((socket, next) => {
    const { tg_data, tg_id } = socket.handshake.auth;
    if (verifyTelegramData(tg_data, BOT_TOKEN) || process.env.NODE_ENV !== 'production') {
        socket.tg_id = String(tg_id);
        socket.join(`user_${socket.tg_id}`); // Personal room for WebRTC signals
        next();
    } else {
        next(new Error("Unauthorized"));
    }
});

io.on('connection', (socket) => {
    const tg_id = socket.tg_id;
    pool.query("UPDATE users SET last_active = NOW() WHERE tg_id = ?", [tg_id]);

    // Send initial user data
    const syncUserAndRooms = async () => {
        const [users] = await pool.query("SELECT * FROM users WHERE tg_id = ?", [tg_id]);
        const [rooms] = await pool.query("SELECT r.id, r.status, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id");
        const [myRoom] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [tg_id]);
        socket.emit('rooms_data', { user_data: users[0], rooms, current_room: myRoom.length ? myRoom[0].room_id : null, server_time: new Date().toISOString() });
    };
    syncUserAndRooms();

    socket.on('create_room', async () => {
        const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tg_id]);
        if (users[0].credits < 1) return socket.emit('alert', { msg: "Not enough credits.", type: "error" });
        await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [tg_id]);
        const [res] = await pool.query("INSERT INTO rooms (status, modified_at) VALUES ('WAITING', NOW())");
        joinRoom(res.insertId);
    });

    socket.on('join_room', async ({ room_id }) => joinRoom(room_id));
    
    async function joinRoom(room_id) {
        await pool.query("DELETE FROM room_members WHERE user_id = ?", [tg_id]); // Leave others
        await pool.query("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)", [room_id, tg_id]);
        socket.join(`room_${room_id}`);
        if(!activeDrawings[room_id]) activeDrawings[room_id] = [];
        syncRoomState(room_id);
    }

    socket.on('leave_room', async () => {
        const [room] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [tg_id]);
        if (room.length) {
            await pool.query("DELETE FROM room_members WHERE user_id = ?", [tg_id]);
            socket.leave(`room_${room[0].room_id}`);
            syncRoomState(room[0].room_id);
        }
    });

    // Chat & Guesses
    socket.on('chat', async ({ room_id, message }) => {
        if (!message || message.length > 200) return;
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)", [room_id, tg_id, message]);
        syncRoomState(room_id);
    });

    socket.on('guess', async ({ room_id, guess }) => {
        const [roomData] = await pool.query("SELECT word_to_draw, current_drawer_id FROM rooms WHERE id = ?", [room_id]);
        if(!roomData.length) return;
        
        const [counts] = await pool.query("SELECT COUNT(*) as c FROM guesses WHERE room_id = ? AND user_id = ?", [room_id, tg_id]);
        if (counts[0].c >= 5) {
            const [u] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tg_id]);
            if (u[0].credits < 1) return socket.emit('alert', { msg: "Max free guesses. Cost: 1 Credit.", type: "error" });
            await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [tg_id]);
        }
        await pool.query("INSERT INTO guesses (room_id, user_id, guess_text) VALUES (?, ?, ?)", [room_id, tg_id, guess]);

        if (guess.toLowerCase() === (roomData[0].word_to_draw || '').toLowerCase()) {
            await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [tg_id, room_id]);
        }
        syncRoomState(room_id);
    });

    // In-memory Drawing Sync (Economy: Save 90% DB costs)
    socket.on('draw', ({ room_id, lines }) => {
        const parsed = JSON.parse(lines);
        if(!activeDrawings[room_id]) activeDrawings[room_id] = [];
        activeDrawings[room_id].push(parsed); // Keep in memory for new joiners
        socket.to(`room_${room_id}`).emit('draw_update', parsed); // Broadcast instantly
    });
    
    socket.on('undo_draw', ({ room_id }) => {
        if(activeDrawings[room_id] && activeDrawings[room_id].length > 0) {
            activeDrawings[room_id].pop();
            io.to(`room_${room_id}`).emit('clear_canvas');
            io.to(`room_${room_id}`).emit('full_draw_state', activeDrawings[room_id]);
        }
    });

    socket.on('set_word', async ({ room_id, word }) => {
        await pool.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = DATE_ADD(NOW(), INTERVAL 125 SECOND), modified_at = NOW() WHERE id = ? AND current_drawer_id = ?", [word, room_id, tg_id]);
        activeDrawings[room_id] = []; // clear in-memory drawings
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [room_id]);
        syncRoomState(room_id);
    });

    socket.on('set_ready', async ({ room_id }) => {
        await pool.query("UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?", [room_id, tg_id]);
        syncRoomState(room_id);
    });

    // Economy: WebRTC Signaling purely in memory via WebSockets
    socket.on('initiate_call', async ({ room_id, receiver_id }) => {
        const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tg_id]);
        if (users[0].credits < 1) return socket.emit('alert', { msg: "Need 1 credit.", type: "error" });
        await pool.query("INSERT INTO calls (room_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'RINGING')", [room_id, tg_id, receiver_id]);
        syncRoomState(room_id);
    });

    socket.on('accept_call', async ({ call_id }) => {
        await pool.query("UPDATE calls SET status = 'ACTIVE', started_at = NOW(), last_billed_at = NOW() WHERE id = ?", [call_id]);
        syncRoomState(null, true); // global sync
    });

    socket.on('end_call', async ({ call_id }) => {
        await pool.query("UPDATE calls SET status = 'ENDED' WHERE id = ?", [call_id]);
        syncRoomState(null, true);
    });

    socket.on('webrtc_signal', ({ call_id, receiver_id, type, payload }) => {
        // Direct routing, 0 database writes. Extremely fast and economical.
        io.to(`user_${receiver_id}`).emit('webrtc_signal', { sender_id: tg_id, type, payload });
    });

    // Economy & Claims
    socket.on('claim_daily', async () => {
        const [users] = await pool.query("SELECT last_daily_claim FROM users WHERE tg_id = ?", [tg_id]);
        const today = new Date().toISOString().split('T')[0];
        if (users[0].last_daily_claim === today) return socket.emit('alert', { msg: "Already claimed", type: "error" });
        await pool.query("UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?", [today, tg_id]);
        syncUserAndRooms();
    });
});

// --- Sync State Dispatcher ---
async function syncRoomState(room_id = null, globalUpdate = false) {
    if(globalUpdate) {
        const [rooms] = await pool.query("SELECT DISTINCT room_id FROM room_members");
        rooms.forEach(r => syncRoomState(r.room_id));
        return;
    }
    if (!room_id) return;
    
    const [room] = await pool.query("SELECT * FROM rooms WHERE id = ?", [room_id]);
    if (!room.length) {
        io.to(`room_${room_id}`).emit('room_closed');
        return;
    }

    const [members] = await pool.query("SELECT m.user_id, m.is_ready, u.profile_pic FROM room_members m JOIN users u ON m.user_id = u.tg_id WHERE m.room_id = ?", [room_id]);
    const [chats] = await pool.query("SELECT user_id, message, created_at FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 20", [room_id]);
    const [guesses] = await pool.query("SELECT user_id, guess_text, created_at FROM guesses WHERE room_id = ? ORDER BY created_at ASC", [room_id]);
    const [calls] = await pool.query("SELECT id, caller_id, receiver_id, status FROM calls WHERE room_id = ? AND status IN ('RINGING', 'ACTIVE')", [room_id]);

    const state = {
        room: room[0],
        members,
        chats: chats.reverse(),
        guesses,
        calls,
        server_time: new Date().toISOString(),
        drawings: activeDrawings[room_id] || []
    };
    io.to(`room_${room_id}`).emit('sync_state', state);
}

// --- GLOBAL TIMING GAME LOOP (Runs every 1000ms natively) ---
setInterval(async () => {
    try {
        const now = new Date();
        const [rooms] = await pool.query("SELECT * FROM rooms WHERE status != 'WAITING'");
        
        for (let r of rooms) {
            let stateChanged = false;
            
            // Draw Timer rules
            if (r.status === 'DRAWING' && r.round_end_time && new Date(r.round_end_time) <= now) {
                // Time up! End round
                await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND), modified_at = NOW() WHERE id = ?", [r.id]);
                stateChanged = true;
            }
            
            // Break Timer Rules
            if (r.status === 'REVEAL' && r.break_end_time && new Date(r.break_end_time) <= now) {
                await pool.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(NOW(), INTERVAL 600 SECOND), modified_at = NOW() WHERE id = ?", [r.id]);
                stateChanged = true;
            }

            // Ready Check System
            const [members] = await pool.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [r.id]);
            if(members.length < 2) {
                await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [r.id]);
                stateChanged = true;
            } else if (['WAITING', 'BREAK', 'REVEAL'].includes(r.status) && members.every(m => m.is_ready)) {
                // Next Drawer Selection
                const nextDrawer = r.next_drawer_id || members[Math.floor(Math.random() * members.length)].user_id;
                await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL, last_winner_id = NULL WHERE id = ?", [nextDrawer, r.id]);
                await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                activeDrawings[r.id] = [];
                stateChanged = true;
            }

            // Seamless Call Billing (Global)
            const [calls] = await pool.query("SELECT c.id, c.caller_id, u.credits FROM calls c JOIN users u ON c.caller_id = u.tg_id WHERE c.room_id = ? AND c.status = 'ACTIVE' AND c.last_billed_at <= DATE_SUB(NOW(), INTERVAL 120 SECOND)", [r.id]);
            for(let call of calls) {
                if (call.credits < 1) {
                    await pool.query("UPDATE calls SET status = 'ENDED' WHERE id = ?", [call.id]);
                } else {
                    await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [call.caller_id]);
                    await pool.query("UPDATE calls SET last_billed_at = NOW() WHERE id = ?", [call.id]);
                }
                stateChanged = true;
            }

            if (stateChanged) syncRoomState(r.id);
        }
    } catch(e) { console.error("Loop Error:", e); }
}, 1000);

server.listen(PORT, async () => {
    console.log(`Server globally running on port ${PORT}`);
    await initDB();
    setupWebhook();
});
