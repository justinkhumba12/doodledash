const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection
let db;
async function initDB() {
    // Railway provides MYSQL_URL automatically. Fallback for local testing.
    const dbUrl = process.env.MYSQL_URL || 'mysql://root:dKIKDNsnObjDvJlZawBHjzaEsoetaATX@mysql.railway.internal:3306/railway';
    try {
        db = await mysql.createConnection(dbUrl);
        console.log('Connected to MySQL Database.');

        // Auto-create Tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                tg_id VARCHAR(50) PRIMARY KEY,
                credits INT DEFAULT 0,
                last_daily_claim DATE,
                ad_claims_today INT DEFAULT 0,
                last_ad_claim_date DATE,
                last_ad_claim_time DATETIME,
                ad2_claims_today INT DEFAULT 0,
                last_ad2_claim_date DATE,
                last_ad2_claim_time DATETIME,
                profile_pic VARCHAR(255),
                last_active DATETIME
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status VARCHAR(20) DEFAULT 'WAITING',
                current_drawer_id VARCHAR(50),
                word_to_draw VARCHAR(50),
                round_end_time DATETIME,
                break_end_time DATETIME,
                last_winner_id VARCHAR(50),
                next_drawer_id VARCHAR(50),
                modified_at DATETIME
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                room_id INT,
                user_id VARCHAR(50),
                is_ready BOOLEAN DEFAULT FALSE,
                consecutive_turns INT DEFAULT 0,
                total_turns INT DEFAULT 0,
                PRIMARY KEY(room_id, user_id)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                line_data LONGTEXT
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                guess_text VARCHAR(50),
                is_correct BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Ensure at least a few empty rooms exist
        const [rooms] = await db.query('SELECT COUNT(*) as count FROM rooms');
        if (rooms[0].count === 0) {
            for (let i = 0; i < 5; i++) {
                await db.query(`INSERT INTO rooms (status, modified_at) VALUES ('WAITING', NOW())`);
            }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

// Telegram Webhook Endpoint
app.post('/webhook', async (req, res) => {
    const update = req.body;
    if (update?.message?.text === '/start') {
        const chatId = update.message.chat.id;
        const tgId = update.message.from.id;
        
        // Auto-register user
        try {
            await db.query('INSERT IGNORE INTO users (tg_id, credits) VALUES (?, 5)', [tgId.toString()]);
        } catch (e) {}

        const token = process.env.BOT_TOKEN; // Set this in Railway Variables
        const webAppUrl = process.env.WEBAPP_URL; // Set this in Railway Variables
        
        if (token && webAppUrl) {
            // Simple reply via Telegram API
            fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: 'Welcome to DoodleDash! Click below to play.',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: webAppUrl } }]]
                    }
                })
            }).catch(console.error);
        }
    }
    res.sendStatus(200);
});

// In-Memory Call Management for WebRTC
const activeCalls = new Map(); 

