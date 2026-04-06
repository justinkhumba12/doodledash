require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURATION & DATABASE
// ==========================================
const DB_HOST = process.env.DB_HOST || 'mysql.railway.internal';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || 'sPOjadCTXgnleiWulhlkRyyDQytFrHGH';
const DB_NAME = process.env.DB_NAME || 'railway';

const BOT_TOKEN = process.env.BOT_TOKEN || '8370801985:AAH42vuVLp_XnP3G3wE6PdytYHj39lXacFE';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://doodledash-production-fa4e.up.railway.app';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '9f7c2a6d4b8e1c3f0a5d9e7b2c4f6a1e';

const pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+05:30' // IST Timezone
});

// Create tables automatically on startup
async function initDatabase() {
    try {
        const connection = await pool.getConnection();
        await connection.query(`SET time_zone = '+05:30';`);

        await connection.query(`CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            tg_id VARCHAR(50) UNIQUE,
            registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            profile_pic VARCHAR(500) NULL,
            credits INT DEFAULT 0,
            last_daily_claim DATE NULL,
            ad_claims_today INT DEFAULT 0,
            last_ad_claim_time DATETIME NULL,
            last_ad_claim_date DATE NULL,
            last_notified_date DATE NULL,
            ad2_claims_today INT DEFAULT 0,
            last_ad2_claim_time DATETIME NULL,
            last_ad2_claim_date DATE NULL
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS rooms (
            id INT AUTO_INCREMENT PRIMARY KEY,
            status ENUM('WAITING', 'PRE_DRAW', 'DRAWING', 'REVEAL', 'BREAK') DEFAULT 'WAITING',
            current_drawer_id VARCHAR(50) NULL,
            word_to_draw VARCHAR(30) NULL,
            round_end_time DATETIME NULL,
            break_end_time DATETIME NULL,
            last_winner_id VARCHAR(50) NULL,
            next_drawer_id VARCHAR(50) NULL,
            modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS room_members (
            room_id INT,
            user_id VARCHAR(50),
            is_ready TINYINT(1) DEFAULT 0,
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            consecutive_turns INT DEFAULT 0,
            total_turns INT DEFAULT 0,
            join_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(room_id, user_id)
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS chat_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id INT NOT NULL,
            user_id VARCHAR(50) NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS guesses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id INT NOT NULL,
            user_id VARCHAR(50) NULL,
            guess_text VARCHAR(50) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS drawings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id INT NOT NULL,
            line_data LONGTEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS calls (
            id INT AUTO_INCREMENT PRIMARY KEY,
            room_id INT NOT NULL,
            caller_id VARCHAR(255) NOT NULL,
            receiver_id VARCHAR(255) NOT NULL,
            status ENUM('RINGING', 'ACTIVE', 'ENDED', 'DECLINED', 'MISSED') DEFAULT 'RINGING',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMP NULL,
            last_billed_at TIMESTAMP NULL
        )`);

        await connection.query(`CREATE TABLE IF NOT EXISTS webrtc_signals (
            id INT AUTO_INCREMENT PRIMARY KEY,
            call_id INT NOT NULL,
            sender_id VARCHAR(50) NOT NULL,
            receiver_id VARCHAR(50) NOT NULL,
            type VARCHAR(50) NOT NULL,
            payload TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        connection.release();
        console.log('✅ Database Tables Initialized');
    } catch (err) {
        console.error('❌ Database Initialization Error:', err);
    }
}
initDatabase();

// ==========================================
// 2. UTILITY FUNCTIONS
// ==========================================
function verifyTelegramWebAppData(telegramInitData, botToken) {
    if (!telegramInitData) return false;
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    urlParams.sort();
    
    let dataCheckString = '';
    for (const [key, value] of urlParams.entries()) {
        dataCheckString += `${key}=${value}\n`;
    }
    dataCheckString = dataCheckString.slice(0, -1);
    
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    const authDate = urlParams.get('auth_date');
    if (authDate && (Date.now() / 1000 - parseInt(authDate) > 43200)) {
        return false; // older than 12 hours
    }
    return calculatedHash === hash;
}

function getIST() {
    const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return {
        dateStr: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        timeStr: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    };
}

// User active socket tracking { tg_id: socket.id }
const activeUsers = {};

// ==========================================
// 3. TELEGRAM WEBHOOK ROUTE
// ==========================================
app.post('/webhook', async (req, res) => {
    const headerToken = req.headers['x-telegram-bot-api-secret-token'];
    if (headerToken !== WEBHOOK_SECRET) {
        return res.status(403).send("Access Denied");
    }

    const update = req.body;
    if (!update || !update.message) return res.sendStatus(200);
    
    const message = update.message;
    const chatId = message.chat?.id;
    const tgId = message.from?.id?.toString();
    const text = message.text || '';

    if (text === '/start' && chatId && tgId) {
        try {
            await pool.query(`INSERT IGNORE INTO users (tg_id) VALUES (?)`, [tgId]);
            const keyboard = {
                inline_keyboard: [[{ text: '🎮 Play Draw & Guess', web_app: { url: WEB_APP_URL } }]]
            };
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: "Welcome! You are now registered. Click the button below to join the game rooms!",
                reply_markup: keyboard
            });
        } catch (e) { console.error('Webhook Error:', e.message); }
    }
    res.sendStatus(200);
});

// ==========================================
// 4. WEBSOCKET HANDLERS (GAME LOGIC)
// ==========================================
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('authenticate', async (data) => {
        if (!verifyTelegramWebAppData(data.tg_data, BOT_TOKEN)) {
            socket.emit('auth_error', { message: 'Invalid Telegram Signature' });
            return;
        }
        currentUser = data.tg_id;
        activeUsers[currentUser] = socket.id;

        try {
            const [users] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [currentUser]);
            if (users.length === 0) {
                socket.emit('auth_error', { message: 'Send /start to the bot first.' });
                return;
            }
            if (data.photo_url) {
                await pool.query('UPDATE users SET last_active = NOW(), profile_pic = ? WHERE tg_id = ?', [data.photo_url, currentUser]);
            } else {
                await pool.query('UPDATE users SET last_active = NOW() WHERE tg_id = ?', [currentUser]);
            }
            socket.emit('authenticated');
            sendLobbyData(socket);
        } catch (e) { console.error(e); }
    });

    socket.on('get_lobby', () => sendLobbyData(socket));

    socket.on('claim_daily', async () => {
        if (!currentUser) return;
        const ist = getIST();
        const [users] = await pool.query('SELECT last_daily_claim FROM users WHERE tg_id = ?', [currentUser]);
        if (users[0].last_daily_claim && new Date(users[0].last_daily_claim).toISOString().split('T')[0] === ist.dateStr) {
            return socket.emit('alert', { type: 'error', message: 'Already claimed today!' });
        }
        await pool.query('UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?', [ist.dateStr, currentUser]);
        socket.emit('alert', { type: 'success', message: 'Checked in! +1 Credit.' });
        sendLobbyData(socket);
    });

    socket.on('claim_ad', async (data) => {
        if (!currentUser) return;
        const type = data.type === 'ad2' ? 'ad2' : 'ad';
        const colClaims = type === 'ad2' ? 'ad2_claims_today' : 'ad_claims_today';
        const colDate = type === 'ad2' ? 'last_ad2_claim_date' : 'last_ad_claim_date';
        const colTime = type === 'ad2' ? 'last_ad2_claim_time' : 'last_ad_claim_time';
        
        const ist = getIST();
        const [users] = await pool.query(`SELECT ${colClaims}, ${colTime}, ${colDate} FROM users WHERE tg_id = ?`, [currentUser]);
        const user = users[0];

        let claimsToday = user[colDate] === ist.dateStr ? user[colClaims] : 0;
        if (claimsToday >= 2) return socket.emit('alert', { type: 'error', message: 'Ad limit reached (2/day).' });

        if (claimsToday > 0 && user[colTime]) {
            const lastTime = new Date(user[colTime]).getTime();
            const now = new Date(ist.timeStr).getTime();
            if ((now - lastTime) / 3600000 < 3) {
                return socket.emit('alert', { type: 'error', message: 'Cooldown active! Wait 3 hours.' });
            }
        }

        await pool.query(`UPDATE users SET credits = credits + 2, ${colClaims} = ?, ${colTime} = ?, ${colDate} = ? WHERE tg_id = ?`, 
            [claimsToday + 1, ist.timeStr, ist.dateStr, currentUser]);
        
        socket.emit('alert', { type: 'success', message: '+2 Credits!' });
        sendLobbyData(socket);
    });

    socket.on('create_room', async () => {
        if (!currentUser) return;
        try {
            const [rooms] = await pool.query("SELECT COUNT(*) as count FROM rooms");
            if (rooms[0].count >= 10) return socket.emit('alert', { type: 'error', message: 'Global limit of 10 rooms reached.' });
            
            const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [currentUser]);
            if (users[0].credits < 1) return socket.emit('alert', { type: 'error', message: '1 Credit required to create room.' });
            
            await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [currentUser]);
            const [res] = await pool.query("INSERT INTO rooms (status) VALUES ('WAITING')");
            socket.emit('room_created', { room_id: res.insertId });
        } catch(e) { console.error(e); }
    });

    socket.on('join_room', async ({ room_id }) => {
        if (!currentUser) return;
        try {
            // Check full
            const [count] = await pool.query("SELECT COUNT(*) as c FROM room_members WHERE room_id = ?", [room_id]);
            const [existing] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [currentUser]);
            
            if (count[0].c >= 4 && (!existing.length || existing[0].room_id !== room_id)) {
                return socket.emit('alert', { type: 'error', message: 'Room is full.' });
            }
            
            if (existing.length && existing[0].room_id !== room_id) {
                await pool.query("DELETE FROM room_members WHERE user_id = ?", [currentUser]); // Force leave old room
                socket.leave(existing[0].room_id.toString());
            }

            if (!existing.length || existing[0].room_id !== room_id) {
                await pool.query("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)", [room_id, currentUser]);
            }
            
            socket.join(room_id.toString());
            socket.emit('joined_room', { room_id });
            sendLobbyData(socket); // Broadcast overall changes
            io.to(room_id.toString()).emit('room_updated'); // Trigger room sync
        } catch(e) { console.error(e); }
    });

    socket.on('leave_room', async ({ room_id }) => {
        if (!currentUser) return;
        await pool.query("DELETE FROM room_members WHERE user_id = ?", [currentUser]);
        await pool.query("UPDATE calls SET status = 'ENDED' WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)", [currentUser, currentUser]);
        socket.leave(room_id.toString());
        socket.emit('left_room');
        io.to(room_id.toString()).emit('room_updated');
    });

    socket.on('chat', async ({ room_id, message }) => {
        if (!currentUser || !message) return;
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)", [room_id, currentUser, message.substring(0, 200)]);
        io.to(room_id.toString()).emit('room_updated');
    });

    socket.on('guess', async ({ room_id, guess }) => {
        if (!currentUser || !guess) return;
        const [counts] = await pool.query("SELECT COUNT(*) as c FROM guesses WHERE room_id = ? AND user_id = ?", [room_id, currentUser]);
        
        if (counts[0].c >= 5) {
            const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [currentUser]);
            if (users[0].credits < 1) return socket.emit('alert', { type: 'error', message: 'Need 1 credit for extra guesses.' });
            await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [currentUser]);
        }

        await pool.query("INSERT INTO guesses (room_id, user_id, guess_text) VALUES (?, ?, ?)", [room_id, currentUser, guess]);
        
        const [room] = await pool.query("SELECT word_to_draw FROM rooms WHERE id = ?", [room_id]);
        if (room[0] && room[0].word_to_draw && guess.toLowerCase() === room[0].word_to_draw.toLowerCase()) {
            await endRound(room_id, currentUser);
        }
        io.to(room_id.toString()).emit('room_updated');
    });

    socket.on('draw', async ({ room_id, lines }) => {
        if (!currentUser) return;
        const [room] = await pool.query("SELECT current_drawer_id FROM rooms WHERE id = ?", [room_id]);
        if (room[0].current_drawer_id !== currentUser) return;
        
        await pool.query("INSERT INTO drawings (room_id, line_data) VALUES (?, ?)", [room_id, lines]);
        socket.to(room_id.toString()).emit('draw_update', { lines: JSON.parse(lines) });
    });

    socket.on('undo_draw', async ({ room_id }) => {
        if (!currentUser) return;
        const [room] = await pool.query("SELECT current_drawer_id FROM rooms WHERE id = ?", [room_id]);
        if (room[0].current_drawer_id !== currentUser) return;

        const [last] = await pool.query("SELECT id, line_data FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1", [room_id]);
        if (last.length > 0) {
            await pool.query("DELETE FROM drawings WHERE id = ?", [last[0].id]);
            io.to(room_id.toString()).emit('room_updated');
            socket.emit('undo_success', { line_data: last[0].line_data });
        }
    });

    socket.on('set_word', async ({ room_id, word }) => {
        if (!currentUser || word.length < 3) return;
        const ist = getIST();
        const endTime = new Date(new Date(ist.timeStr).getTime() + 125000);
        const endStr = `${endTime.getFullYear()}-${String(endTime.getMonth()+1).padStart(2,'0')}-${String(endTime.getDate()).padStart(2,'0')} ${String(endTime.getHours()).padStart(2,'0')}:${String(endTime.getMinutes()).padStart(2,'0')}:${String(endTime.getSeconds()).padStart(2,'0')}`;
        
        await pool.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = ? WHERE id = ? AND current_drawer_id = ?", [word, endStr, room_id, currentUser]);
        await pool.query("DELETE FROM drawings WHERE room_id = ?", [room_id]);
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [room_id]);
        io.to(room_id.toString()).emit('room_updated');
    });

    socket.on('set_ready', async ({ room_id }) => {
        if (!currentUser) return;
        await pool.query("UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?", [room_id, currentUser]);
        io.to(room_id.toString()).emit('room_updated');
    });

    // --- WebRTC ---
    socket.on('initiate_call', async ({ room_id, receiver_id }) => {
        if (!currentUser) return;
        const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [currentUser]);
        if (users[0].credits < 1) return socket.emit('alert', { type: 'error', message: 'Need 1 credit to start a call.' });
        
        const [busy] = await pool.query("SELECT COUNT(*) as c FROM calls WHERE status IN ('RINGING','ACTIVE') AND (caller_id=? OR receiver_id=?)", [receiver_id, receiver_id]);
        if (busy[0].c > 0) return socket.emit('alert', { type: 'error', message: 'User is busy.' });

        await pool.query("INSERT INTO calls (room_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'RINGING')", [room_id, currentUser, receiver_id]);
        io.to(room_id.toString()).emit('room_updated');
    });

    socket.on('accept_call', async ({ call_id }) => {
        if (!currentUser) return;
        const [call] = await pool.query("SELECT caller_id FROM calls WHERE id = ? AND status='RINGING'", [call_id]);
        if(!call.length) return;
        
        const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [call[0].caller_id]);
        if (users[0].credits < 1) {
            await pool.query("UPDATE calls SET status='DECLINED' WHERE id=?", [call_id]);
            return socket.emit('alert', { type: 'error', message: 'Caller out of credits.' });
        }
        await pool.query("UPDATE calls SET status='ACTIVE', started_at=NOW(), last_billed_at=NOW() WHERE id=?", [call_id]);
        const [updated] = await pool.query("SELECT room_id FROM calls WHERE id=?", [call_id]);
        io.to(updated[0].room_id.toString()).emit('room_updated');
    });

    socket.on('end_call', async ({ call_id }) => {
        if (!currentUser) return;
        await pool.query("UPDATE calls SET status='ENDED' WHERE id=? AND (caller_id=? OR receiver_id=?)", [call_id, currentUser, currentUser]);
        await pool.query("DELETE FROM webrtc_signals WHERE call_id=?", [call_id]);
        socket.emit('room_updated'); // force sync local
    });

    socket.on('webrtc_signal', async ({ call_id, receiver_id, type, payload }) => {
        if (!currentUser) return;
        // Save to DB for historical/strict schema matching
        await pool.query("INSERT INTO webrtc_signals (call_id, sender_id, receiver_id, type, payload) VALUES (?, ?, ?, ?, ?)", [call_id, currentUser, receiver_id, type, JSON.stringify(payload)]);
        
        // Instant routing via WebSockets
        if (activeUsers[receiver_id]) {
            io.to(activeUsers[receiver_id]).emit('webrtc_signal_received', {
                call_id, sender_id: currentUser, type, payload
            });
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            delete activeUsers[currentUser];
            // Optionally remove from room_members if needed after delay, handled by cron/global loop
        }
    });

    // Helper functions inside socket context
    async function sendLobbyData(sock) {
        const ist = getIST();
        const [rooms] = await pool.query("SELECT r.id, r.status, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id");
        const [me] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [currentUser]);
        const [uData] = await pool.query("SELECT credits, last_daily_claim, ad_claims_today, last_ad_claim_time, last_ad_claim_date, ad2_claims_today, last_ad2_claim_time, last_ad2_claim_date FROM users WHERE tg_id = ?", [currentUser]);
        
        sock.emit('lobby_data', {
            rooms, 
            current_room: me.length ? me[0].room_id : null,
            user_data: uData[0],
            server_date: ist.dateStr,
            server_time: ist.timeStr
        });
    }
});

// ==========================================
// 5. GLOBAL TIMING & GAME LOOP
// ==========================================
async function endRound(room_id, winner_id = null) {
    const [room] = await pool.query("SELECT current_drawer_id, word_to_draw FROM rooms WHERE id = ?", [room_id]);
    if (!room.length) return;

    let nextDrawer = winner_id;
    if (!nextDrawer) {
        const [rand] = await pool.query("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, join_time ASC, RAND() LIMIT 1", [room_id]);
        nextDrawer = rand.length ? rand[0].user_id : room[0].current_drawer_id;
    }

    let [mem] = await pool.query("SELECT consecutive_turns FROM room_members WHERE room_id = ? AND user_id = ?", [room_id, room[0].current_drawer_id]);
    let cons = mem.length ? mem[0].consecutive_turns : 0;
    
    if (nextDrawer === room[0].current_drawer_id) cons++; else cons = 1;

    let sysMsg = null;
    if (cons > 3) {
        const [rand] = await pool.query("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, join_time ASC, RAND() LIMIT 1", [room_id]);
        nextDrawer = rand.length ? rand[0].user_id : room[0].current_drawer_id;
        cons = 1;
        sysMsg = `✏️ Drawer reached max 3 turns! Changing drawer.`;
    }

    await pool.query("UPDATE room_members SET consecutive_turns = 0 WHERE room_id = ?", [room_id]);
    await pool.query("UPDATE room_members SET consecutive_turns = ?, is_ready = 0 WHERE room_id = ? AND user_id = ?", [cons, room_id, nextDrawer]);
    
    if (sysMsg) {
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', ?)", [room_id, sysMsg]);
    }

    const ist = getIST();
    const breakEnd = new Date(new Date(ist.timeStr).getTime() + 5000);
    const breakStr = `${breakEnd.getFullYear()}-${String(breakEnd.getMonth()+1).padStart(2,'0')}-${String(breakEnd.getDate()).padStart(2,'0')} ${String(breakEnd.getHours()).padStart(2,'0')}:${String(breakEnd.getMinutes()).padStart(2,'0')}:${String(breakEnd.getSeconds()).padStart(2,'0')}`;

    await pool.query("UPDATE rooms SET status='REVEAL', break_end_time=?, last_winner_id=?, next_drawer_id=? WHERE id=?", [breakStr, winner_id, nextDrawer, room_id]);
}

setInterval(async () => {
    try {
        const ist = getIST();
        const nowStr = ist.timeStr;

        // 1. Check Room States
        const [rooms] = await pool.query("SELECT * FROM rooms WHERE status != 'WAITING'");
        for (let r of rooms) {
            let changed = false;
            const [members] = await pool.query("SELECT * FROM room_members WHERE room_id = ?", [r.id]);
            
            // Drawer left logic
            if (['PRE_DRAW', 'DRAWING'].includes(r.status) && !members.find(m => m.user_id === r.current_drawer_id)) {
                await pool.query("UPDATE rooms SET status='WAITING', current_drawer_id=NULL, word_to_draw=NULL WHERE id=?", [r.id]);
                await pool.query("UPDATE room_members SET is_ready=0 WHERE room_id=?", [r.id]);
                await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', '⚠️ Drawer left! Resetting.')", [r.id]);
                changed = true;
            }
            // End Round logic
            else if (r.status === 'DRAWING' && r.round_end_time) {
                if (new Date(r.round_end_time).getTime() <= new Date(nowStr).getTime()) {
                    await endRound(r.id);
                    changed = true;
                }
            }
            // Reveal -> Break
            else if (r.status === 'REVEAL' && r.break_end_time) {
                if (new Date(r.break_end_time).getTime() <= new Date(nowStr).getTime()) {
                    const breakEnd = new Date(new Date(nowStr).getTime() + 600000); // 10 min AFK timeout
                    const breakStr = `${breakEnd.getFullYear()}-${String(breakEnd.getMonth()+1).padStart(2,'0')}-${String(breakEnd.getDate()).padStart(2,'0')} ${String(breakEnd.getHours()).padStart(2,'0')}:${String(breakEnd.getMinutes()).padStart(2,'0')}:${String(breakEnd.getSeconds()).padStart(2,'0')}`;
                    await pool.query("UPDATE rooms SET status='BREAK', break_end_time=? WHERE id=?", [breakStr, r.id]);
                    changed = true;
                }
            }
            // Ready check
            if (['WAITING', 'BREAK', 'REVEAL'].includes(r.status) && members.length >= 2 && members.every(m => m.is_ready === 1)) {
                let nextDrawer = r.next_drawer_id || r.current_drawer_id;
                if (!nextDrawer || r.status === 'WAITING') {
                    const [rand] = await pool.query("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, join_time ASC, RAND() LIMIT 1", [r.id]);
                    nextDrawer = rand[0].user_id;
                }
                await pool.query("UPDATE room_members SET is_ready=0, total_turns=total_turns+1 WHERE room_id=?", [r.id]);
                await pool.query("UPDATE rooms SET status='PRE_DRAW', current_drawer_id=?, word_to_draw=NULL WHERE id=?", [nextDrawer, r.id]);
                await pool.query("DELETE FROM guesses WHERE room_id=?", [r.id]);
                changed = true;
            }
            // Not enough players
            if (members.length < 2 && r.status !== 'WAITING') {
                await pool.query("UPDATE rooms SET status='WAITING', current_drawer_id=NULL WHERE id=?", [r.id]);
                await pool.query("UPDATE room_members SET is_ready=0 WHERE room_id=?", [r.id]);
                changed = true;
            }

            if (changed) io.to(r.id.toString()).emit('room_updated');
        }

        // 2. Billing & Call Cleanup
        await pool.query(`UPDATE calls SET status='ENDED' WHERE status IN ('RINGING','ACTIVE') AND TIMESTAMPDIFF(SECOND, created_at, NOW()) > 60 AND status='RINGING'`);
        
        await pool.query(`UPDATE users u JOIN calls c ON u.tg_id = c.caller_id 
            SET u.credits = u.credits - 1, c.last_billed_at = NOW() 
            WHERE c.status='ACTIVE' AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 AND u.credits >= 1`);
        
        await pool.query(`UPDATE calls c JOIN users u ON u.tg_id = c.caller_id 
            SET c.status = 'ENDED' WHERE c.status='ACTIVE' AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 AND u.credits < 1`);

    } catch (e) { console.error("Game Loop Error:", e); }
}, 1000);

// Broadcaster Loop (Sync Room States)
setInterval(async () => {
    try {
        const [rooms] = await pool.query("SELECT id FROM rooms");
        for (let r of rooms) {
            const room_id = r.id;
            const socks = await io.in(room_id.toString()).fetchSockets();
            if (socks.length === 0) continue;

            const [roomData] = await pool.query("SELECT * FROM rooms WHERE id = ?", [room_id]);
            const [members] = await pool.query("SELECT * FROM room_members WHERE room_id = ?", [room_id]);
            const [chats] = await pool.query("SELECT * FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 20", [room_id]);
            const [guesses] = await pool.query("SELECT * FROM guesses WHERE room_id = ? ORDER BY created_at ASC", [room_id]);
            const [drawings] = await pool.query("SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC", [room_id]);
            const [calls] = await pool.query("SELECT id, caller_id, receiver_id, status FROM calls WHERE room_id = ? AND status IN ('RINGING', 'ACTIVE')", [room_id]);
            
            // Masking guesses for non-drawers unless reveal phase
            const isReveal = ['REVEAL', 'BREAK'].includes(roomData[0].status);
            
            let userIds = members.map(m => m.user_id).concat(guesses.map(g => g.user_id)).concat(chats.filter(c=>c.user_id!=='System').map(c=>c.user_id));
            if(roomData[0].current_drawer_id) userIds.push(roomData[0].current_drawer_id);
            if(roomData[0].last_winner_id) userIds.push(roomData[0].last_winner_id);
            userIds = [...new Set(userIds.filter(Boolean))];
            
            let profiles = {};
            if (userIds.length > 0) {
                const [profRows] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (${userIds.map(()=>'?').join(',')})`, userIds);
                profRows.forEach(p => profiles[p.tg_id] = p.profile_pic);
            }

            const ist = getIST();
            
            // Prepare payload
            const payload = {
                room: roomData[0],
                members,
                drawings: drawings.map(d => d.line_data),
                chats: chats.reverse(),
                guesses,
                profiles,
                calls,
                server_time: ist.timeStr,
                isReveal
            };

            // Send to each socket, adjusting masks
            for (let s of socks) {
                const tg_id = Object.keys(activeUsers).find(key => activeUsers[key] === s.id);
                if (!tg_id) continue;
                
                const customPayload = JSON.parse(JSON.stringify(payload)); // Deep copy
                const isDrawer = roomData[0].current_drawer_id === tg_id;
                
                customPayload.guesses.forEach(g => {
                    if (!isReveal && !isDrawer && g.user_id !== tg_id) {
                        g.guess_text = '••••••••';
                        g.is_blurred = true;
                    }
                });
                
                // Add hint generator
                if (roomData[0].word_to_draw) {
                    if (isDrawer || isReveal) {
                        customPayload.room.hint = roomData[0].word_to_draw;
                    } else {
                        // Simple hint obscuring
                        let hint = roomData[0].word_to_draw.replace(/[a-zA-Z]/g, '_ ');
                        customPayload.room.hint = hint.trim();
                    }
                }
                
                s.emit('sync_state', customPayload);
            }
        }
    } catch(e) { console.error("Broadcaster Error:", e); }
}, 1500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
