require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const { Telegraf } = require('telegraf');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 1. DATABASE CONFIG & AUTO-CREATION
// ==========================================
// On Railway, you can just use process.env.MYSQL_URL
const dbConfig = process.env.MYSQL_URL || {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'doodledash',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+05:30' // Global IST Timing
};

const pool = mysql.createPool(dbConfig);

async function initDB() {
    try {
        console.log("Checking and creating database tables...");
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT NOT NULL,
                caller_id VARCHAR(255) NOT NULL,
                receiver_id VARCHAR(255) NOT NULL,
                status ENUM('RINGING', 'ACTIVE', 'ENDED', 'DECLINED', 'MISSED') DEFAULT 'RINGING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                started_at TIMESTAMP NULL,
                last_billed_at TIMESTAMP NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT NOT NULL,
                user_id VARCHAR(50),
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT NOT NULL,
                line_data LONGTEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT NOT NULL,
                user_id VARCHAR(50),
                guess_text VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status ENUM('WAITING','PRE_DRAW','DRAWING','REVEAL','BREAK') DEFAULT 'WAITING',
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
                room_id INT NOT NULL,
                user_id VARCHAR(50) NOT NULL,
                is_ready TINYINT(1) DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                consecutive_turns INT DEFAULT 0,
                total_turns INT DEFAULT 0,
                join_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (room_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
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
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS webrtc_signals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                call_id INT NOT NULL,
                sender_id VARCHAR(50) NOT NULL,
                receiver_id VARCHAR(50) NOT NULL,
                type VARCHAR(50) NOT NULL,
                payload TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log("Database initialized successfully!");
    } catch (err) {
        console.error("Database initialization failed:", err);
    }
}

// ==========================================
// 2. TELEGRAM BOT
// ==========================================
const botToken = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const webAppUrl = process.env.WEB_APP_URL || 'https://your-railway-app-url.up.railway.app/';
const bot = new Telegraf(botToken);

bot.start(async (ctx) => {
    const tgId = String(ctx.from.id);
    try {
        await pool.query("INSERT IGNORE INTO users (tg_id) VALUES (?)", [tgId]);
        ctx.reply("Welcome to DoodleDash! 🎨\nYou are registered. Click below to play!", {
            reply_markup: {
                inline_keyboard: [[{ text: '🎮 Play Draw & Guess', web_app: { url: webAppUrl } }]]
            }
        });
    } catch (e) {
        console.error("Bot error:", e);
    }
});

bot.launch().then(() => console.log('Telegram Bot running via Long Polling'));

// ==========================================
// 3. GLOBAL GAME TIMING ENGINE
// ==========================================
// Runs every second, handles room states, timer expirations, and active call economy
setInterval(async () => {
    try {
        const now = new Date();
        
        // 1. Check DRAWING rooms that have run out of time
        let [drawingRooms] = await pool.query("SELECT * FROM rooms WHERE status = 'DRAWING' AND round_end_time <= NOW()");
        for (let room of drawingRooms) {
            await endRound(room.id, room);
        }

        // 2. Check REVEAL rooms transitioning to BREAK
        let [revealRooms] = await pool.query("SELECT * FROM rooms WHERE status = 'REVEAL' AND break_end_time <= NOW()");
        for (let room of revealRooms) {
            await pool.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(NOW(), INTERVAL 10 MINUTE), modified_at = NOW() WHERE id = ?", [room.id]);
            broadcastSync(room.id);
        }

        // 3. Bill active calls 1 credit every 120 seconds seamlessly
        await pool.query(`
            UPDATE users u 
            JOIN calls c ON u.tg_id = c.caller_id 
            SET u.credits = u.credits - 1, c.last_billed_at = NOW() 
            WHERE c.status = 'ACTIVE' 
            AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 
            AND u.credits >= 1
        `);

        // End calls if out of credits
        await pool.query(`
            UPDATE calls c 
            JOIN users u ON u.tg_id = c.caller_id 
            SET c.status = 'ENDED' 
            WHERE c.status = 'ACTIVE' 
            AND TIMESTAMPDIFF(SECOND, c.last_billed_at, NOW()) >= 120 
            AND u.credits < 1
        `);

    } catch (e) {
        console.error("Game Loop Error:", e);
    }
}, 1000);

async function endRound(roomId, room, forceNextDrawer = null) {
    let [winnerRow] = await pool.query("SELECT user_id FROM guesses WHERE room_id = ? AND LOWER(guess_text) = LOWER(?) ORDER BY created_at ASC LIMIT 1", [roomId, room.word_to_draw]);
    let winner = winnerRow.length > 0 ? winnerRow[0].user_id : null;

    let nextDrawer;
    if (forceNextDrawer) {
        nextDrawer = forceNextDrawer;
    } else if (winner) {
        nextDrawer = winner;
    } else {
        nextDrawer = await getNextDrawerByStats(roomId);
    }

    let [consecRow] = await pool.query("SELECT consecutive_turns FROM room_members WHERE room_id = ? AND user_id = ?", [roomId, room.current_drawer_id]);
    let currentConsecutive = consecRow.length > 0 ? consecRow[0].consecutive_turns : 0;

    if (nextDrawer === room.current_drawer_id) {
        currentConsecutive++;
    } else {
        currentConsecutive = 1; 
    }

    if (currentConsecutive > 3) {
        nextDrawer = await getNextDrawerByStats(roomId);
        currentConsecutive = 1;
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', ?)", [roomId, `✏️ Drawer reached max 3 consecutive turns! Changing drawer.`]);
    }

    await pool.query("UPDATE room_members SET consecutive_turns = 0 WHERE room_id = ?", [roomId]);
    if(nextDrawer) await pool.query("UPDATE room_members SET consecutive_turns = ? WHERE room_id = ? AND user_id = ?", [currentConsecutive, roomId, nextDrawer]);
    await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [roomId]);
    
    await pool.query(`
        UPDATE rooms 
        SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND), last_winner_id = ?, next_drawer_id = ?, modified_at = NOW() 
        WHERE id = ?`, 
        [winner || null, nextDrawer, roomId]
    );

    broadcastSync(roomId);
}

