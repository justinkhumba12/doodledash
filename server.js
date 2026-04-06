require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

// Setup Express & Server
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Configuration
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql.railway.internal',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'YxrnEnvqSaQJzGNwXucGSQstZLsDxeGl',
    database: process.env.DB_NAME || 'railway',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+05:30' // Enforce IST globally
});

const BOT_TOKEN = process.env.BOT_TOKEN || '8370801985:AAH42vuVLp_XnP3G3wE6PdytYHj39lXacFE';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://doodledash-production-06af.up.railway.app';

// Track connected users (tg_id -> socket.id)
const activeUsers = new Map();

// ==========================================
// 1. AUTO-CREATE TABLES (From Images)
// ==========================================
async function initDB() {
    try {
        console.log("Checking and generating tables...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tg_id VARCHAR(50) UNIQUE,
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                profile_pic VARCHAR(500),
                credits INT DEFAULT 0,
                last_daily_claim DATE NULL,
                ad_claims_today INT DEFAULT 0,
                last_ad_claim_time DATETIME NULL,
                last_ad_claim_date DATE NULL,
                last_notified_date DATE NULL,
                ad2_claims_today INT DEFAULT 0,
                last_ad2_claim_time DATETIME NULL,
                last_ad2_claim_date DATE NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status ENUM('WAITING', 'PRE_DRAW', 'DRAWING', 'REVEAL', 'BREAK') DEFAULT 'WAITING',
                current_drawer_id VARCHAR(50) NULL,
                word_to_draw VARCHAR(30) NULL,
                round_end_time DATETIME NULL,
                break_end_time DATETIME NULL,
                last_winner_id VARCHAR(50) NULL,
                next_drawer_id VARCHAR(50) NULL,
                modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                room_id INT,
                user_id VARCHAR(50),
                is_ready TINYINT(1) DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                consecutive_turns INT DEFAULT 0,
                total_turns INT DEFAULT 0,
                join_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (room_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                line_data LONGTEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                guess_text VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                caller_id VARCHAR(255),
                receiver_id VARCHAR(255),
                status ENUM('RINGING', 'ACTIVE', 'ENDED', 'DECLINED', 'MISSED') DEFAULT 'RINGING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP NULL,
                last_billed_at TIMESTAMP NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS webrtc_signals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                call_id INT,
                sender_id VARCHAR(255),
                receiver_id VARCHAR(255),
                type VARCHAR(50),
                payload TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);
        console.log("Database schema successfully verified!");
    } catch (e) {
        console.error("Failed to init DB:", e);
    }
}
initDB();

// ==========================================
// 2. WEBSOCKET HANDLERS (Core Logic)
// ==========================================

io.on('connection', (socket) => {
    
    // Auth & Register
    socket.on('authenticate', async (data, callback) => {
        try {
            const { tg_id, photo_url } = data;
            if (!tg_id) return callback({ error: 'Missing TG ID' });
            
            socket.tg_id = String(tg_id);
            activeUsers.set(socket.tg_id, socket.id);
            
            // Register or update active
            await pool.query(`INSERT IGNORE INTO users (tg_id) VALUES (?)`, [tg_id]);
            if (photo_url) {
                await pool.query(`UPDATE users SET last_active = NOW(), profile_pic = ? WHERE tg_id = ?`, [photo_url, tg_id]);
            } else {
                await pool.query(`UPDATE users SET last_active = NOW() WHERE tg_id = ?`, [tg_id]);
            }
            
            callback({ success: true });
        } catch (e) {
            callback({ error: 'Server Error' });
        }
    });

    // Send Home Page Room Data
    socket.on('get_lobby', async (callback) => {
        if(!socket.tg_id) return callback({error: 'Not authenticated'});
        const [rooms] = await pool.query(`
            SELECT r.id, r.status, COUNT(rm.user_id) as member_count 
            FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id 
            GROUP BY r.id
        `);
        const [[userData]] = await pool.query(`SELECT credits, last_daily_claim, ad_claims_today, last_ad_claim_time, last_ad_claim_date, ad2_claims_today, last_ad2_claim_time, last_ad2_claim_date FROM users WHERE tg_id = ?`, [socket.tg_id]);
        const [[{curr}]] = await pool.query(`SELECT room_id as curr FROM room_members WHERE user_id = ?`, [socket.tg_id]);
        
        // Return UTC string equivalent to server's IST for front-end parsing
        const dateNow = new Date();
        callback({
            rooms: rooms || [],
            user_data: userData || {},
            current_room: curr || null,
            server_time: dateNow.toISOString(),
            server_date: dateNow.toISOString().split('T')[0]
        });
    });

    // Create Room
    socket.on('create_room', async (callback) => {
        const [[{count}]] = await pool.query(`SELECT COUNT(*) as count FROM rooms`);
        if (count >= 10) return callback({ success: false, message: 'Max 10 global rooms reached.' });
        
        const [[{credits}]] = await pool.query(`SELECT credits FROM users WHERE tg_id = ?`, [socket.tg_id]);
        if (credits < 1) return callback({ success: false, message: 'Not enough credits (1 required).' });

        await pool.query(`UPDATE users SET credits = credits - 1 WHERE tg_id = ?`, [socket.tg_id]);
        const [result] = await pool.query(`INSERT INTO rooms (status) VALUES ('WAITING')`);
        
        callback({ success: true, room_id: result.insertId });
    });

    // Join Room
    socket.on('join_room', async (roomId, callback) => {
        roomId = parseInt(roomId);
        const [[{inRoom}]] = await pool.query(`SELECT room_id as inRoom FROM room_members WHERE user_id = ?`, [socket.tg_id]);
        if (inRoom && inRoom !== roomId) return callback({ success: false, message: 'Leave your current room first.' });
        
        const [[{memCount}]] = await pool.query(`SELECT COUNT(*) as memCount FROM room_members WHERE room_id = ?`, [roomId]);
        if (memCount >= 4 && !inRoom) return callback({ success: false, message: 'Room is full.' });

        if (!inRoom) {
            await pool.query(`INSERT INTO room_members (room_id, user_id) VALUES (?, ?)`, [roomId, socket.tg_id]);
        }
        
        socket.join(`room_${roomId}`);
        socket.currentRoom = roomId;
        broadcastRoomSync(roomId);
        callback({ success: true });
    });

    // Leave Room
    socket.on('leave_room', async (callback) => {
        const roomId = socket.currentRoom;
        if(roomId) {
            await pool.query(`DELETE FROM room_members WHERE user_id = ?`, [socket.tg_id]);
            await pool.query(`UPDATE calls SET status = 'ENDED' WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)`, [socket.tg_id, socket.tg_id]);
            socket.leave(`room_${roomId}`);
            socket.currentRoom = null;
            broadcastRoomSync(roomId);
        }
        if(callback) callback({ success: true });
    });

    // Chat
    socket.on('chat', async (msgStr) => {
        const roomId = socket.currentRoom;
        if(!roomId || !msgStr.trim()) return;
        await pool.query(`INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)`, [roomId, socket.tg_id, msgStr.substring(0,200)]);
        broadcastRoomSync(roomId);
    });

    // Set Ready
    socket.on('set_ready', async () => {
        const roomId = socket.currentRoom;
        if(!roomId) return;
        await pool.query(`UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?`, [roomId, socket.tg_id]);
        broadcastRoomSync(roomId);
    });

    // Set Word
    socket.on('set_word', async (word, callback) => {
        const roomId = socket.currentRoom;
        if(!roomId || !word || word.length < 3) return callback({success:false});
        
        // Set end time 120s from now
        const endTime = new Date(Date.now() + 120000).toISOString().slice(0, 19).replace('T', ' ');
        await pool.query(`UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = ? WHERE id = ? AND current_drawer_id = ?`, 
            [word, endTime, roomId, socket.tg_id]);
        await pool.query(`DELETE FROM drawings WHERE room_id = ?`, [roomId]);
        await pool.query(`DELETE FROM guesses WHERE room_id = ?`, [roomId]);
        
        broadcastRoomSync(roomId);
        callback({success:true});
    });

    // Draw lines (Fast WebSocket Emit)
    socket.on('draw_lines', async (linesJson) => {
        const roomId = socket.currentRoom;
        if(!roomId) return;
        
        // Broadcast immediately to others for smooth drawing
        socket.to(`room_${roomId}`).emit('new_draw_lines', linesJson);
        
        // Save to DB
        await pool.query(`INSERT INTO drawings (room_id, line_data) VALUES (?, ?)`, [roomId, linesJson]);
    });

    // Undo Draw
    socket.on('undo_draw', async (callback) => {
        const roomId = socket.currentRoom;
        if(!roomId) return;
        const [rows] = await pool.query(`SELECT id, line_data FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1`, [roomId]);
        if(rows.length > 0) {
            await pool.query(`DELETE FROM drawings WHERE id = ?`, [rows[0].id]);
            broadcastRoomSync(roomId);
            callback({ success: true, line_data: rows[0].line_data });
        } else {
            callback({ success: false });
        }
    });

    // Guess
    socket.on('guess', async (guessText, callback) => {
        const roomId = socket.currentRoom;
        if(!roomId || !guessText) return;
        
        const [[{c}]] = await pool.query(`SELECT COUNT(*) as c FROM guesses WHERE room_id = ? AND user_id = ?`, [roomId, socket.tg_id]);
        if (c >= 5) {
            const [[{credits}]] = await pool.query(`SELECT credits FROM users WHERE tg_id = ?`, [socket.tg_id]);
            if (credits < 1) return callback({success: false, message: 'Max 5 free guesses reached. Need 1 credit for more.'});
            await pool.query(`UPDATE users SET credits = credits - 1 WHERE tg_id = ?`, [socket.tg_id]);
        }
        
        await pool.query(`INSERT INTO guesses (room_id, user_id, guess_text) VALUES (?, ?, ?)`, [roomId, socket.tg_id, guessText]);
        
        // Check for Win
        const [[room]] = await pool.query(`SELECT word_to_draw FROM rooms WHERE id = ?`, [roomId]);
        if (room && room.word_to_draw && guessText.toLowerCase() === room.word_to_draw.toLowerCase()) {
            await endRound(roomId, socket.tg_id, room.word_to_draw);
        }
        
        broadcastRoomSync(roomId);
        callback({success:true});
    });

    // Voice Call Logic
    socket.on('initiate_call', async (targetId, callback) => {
        const roomId = socket.currentRoom;
        const [[{credits}]] = await pool.query(`SELECT credits FROM users WHERE tg_id = ?`, [socket.tg_id]);
        if(credits < 1) return callback({success:false, message: 'Need 1 credit to call.'});
        
        await pool.query(`INSERT INTO calls (room_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'RINGING')`, [roomId, socket.tg_id, targetId]);
        broadcastRoomSync(roomId);
        callback({success:true});
    });

    socket.on('accept_call', async (callId) => {
        await pool.query(`UPDATE calls SET status = 'ACTIVE', started_at = NOW(), last_billed_at = NOW() WHERE id = ?`, [callId]);
        broadcastRoomSync(socket.currentRoom);
    });

    socket.on('decline_call', async (callId) => {
        await pool.query(`UPDATE calls SET status = 'DECLINED' WHERE id = ?`, [callId]);
        broadcastRoomSync(socket.currentRoom);
    });

    socket.on('end_call', async (callId) => {
        await pool.query(`UPDATE calls SET status = 'ENDED' WHERE id = ?`, [callId]);
        await pool.query(`DELETE FROM webrtc_signals WHERE call_id = ?`, [callId]);
        broadcastRoomSync(socket.currentRoom);
    });

    // Direct WebRTC Signaling (Faster than polling DB)
    socket.on('webrtc_signal', async (data) => {
        const { call_id, receiver_id, type, payload } = data;
        await pool.query(`INSERT INTO webrtc_signals (call_id, sender_id, receiver_id, type, payload) VALUES (?, ?, ?, ?, ?)`, 
            [call_id, socket.tg_id, receiver_id, type, payload]);
        
        const targetSocketId = activeUsers.get(String(receiver_id));
        if(targetSocketId) {
            io.to(targetSocketId).emit('webrtc_signal', {
                sender_id: socket.tg_id,
                type,
                payload: JSON.parse(payload)
            });
        }
    });

    socket.on('disconnect', () => {
        if(socket.tg_id) activeUsers.delete(socket.tg_id);
    });
});

// ==========================================
// 3. GLOBAL TIMING & GAME LOOP
// ==========================================

// Global state sync mechanism
async function broadcastRoomSync(roomId) {
    if(!roomId) return;
    try {
        const [[room]] = await pool.query(`SELECT * FROM rooms WHERE id = ?`, [roomId]);
        if (!room) return;

        const [members] = await pool.query(`SELECT user_id, is_ready, consecutive_turns, total_turns FROM room_members WHERE room_id = ?`, [roomId]);
        const [chats] = await pool.query(`SELECT id, user_id, message, created_at FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 20`, [roomId]);
        const [guesses] = await pool.query(`SELECT id, user_id, guess_text, created_at FROM guesses WHERE room_id = ? ORDER BY created_at ASC`, [roomId]);
        const [drawings] = await pool.query(`SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC`, [roomId]);
        const [calls] = await pool.query(`SELECT id, caller_id, receiver_id, status FROM calls WHERE room_id = ? AND status IN ('RINGING', 'ACTIVE')`, [roomId]);
        
        let userIds = new Set(members.map(m => m.user_id));
        chats.forEach(c => c.user_id !== 'System' && userIds.add(c.user_id));
        guesses.forEach(g => userIds.add(g.user_id));
        if(room.last_winner_id) userIds.add(room.last_winner_id);
        if(room.current_drawer_id) userIds.add(room.current_drawer_id);

        let profiles = {};
        if(userIds.size > 0) {
            const arr = Array.from(userIds);
            const placeholders = arr.map(() => '?').join(',');
            const [profs] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (${placeholders})`, arr);
            profs.forEach(p => profiles[p.tg_id] = p.profile_pic);
        }

        // Emit to all connected sockets in this room
        io.to(`room_${roomId}`).emit('sync', {
            room,
            members,
            chats: chats.reverse(),
            guesses,
            drawings: drawings.map(d => d.line_data),
            profiles,
            calls,
            server_time: new Date().toISOString()
        });
    } catch(e) {
        console.error("Sync error:", e);
    }
}

// Win/End Round Logic
async function endRound(roomId, winnerId, word) {
    let nextDrawer = winnerId;
    
    if(!winnerId) {
        // Fallback: Pick random member with lowest total_turns
        const [mems] = await pool.query(`SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, join_time ASC LIMIT 1`, [roomId]);
        if(mems.length > 0) nextDrawer = mems[0].user_id;
    }

    const [[room]] = await pool.query(`SELECT current_drawer_id FROM rooms WHERE id = ?`, [roomId]);
    const [[mem]] = await pool.query(`SELECT consecutive_turns FROM room_members WHERE room_id = ? AND user_id = ?`, [roomId, room.current_drawer_id]);
    
    let currentConsecutive = (mem ? mem.consecutive_turns : 0);
    if (nextDrawer === room.current_drawer_id) {
        currentConsecutive++;
    } else {
        currentConsecutive = 1;
    }

    if (currentConsecutive > 3) {
        const [mems] = await pool.query(`SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC LIMIT 1`, [roomId]);
        nextDrawer = mems.length > 0 ? mems[0].user_id : nextDrawer;
        currentConsecutive = 1;
        await pool.query(`INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', '✏️ Drawer reached max 3 turns! Changing drawer.')`, [roomId]);
    }

    await pool.query(`UPDATE room_members SET consecutive_turns = 0 WHERE room_id = ?`, [roomId]);
    await pool.query(`UPDATE room_members SET consecutive_turns = ? WHERE room_id = ? AND user_id = ?`, [currentConsecutive, roomId, nextDrawer]);
    await pool.query(`UPDATE room_members SET is_ready = 0 WHERE room_id = ?`, [roomId]);

    const breakTime = new Date(Date.now() + 5000).toISOString().slice(0, 19).replace('T', ' '); // 5 sec break
    await pool.query(`UPDATE rooms SET status = 'REVEAL', break_end_time = ?, last_winner_id = ?, next_drawer_id = ? WHERE id = ?`, 
        [breakTime, winnerId || null, nextDrawer, roomId]);
}

// Master Global Game Tick (Every 1 Second)
setInterval(async () => {
    try {
        const [rooms] = await pool.query(`SELECT * FROM rooms`);
        const now = new Date();

        for(let r of rooms) {
            let changed = false;
            const [[{count}]] = await pool.query(`SELECT COUNT(*) as count FROM room_members WHERE room_id = ?`, [r.id]);
            
            // Auto close empty rooms
            if (count < 2 && r.status !== 'WAITING') {
                await pool.query(`UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?`, [r.id]);
                await pool.query(`UPDATE room_members SET is_ready = 0 WHERE room_id = ?`, [r.id]);
                changed = true;
            }

            // Logic to move from WAITING -> PRE_DRAW if all ready
            if (r.status === 'WAITING' && count >= 2) {
                const [[{readyCount}]] = await pool.query(`SELECT COUNT(*) as readyCount FROM room_members WHERE room_id = ? AND is_ready = 1`, [r.id]);
                if (readyCount === count) {
                    const [mems] = await pool.query(`SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC LIMIT 1`, [r.id]);
                    const drawer = mems[0].user_id;
                    await pool.query(`UPDATE room_members SET is_ready = 0, total_turns = total_turns + 1 WHERE room_id = ?`, [r.id]);
                    await pool.query(`UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?`, [drawer, r.id]);
                    await pool.query(`DELETE FROM guesses WHERE room_id = ?`, [r.id]);
                    changed = true;
                }
            }

            // Timers Logic
            if (r.status === 'DRAWING' && r.round_end_time) {
                if (now >= new Date(r.round_end_time)) {
                    await endRound(r.id, null, r.word_to_draw);
                    changed = true;
                }
            }
            if (r.status === 'REVEAL' && r.break_end_time) {
                if (now >= new Date(r.break_end_time)) {
                    // Set up 10 min break max until players ready up
                    const breakEnd = new Date(Date.now() + 600000).toISOString().slice(0, 19).replace('T', ' ');
                    await pool.query(`UPDATE rooms SET status = 'BREAK', break_end_time = ? WHERE id = ?`, [breakEnd, r.id]);
                    changed = true;
                }
            }
            
            // Check BREAK to PRE_DRAW
            if (r.status === 'BREAK' || r.status === 'REVEAL') {
                const [[{readyCount}]] = await pool.query(`SELECT COUNT(*) as readyCount FROM room_members WHERE room_id = ? AND is_ready = 1`, [r.id]);
                if (readyCount === count && count >= 2) {
                    const nextDrawer = r.next_drawer_id || r.current_drawer_id;
                    await pool.query(`UPDATE room_members SET is_ready = 0 WHERE room_id = ?`, [r.id]);
                    await pool.query(`UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?`, [nextDrawer, r.id]);
                    await pool.query(`DELETE FROM guesses WHERE room_id = ?`, [r.id]);
                    changed = true;
                }
            }

            // Voice Call Billing (1 credit every 120 sec)
            await pool.query(`
                UPDATE users u JOIN calls c ON u.tg_id = c.caller_id 
                SET u.credits = u.credits - 1, c.last_billed_at = NOW() 
                WHERE c.status = 'ACTIVE' AND c.room_id = ? 
                AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 
                AND u.credits >= 1
            `, [r.id]);
            
            // End calls out of credits
            await pool.query(`
                UPDATE calls c JOIN users u ON u.tg_id = c.caller_id 
                SET c.status = 'ENDED' 
                WHERE c.status = 'ACTIVE' AND c.room_id = ? 
                AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 
                AND u.credits < 1
            `, [r.id]);

            if (changed) broadcastRoomSync(r.id);
        }
    } catch(e) {
        console.error("Tick error:", e);
    }
}, 1000);

// Background Cron Jobs (Every 1 min)
setInterval(async () => {
    try {
        // Kick inactive
        await pool.query(`DELETE rm FROM room_members rm JOIN users u ON rm.user_id = u.tg_id WHERE u.last_active < NOW() - INTERVAL 15 SECOND`);
        // Clean old data
        await pool.query(`DELETE FROM chat_messages WHERE created_at < NOW() - INTERVAL 5 MINUTE`);
        await pool.query(`DELETE FROM guesses WHERE created_at < NOW() - INTERVAL 5 MINUTE`);
        await pool.query(`DELETE FROM drawings WHERE created_at < NOW() - INTERVAL 5 MINUTE`);
        await pool.query(`DELETE FROM rooms WHERE id NOT IN (SELECT DISTINCT room_id FROM room_members) AND modified_at < NOW() - INTERVAL 5 MINUTE`);
    } catch (e) {
        console.error("Cron Error", e);
    }
}, 60000);


// ==========================================
// 4. TELEGRAM WEBHOOK & REST ENDPOINTS
// ==========================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;
    if (update?.message?.text === '/start') {
        const tgId = update.message.from.id;
        const chatId = update.message.chat.id;
        try {
            await pool.query(`INSERT IGNORE INTO users (tg_id) VALUES (?)`, [String(tgId)]);
            const fetch = require('node-fetch');
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: 'Welcome! Click below to play DoodleDash.',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🎮 Play Draw & Guess', web_app: { url: WEB_APP_URL } }]]
                    }
                })
            });
        } catch(e) {}
    }
});