// WebSockets Game Engine
io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;

    // Helper: Broadcast room state
    const syncRoom = async (roomId) => {
        if (!roomId) return;
        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        const [members] = await db.query('SELECT * FROM room_members WHERE room_id = ?', [roomId]);
        const [chats] = await db.query('SELECT * FROM chats WHERE room_id = ? ORDER BY id DESC LIMIT 20', [roomId]);
        const [guesses] = await db.query('SELECT * FROM guesses WHERE room_id = ? ORDER BY id ASC', [roomId]);
        const [drawings] = await db.query('SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC', [roomId]);
        
        // Fetch profiles
        const userIds = [...new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)])];
        let profiles = {};
        if (userIds.length > 0) {
            const [users] = await db.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (?)`, [userIds]);
            users.forEach(u => profiles[u.tg_id] = u.profile_pic);
        }

        io.to(`room_${roomId}`).emit('room_sync', {
            room: roomData[0],
            members,
            chats: chats.reverse(),
            guesses,
            drawings: drawings.map(d => d.line_data),
            profiles,
            server_time: new Date()
        });
    };

    socket.on('auth', async ({ tg_id, profile_pic }) => {
        if (!tg_id) return;
        currentUser = tg_id;
        
        // Auto-register without security check (as requested)
        await db.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, NOW())`, [tg_id]);
        if (profile_pic) {
            await db.query(`UPDATE users SET profile_pic = ?, last_active = NOW() WHERE tg_id = ?`, [profile_pic, tg_id]);
        } else {
            await db.query(`UPDATE users SET last_active = NOW() WHERE tg_id = ?`, [tg_id]);
        }

        const [userData] = await db.query('SELECT * FROM users WHERE tg_id = ?', [tg_id]);
        const [rooms] = await db.query('SELECT r.id, r.status, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
        
        // Check if user is already in a room
        const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
        if (existing.length > 0) {
            currentRoom = existing[0].room_id;
            socket.join(`room_${currentRoom}`);
            syncRoom(currentRoom);
        }

        socket.emit('lobby_data', { user: userData[0], rooms, currentRoom });
    });

    socket.on('claim_reward', async ({ type }) => {
        if (!currentUser) return;
        const [user] = await db.query('SELECT * FROM users WHERE tg_id = ?', [currentUser]);
        const today = new Date().toISOString().split('T')[0];
        
        if (type === 'daily' && user[0].last_daily_claim !== today) {
            await db.query('UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?', [today, currentUser]);
        } else if (type === 'ad1' && user[0].ad_claims_today < 2) {
            await db.query('UPDATE users SET credits = credits + 2, ad_claims_today = ad_claims_today + 1, last_ad_claim_date = ?, last_ad_claim_time = NOW() WHERE tg_id = ?', [today, currentUser]);
        }
        
        const [updatedUser] = await db.query('SELECT * FROM users WHERE tg_id = ?', [currentUser]);
        socket.emit('user_update', updatedUser[0]);
    });

    socket.on('join_room', async ({ room_id }) => {
        if (!currentUser) return;
        const [members] = await db.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [room_id]);
        if (members[0].count >= 4) return socket.emit('error', 'Room is full');

        await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]); // Leave old
        if (currentRoom) socket.leave(`room_${currentRoom}`);

        await db.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [room_id, currentUser]);
        currentRoom = room_id;
        socket.join(`room_${currentRoom}`);
        syncRoom(currentRoom);
    });

    socket.on('leave_room', async () => {
        if (!currentUser || !currentRoom) return;
        await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
        socket.leave(`room_${currentRoom}`);
        syncRoom(currentRoom);
        currentRoom = null;
    });

    socket.on('chat', async ({ message }) => {
        if (!currentUser || !currentRoom || !message.trim()) return;
        await db.query('INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)', [currentRoom, currentUser, message]);
        syncRoom(currentRoom);
    });

    socket.on('guess', async ({ guess }) => {
        if (!currentUser || !currentRoom || !guess.trim()) return;
        
        const [room] = await db.query('SELECT word_to_draw FROM rooms WHERE id = ?', [currentRoom]);
        const isCorrect = room[0]?.word_to_draw?.toLowerCase() === guess.toLowerCase();
        
        await db.query('INSERT INTO guesses (room_id, user_id, guess_text, is_correct) VALUES (?, ?, ?, ?)', [currentRoom, currentUser, guess, isCorrect]);
        
        if (isCorrect) {
            // End Round logic
            await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [currentUser, currentRoom]);
        }
        syncRoom(currentRoom);
    });

    socket.on('set_word', async ({ word }) => {
        if (!currentUser || !currentRoom) return;
        await db.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = DATE_ADD(NOW(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [word, currentRoom, currentUser]);
        await db.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
        await db.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
        syncRoom(currentRoom);
    });

    socket.on('set_ready', async () => {
        if (!currentUser || !currentRoom) return;
        await db.query('UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
        syncRoom(currentRoom);
    });

    socket.on('draw', async ({ lines }) => {
        if (!currentUser || !currentRoom) return;
        await db.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [currentRoom, JSON.stringify(lines)]);
        // Real-time fast sync for drawings
        socket.to(`room_${currentRoom}`).emit('live_draw', lines);
    });

    socket.on('undo', async () => {
        if (!currentUser || !currentRoom) return;
        const [last] = await db.query('SELECT id FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1', [currentRoom]);
        if (last.length > 0) {
            await db.query('DELETE FROM drawings WHERE id = ?', [last[0].id]);
            syncRoom(currentRoom);
        }
    });

    /* --- WEBRTC SIGNALING & CALLS --- */
    socket.on('initiate_call', async ({ receiver_id }) => {
        if (!currentUser) return;
        const callId = `call_${Date.now()}_${Math.random()}`;
        activeCalls.set(callId, { id: callId, caller: currentUser, receiver: receiver_id, status: 'RINGING' });
        
        // Notify the whole room so the receiver sees the UI
        io.to(`room_${currentRoom}`).emit('call_update', activeCalls.get(callId));
    });

    socket.on('accept_call', ({ call_id }) => {
        const call = activeCalls.get(call_id);
        if (call && call.receiver === currentUser) {
            call.status = 'ACTIVE';
            call.startTime = Date.now();
            activeCalls.set(call_id, call);
            io.to(`room_${currentRoom}`).emit('call_update', call);
        }
    });

    socket.on('end_call', ({ call_id }) => {
        if (activeCalls.has(call_id)) {
            activeCalls.delete(call_id);
            io.to(`room_${currentRoom}`).emit('call_ended', call_id);
        }
    });

    socket.on('webrtc_signal', ({ call_id, target_id, signal }) => {
        // Broadcast the signal to the room; the target client will filter it
        socket.to(`room_${currentRoom}`).emit('webrtc_signal_receive', { call_id, sender_id: currentUser, target_id, signal });
    });

    socket.on('disconnect', async () => {
        if (currentUser && currentRoom) {
            // Remove user if they disconnect completely
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            syncRoom(currentRoom);
        }
    });
});

// Server Game Loop (Checks timers and advances game states)
setInterval(async () => {
    try {
        const [rooms] = await db.query("SELECT * FROM rooms WHERE status IN ('DRAWING', 'REVEAL', 'BREAK')");
        for (let r of rooms) {
            const now = new Date();
            if (r.status === 'DRAWING' && new Date(r.round_end_time) <= now) {
                await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND) WHERE id = ?", [r.id]);
                io.to(`room_${r.id}`).emit('trigger_sync'); // Ask clients to request sync
            } else if (r.status === 'REVEAL' && new Date(r.break_end_time) <= now) {
                await db.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(NOW(), INTERVAL 600 SECOND) WHERE id = ?", [r.id]);
                io.to(`room_${r.id}`).emit('trigger_sync');
            }
        }

        // Auto-assign drawers for rooms that are ready
        const [waitingRooms] = await db.query("SELECT * FROM rooms WHERE status IN ('WAITING', 'BREAK')");
        for (let r of waitingRooms) {
            const [members] = await db.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [r.id]);
            if (members.length >= 2 && members.every(m => m.is_ready)) {
                const nextDrawer = members[Math.floor(Math.random() * members.length)].user_id;
                await db.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?", [nextDrawer, r.id]);
                await db.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                await db.query("DELETE FROM guesses WHERE room_id = ?", [r.id]);
                io.to(`room_${r.id}`).emit('trigger_sync');
            }
        }
    } catch (e) { console.error("Game Loop Error:", e); }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