async function getNextDrawerByStats(roomId) {
    let [rows] = await pool.query("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, join_time ASC, RAND() LIMIT 1", [roomId]);
    return rows.length > 0 ? rows[0].user_id : null;
}

// ==========================================
// 4. WEBSOCKET HANDLERS
// ==========================================

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;

    socket.on('auth', async (data) => {
        const { tg_id, photo_url } = data;
        if (!tg_id) return;
        currentUser = String(tg_id);
        
        await pool.query("UPDATE users SET last_active = NOW() " + (photo_url ? ", profile_pic = ?" : "") + " WHERE tg_id = ?", photo_url ? [photo_url, currentUser] : [currentUser]);
        socket.emit('auth_success', { tg_id: currentUser });
    });

    socket.on('get_rooms', async () => {
        if(!currentUser) return;
        const [rooms] = await pool.query("SELECT r.id, r.status, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id");
        const [userRow] = await pool.query("SELECT * FROM users WHERE tg_id = ?", [currentUser]);
        
        socket.emit('rooms_list', {
            rooms,
            user_data: userRow[0],
            server_time: new Date().toISOString().slice(0, 19).replace('T', ' ')
        });
    });

    socket.on('join_room', async (roomId) => {
        if(!currentUser) return;
        roomId = parseInt(roomId);
        
        const [existing] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [currentUser]);
        if(existing.length > 0 && existing[0].room_id !== roomId) {
            socket.emit('alert', { message: 'Leave your current room first!', type: 'error' });
            return;
        }

        const [count] = await pool.query("SELECT COUNT(*) as c FROM room_members WHERE room_id = ?", [roomId]);
        if (count[0].c >= 4 && existing.length === 0) {
            socket.emit('alert', { message: 'Room is full.', type: 'error' });
            return;
        }

        if (existing.length === 0) {
            await pool.query("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)", [roomId, currentUser]);
            await pool.query("UPDATE rooms SET modified_at = NOW() WHERE id = ?", [roomId]);
        }

        currentRoom = roomId;
        socket.join(`room_${roomId}`);
        socket.emit('join_success', { room_id: roomId });
        broadcastSync(roomId);
    });

    socket.on('leave_room', async () => {
        if(!currentUser || !currentRoom) return;
        await pool.query("DELETE FROM room_members WHERE user_id = ?", [currentUser]);
        await pool.query("UPDATE calls SET status = 'ENDED' WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)", [currentUser, currentUser]);
        
        socket.leave(`room_${currentRoom}`);
        const rId = currentRoom;
        currentRoom = null;
        
        // Check if room empty or drawer left
        const [members] = await pool.query("SELECT * FROM room_members WHERE room_id = ?", [rId]);
        if(members.length === 0) {
            await pool.query("DELETE FROM rooms WHERE id = ?", [rId]);
            await pool.query("DELETE FROM drawings WHERE room_id = ?", [rId]);
            await pool.query("DELETE FROM chat_messages WHERE room_id = ?", [rId]);
            await pool.query("DELETE FROM guesses WHERE room_id = ?", [rId]);
        } else {
            const [room] = await pool.query("SELECT * FROM rooms WHERE id = ?", [rId]);
            if (room.length > 0 && room[0].current_drawer_id === currentUser && ['PRE_DRAW', 'DRAWING'].includes(room[0].status)) {
                await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [rId]);
                await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', '⚠️ Drawer left! Round reset.')", [rId]);
            }
            broadcastSync(rId);
        }
    });

    socket.on('set_word', async (word) => {
        if(!currentUser || !currentRoom) return;
        const endTime = new Date(Date.now() + 125000).toISOString().slice(0, 19).replace('T', ' '); // +125s
        await pool.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = ?, modified_at = NOW() WHERE id = ? AND current_drawer_id = ?", [word, endTime, currentRoom, currentUser]);
        await pool.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
        broadcastSync(currentRoom);
    });

    socket.on('draw', async (linesJson) => {
        if(!currentUser || !currentRoom) return;
        await pool.query("INSERT INTO drawings (room_id, line_data) VALUES (?, ?)", [currentRoom, linesJson]);
        // Fast path emit for smooth drawing
        socket.to(`room_${currentRoom}`).emit('draw_update', linesJson); 
    });

    socket.on('undo_draw', async () => {
        if(!currentUser || !currentRoom) return;
        const [last] = await pool.query("SELECT id, line_data FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1", [currentRoom]);
        if(last.length > 0) {
            await pool.query("DELETE FROM drawings WHERE id = ?", [last[0].id]);
            broadcastSync(currentRoom);
            socket.emit('undo_success', { line_data: last[0].line_data });
        }
    });

    socket.on('chat', async (msg) => {
        if(!currentUser || !currentRoom || !msg.trim()) return;
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, currentUser, msg.substring(0,200)]);
        broadcastSync(currentRoom);
    });

    socket.on('guess', async (guess) => {
        if(!currentUser || !currentRoom || !guess.trim()) return;
        
        const [guessCount] = await pool.query("SELECT COUNT(*) as c FROM guesses WHERE room_id = ? AND user_id = ?", [currentRoom, currentUser]);
        if (guessCount[0].c >= 5) {
            const [user] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [currentUser]);
            if (user[0].credits < 1) {
                socket.emit('alert', { message: 'Max 5 free guesses reached. 1 credit needed.', type: 'error' });
                return;
            }
            await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [currentUser]);
        }

        await pool.query("INSERT INTO guesses (room_id, user_id, guess_text) VALUES (?, ?, ?)", [currentRoom, currentUser, guess]);
        
        const [room] = await pool.query("SELECT * FROM rooms WHERE id = ?", [currentRoom]);
        if(room.length > 0 && room[0].word_to_draw && guess.toLowerCase() === room[0].word_to_draw.toLowerCase()) {
            await endRound(currentRoom, room[0]);
        } else {
            broadcastSync(currentRoom);
        }
    });

    socket.on('set_ready', async () => {
        if(!currentUser || !currentRoom) return;
        await pool.query("UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?", [currentRoom, currentUser]);
        
        const [members] = await pool.query("SELECT is_ready FROM room_members WHERE room_id = ?", [currentRoom]);
        const allReady = members.every(m => m.is_ready === 1);
        const [room] = await pool.query("SELECT * FROM rooms WHERE id = ?", [currentRoom]);

        if (allReady && members.length >= 2) {
            if (room[0].status === 'WAITING' || room[0].status === 'REVEAL' || room[0].status === 'BREAK') {
                let nextDrawer = room[0].next_drawer_id || room[0].current_drawer_id;
                if(room[0].status === 'WAITING') nextDrawer = await getNextDrawerByStats(currentRoom);
                
                await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [currentRoom]);
                await pool.query("UPDATE room_members SET total_turns = total_turns + 1 WHERE room_id = ? AND user_id = ?", [currentRoom, nextDrawer]);
                await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL, last_winner_id = NULL, next_drawer_id = NULL, modified_at = NOW() WHERE id = ?", [nextDrawer, currentRoom]);
                await pool.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
            }
        }
        broadcastSync(currentRoom);
    });

    // WebRTC Calling Events
    socket.on('initiate_call', async (data) => {
        const { receiver_id } = data;
        const [u] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [currentUser]);
        if(u[0].credits < 1) return socket.emit('alert', { message: 'You need 1 credit to call.', type: 'error'});
        await pool.query("INSERT INTO calls (room_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'RINGING')", [currentRoom, currentUser, receiver_id]);
        broadcastSync(currentRoom);
    });
    
    socket.on('accept_call', async (call_id) => {
        await pool.query("UPDATE calls SET status = 'ACTIVE', started_at = NOW(), last_billed_at = NOW() WHERE id = ?", [call_id]);
        broadcastSync(currentRoom);
    });

    socket.on('end_call', async (call_id) => {
        await pool.query("UPDATE calls SET status = 'ENDED' WHERE id = ? AND (caller_id = ? OR receiver_id = ?)", [call_id, currentUser, currentUser]);
        await pool.query("DELETE FROM webrtc_signals WHERE call_id = ?", [call_id]);
        broadcastSync(currentRoom);
    });

    socket.on('webrtc_signal', async (data) => {
        const { call_id, receiver_id, type, payload } = data;
        await pool.query("INSERT INTO webrtc_signals (call_id, sender_id, receiver_id, type, payload) VALUES (?, ?, ?, ?, ?)", [call_id, currentUser, receiver_id, type, payload]);
        broadcastSync(currentRoom); // Will deliver signals to receiver
    });

    // Cleanup on disconnect
    socket.on('disconnect', async () => {
        if(currentUser && currentRoom) {
            await pool.query("DELETE FROM room_members WHERE user_id = ?", [currentUser]);
            await pool.query("UPDATE calls SET status = 'ENDED' WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)", [currentUser, currentUser]);
            broadcastSync(currentRoom);
        }
    });
});