// Economy Endpoints (Standard HTTP is fine here)
app.post('/api/claim_daily', async (req, res) => {
    const { tg_id } = req.body;
    const dateToday = new Date().toISOString().split('T')[0];
    const [[user]] = await pool.query(`SELECT last_daily_claim FROM users WHERE tg_id = ?`, [tg_id]);
    
    if (user && user.last_daily_claim && user.last_daily_claim.toISOString().split('T')[0] === dateToday) {
        return res.json({success: false, message: 'Already claimed today!'});
    }
    
    await pool.query(`UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?`, [dateToday, tg_id]);
    res.json({success: true});
});

app.post('/api/claim_ad', async (req, res) => {
    const { tg_id, type } = req.body;
    const colCount = type === 'ad2' ? 'ad2_claims_today' : 'ad_claims_today';
    const colTime = type === 'ad2' ? 'last_ad2_claim_time' : 'last_ad_claim_time';
    const colDate = type === 'ad2' ? 'last_ad2_claim_date' : 'last_ad_claim_date';
    
    const dateToday = new Date().toISOString().split('T')[0];
    const [[user]] = await pool.query(`SELECT * FROM users WHERE tg_id = ?`, [tg_id]);
    
    let claimsToday = user[colDate] && user[colDate].toISOString().split('T')[0] === dateToday ? user[colCount] : 0;
    
    if (claimsToday >= 2) return res.json({success: false, message: 'Limit reached.'});
    if (claimsToday > 0 && user[colTime]) {
        if ((Date.now() - new Date(user[colTime]).getTime()) < 3 * 3600 * 1000) {
            return res.json({success: false, message: 'Cooldown active.'});
        }
    }
    
    await pool.query(`UPDATE users SET credits = credits + 2, ${colCount} = ?, ${colTime} = NOW(), ${colDate} = ? WHERE tg_id = ?`, 
        [claimsToday + 1, dateToday, tg_id]);
    res.json({success: true});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`DoodleDash Server active on port ${PORT}`);
});