// Sync data builder
async function broadcastSync(roomId) {
    try {
        const [rooms] = await pool.query("SELECT * FROM rooms WHERE id = ?", [roomId]);
        if(rooms.length === 0) return io.to(`room_${roomId}`).emit('sync', { error: 'Room deleted' });
        
        let room = rooms[0];
        const [members] = await pool.query("SELECT user_id, is_ready, consecutive_turns, total_turns FROM room_members WHERE room_id = ?", [roomId]);
        
        // Hide word if not drawer/reveal
        if (room.word_to_draw) {
            if (['REVEAL', 'BREAK'].includes(room.status)) {
                room.hint = room.word_to_draw;
            } else {
                let w = room.word_to_draw;
                room.hint = w.replace(/[a-zA-Z]/g, '_ '); // Simple hint obfuscation for broadcast
            }
        }

        const [drawings] = await pool.query("SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC", [roomId]);
        const [chats] = await pool.query("SELECT * FROM (SELECT id, user_id, message, created_at FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 20) sub ORDER BY id ASC", [roomId]);
        
        const [raw_guesses] = await pool.query("SELECT id, user_id, guess_text, created_at FROM guesses WHERE room_id = ? ORDER BY created_at ASC", [roomId]);
        const guesses = raw_guesses.map(g => {
            let isReveal = ['REVEAL', 'BREAK'].includes(room.status);
            if (!isReveal) {
                return { ...g, guess_text: '••••••••', is_blurred: true, real_user: g.user_id };
            }
            return { ...g, is_blurred: false };
        });

        const [calls] = await pool.query("SELECT id, caller_id, receiver_id, status FROM calls WHERE room_id = ? AND status IN ('RINGING', 'ACTIVE')", [roomId]);
        const [signals] = await pool.query("SELECT id, call_id, sender_id, receiver_id, type, payload FROM webrtc_signals"); // Filtered client side usually, or join here
        
        // Fetch profiles
        let userIds = new Set([...members.map(m=>m.user_id), ...chats.map(c=>c.user_id), ...raw_guesses.map(g=>g.user_id)]);
        userIds.delete('System');
        let profiles = {};
        if(userIds.size > 0) {
            const [users] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (${Array.from(userIds).map(()=>'?').join(',')})`, Array.from(userIds));
            users.forEach(u => profiles[u.tg_id] = u.profile_pic);
        }

        const payload = {
            room, members, 
            drawings: drawings.map(d => d.line_data), 
            chats, guesses, profiles, calls, 
            webrtc_signals: signals,
            server_time: new Date().toISOString().slice(0, 19).replace('T', ' ')
        };

        io.to(`room_${roomId}`).emit('sync', payload);

        // Delete processed signals
        if (signals.length > 0) {
            await pool.query(`DELETE FROM webrtc_signals WHERE id IN (${signals.map(()=>'?').join(',')})`, signals.map(s=>s.id));
        }
    } catch(e) {
        console.error("Sync Error:", e);
    }
}


// Start Server
initDB().then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});
