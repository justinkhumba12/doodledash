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

// Database connection
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql.railway.internal',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'dKIKDNsnObjDvJlZawBHjzaEsoetaATX',
    database: process.env.DB_NAME || 'railway',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+05:30' // Match the IST timezone
});

// Initialization: Create Tables
async function initDB() {
    try {
        const conn = await pool.getConnection();
        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                tg_id VARCHAR(50) PRIMARY KEY,
                credits INT DEFAULT 0,
                last_daily_claim DATE,
                ad_claims_today INT DEFAULT 0,
                last_ad_claim_time DATETIME,
                last_ad_claim_date DATE,
                ad2_claims_today INT DEFAULT 0,
                last_ad2_claim_time DATETIME,
                last_ad2_claim_date DATE,
                profile_pic VARCHAR(255),
                last_active DATETIME
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS rooms (
                id INT AUTO_INCREMENT PRIMARY KEY,
                status VARCHAR(20) DEFAULT 'WAITING',
                word_to_draw VARCHAR(50),
                current_drawer_id VARCHAR(50),
                round_end_time DATETIME,
                break_end_time DATETIME,
                last_winner_id VARCHAR(50),
                next_drawer_id VARCHAR(50),
                modified_at DATETIME
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS room_members (
                room_id INT,
                user_id VARCHAR(50),
                is_ready TINYINT(1) DEFAULT 0,
                consecutive_turns INT DEFAULT 0,
                total_turns INT DEFAULT 0,
                PRIMARY KEY (room_id, user_id)
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                line_data LONGTEXT
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                guess_text VARCHAR(50),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await conn.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                caller_id VARCHAR(50),
                receiver_id VARCHAR(50),
                status VARCHAR(20),
                started_at DATETIME,
                last_billed_at DATETIME
            )
        `);
        conn.release();
        console.log("Database tables verified/created successfully.");
    } catch (e) {
        console.error("DB Init Error:", e);
    }
}
initDB();

// Helper Functions
const getNextDrawerByStats = async (roomId) => {
    const [rows] = await pool.query("SELECT user_id FROM room_members WHERE room_id = ? ORDER BY total_turns ASC, RAND() LIMIT 1", [roomId]);
    return rows.length > 0 ? rows[0].user_id : null;
};

const endRound = async (roomId, room, forceNextDrawer = null) => {
    const [winnerRows] = await pool.query("SELECT user_id FROM guesses WHERE room_id = ? AND LOWER(guess_text) = LOWER(?) ORDER BY created_at ASC LIMIT 1", [roomId, room.word_to_draw]);
    const winner = winnerRows.length > 0 ? winnerRows[0].user_id : null;
    let nextDrawer = forceNextDrawer || winner || await getNextDrawerByStats(roomId);

    const [memberRows] = await pool.query("SELECT consecutive_turns FROM room_members WHERE room_id = ? AND user_id = ?", [roomId, room.current_drawer_id]);
    let currentConsecutive = memberRows.length > 0 ? memberRows[0].consecutive_turns : 0;
    
    currentConsecutive = (nextDrawer === room.current_drawer_id) ? currentConsecutive + 1 : 1;
    let sysMsg = null;

    if (currentConsecutive > 3) {
        nextDrawer = await getNextDrawerByStats(roomId);
        currentConsecutive = 1;
        const hexDrawId = parseInt(room.current_drawer_id).toString(16).toUpperCase().substring(0, 6);
        sysMsg = `✏️ Player ${hexDrawId} reached max 3 consecutive turns! Changing drawer.`;
    }

    await pool.query("UPDATE room_members SET consecutive_turns = 0 WHERE room_id = ?", [roomId]);
    await pool.query("UPDATE room_members SET consecutive_turns = ? WHERE room_id = ? AND user_id = ?", [currentConsecutive, roomId, nextDrawer]);

    if (sysMsg) await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, 'System', ?)", [roomId, sysMsg]);
    
    await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [roomId]);
    await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(NOW(), INTERVAL 5 SECOND), last_winner_id = ?, next_drawer_id = ?, modified_at = NOW() WHERE id = ?", [winner || null, nextDrawer, roomId]);
};

// Websocket Events
io.on('connection', (socket) => {
    let tgId = null;
    let currentRoom = null;

    const broadcastSync = async (roomId) => {
        if (!roomId) return;
        try {
            const [roomRows] = await pool.query("SELECT * FROM rooms WHERE id = ?", [roomId]);
            if (roomRows.length === 0) return io.to(`room_${roomId}`).emit('sync', { error: 'Room deleted' });
            
            const room = roomRows[0];
            const [members] = await pool.query("SELECT user_id, is_ready, consecutive_turns, total_turns FROM room_members WHERE room_id = ?", [roomId]);
            const [drawings] = await pool.query("SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC", [roomId]);
            const [chats] = await pool.query("SELECT id, user_id, message, created_at FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT 20", [roomId]);
            const [guesses] = await pool.query("SELECT id, user_id, guess_text, created_at FROM guesses WHERE room_id = ? ORDER BY created_at ASC", [roomId]);
            const [calls] = await pool.query("SELECT id, caller_id, receiver_id, status FROM calls WHERE room_id = ? AND status IN ('RINGING', 'ACTIVE')", [roomId]);
            
            // Masking logic
            const processedGuesses = guesses.map(g => {
                if (room.status === 'REVEAL' || room.status === 'BREAK' || room.current_drawer_id === tgId || g.user_id === tgId) {
                    return { ...g, is_blurred: false };
                } else {
                    return { ...g, guess_text: '••••••••', is_blurred: true };
                }
            });

            // Profiles
            const userIds = [...new Set([...members.map(m=>m.user_id), ...chats.filter(c=>c.user_id!=='System').map(c=>c.user_id), ...guesses.map(g=>g.user_id)])];
            let profiles = {};
            if (userIds.length > 0) {
                const [users] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (?)`, [userIds]);
                users.forEach(u => profiles[u.tg_id] = u.profile_pic);
            }

            // Hint generation
            if (room.word_to_draw) {
                if (room.current_drawer_id === tgId || ['REVEAL', 'BREAK'].includes(room.status)) {
                    room.hint = room.word_to_draw;
                } else {
                    const word = room.word_to_draw;
                    let revealCount = word.length >= 10 ? 4 : word.length >= 7 ? 3 : word.length >= 4 ? 2 : 1;
                    room.hint = word.split('').map((c, i) => (i < revealCount ? c : '_')).join(' '); 
                }
            }

            io.to(`room_${roomId}`).emit('sync', {
                room, members, drawings: drawings.map(d=>d.line_data), 
                chats: chats.reverse(), guesses: processedGuesses, profiles, calls,
                server_time: new Date().toISOString()
            });
        } catch (e) {
            console.error(e);
        }
    };

    socket.on('auth', async (data) => {
        tgId = data.tg_id;
        try {
            await pool.query("INSERT IGNORE INTO users (tg_id, last_active, profile_pic) VALUES (?, NOW(), ?)", [tgId, data.photo_url || '']);
            await pool.query("UPDATE users SET last_active = NOW() WHERE tg_id = ?", [tgId]);
            socket.emit('auth_success');
        } catch (e) {
            socket.emit('auth_error', { message: 'Database Error' });
        }
    });

    socket.on('get_lobby', async () => {
        if(!tgId) return;
        const [rooms] = await pool.query("SELECT r.id, r.status, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id");
        const [members] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [tgId]);
        const [users] = await pool.query("SELECT credits, last_daily_claim, ad_claims_today, last_ad_claim_time, last_ad_claim_date, ad2_claims_today, last_ad2_claim_time, last_ad2_claim_date FROM users WHERE tg_id = ?", [tgId]);
        
        socket.emit('lobby_data', {
            rooms,
            current_room: members.length > 0 ? members[0].room_id : null,
            user_data: users[0],
            server_date: new Date().toISOString().split('T')[0],
            server_time: new Date().toISOString()
        });
    });

    socket.on('claim_reward', async ({ type }) => {
        if(!tgId) return;
        const today = new Date().toISOString().split('T')[0];
        const [users] = await pool.query("SELECT * FROM users WHERE tg_id = ?", [tgId]);
        const u = users[0];

        if (type === 'daily') {
            const lastClaim = u.last_daily_claim ? new Date(u.last_daily_claim).toISOString().split('T')[0] : null;
            if (lastClaim === today) return socket.emit('alert', { message: 'Already claimed today!', type: 'error' });
            await pool.query("UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?", [today, tgId]);
            socket.emit('alert', { message: 'Daily reward claimed: 1 Credit!', type: 'success' });
        } else if (type === 'ad1' || type === 'ad2') {
            const isAd1 = type === 'ad1';
            const claimsToday = isAd1 ? (u.last_ad_claim_date === today ? u.ad_claims_today : 0) : (u.last_ad2_claim_date === today ? u.ad2_claims_today : 0);
            const lastTime = isAd1 ? u.last_ad_claim_time : u.last_ad2_claim_time;

            if (claimsToday >= 2) return socket.emit('alert', { message: 'Ad limit reached for today!', type: 'error' });
            if (claimsToday > 0 && lastTime) {
                const diff = (new Date() - new Date(lastTime)) / 3600000;
                if (diff < 3) return socket.emit('alert', { message: 'Cooldown active! Please wait 3 hours.', type: 'error' });
            }
            if (isAd1) {
                await pool.query("UPDATE users SET credits = credits + 2, ad_claims_today = ?, last_ad_claim_time = NOW(), last_ad_claim_date = ? WHERE tg_id = ?", [claimsToday + 1, today, tgId]);
            } else {
                await pool.query("UPDATE users SET credits = credits + 2, ad2_claims_today = ?, last_ad2_claim_time = NOW(), last_ad2_claim_date = ? WHERE tg_id = ?", [claimsToday + 1, today, tgId]);
            }
            socket.emit('alert', { message: 'Ad reward claimed: 2 Credits!', type: 'success' });
        }
        socket.emit('refresh_lobby');
    });

    socket.on('create_room', async () => {
        if(!tgId) return;
        const [rooms] = await pool.query("SELECT COUNT(*) as count FROM rooms");
        if (rooms[0].count >= 10) return socket.emit('alert', { message: 'Max rooms limit reached.', type: 'error' });
        
        const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tgId]);
        if (users[0].credits < 1) return socket.emit('alert', { message: 'Not enough credits to create room.', type: 'error' });

        await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [tgId]);
        const [res] = await pool.query("INSERT INTO rooms (status, modified_at) VALUES ('WAITING', NOW())");
        socket.emit('room_created', { room_id: res.insertId });
    });

    socket.on('join_room', async ({ room_id }) => {
        if(!tgId) return;
        const [members] = await pool.query("SELECT COUNT(*) as c FROM room_members WHERE room_id = ?", [room_id]);
        const [inRoom] = await pool.query("SELECT room_id FROM room_members WHERE user_id = ?", [tgId]);
        
        if (members[0].c >= 4 && (!inRoom.length || inRoom[0].room_id !== room_id)) {
            return socket.emit('alert', { message: 'Room is full!', type: 'error' });
        }
        
        if (!inRoom.length) {
            await pool.query("INSERT INTO room_members (room_id, user_id) VALUES (?, ?)", [room_id, tgId]);
        } else if (inRoom[0].room_id !== room_id) {
            return socket.emit('alert', { message: 'Leave current room first.', type: 'error' });
        }

        currentRoom = room_id;
        socket.join(`room_${room_id}`);
        socket.emit('room_joined', { room_id });
        broadcastSync(room_id);
    });

    socket.on('leave_room', async () => {
        if(!tgId || !currentRoom) return;
        await pool.query("DELETE FROM room_members WHERE user_id = ?", [tgId]);
        await pool.query("UPDATE calls SET status = 'ENDED' WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)", [tgId, tgId]);
        socket.leave(`room_${currentRoom}`);
        broadcastSync(currentRoom);
        currentRoom = null;
        socket.emit('room_left');
    });

    socket.on('set_word', async ({ word }) => {
        if(!currentRoom) return;
        const endTime = new Date(Date.now() + 125000).toISOString().slice(0, 19).replace('T', ' ');
        await pool.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = ?, modified_at = NOW() WHERE id = ? AND current_drawer_id = ?", [word, endTime, currentRoom, tgId]);
        await pool.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
        broadcastSync(currentRoom);
    });

    socket.on('draw', async ({ lines }) => {
        if(!currentRoom) return;
        await pool.query("INSERT INTO drawings (room_id, line_data) VALUES (?, ?)", [currentRoom, lines]);
        broadcastSync(currentRoom);
    });

    socket.on('undo_draw', async () => {
        if(!currentRoom) return;
        const [last] = await pool.query("SELECT id, line_data FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1", [currentRoom]);
        if (last.length > 0) {
            await pool.query("DELETE FROM drawings WHERE id = ?", [last[0].id]);
            socket.emit('undone', { line_data: last[0].line_data });
            broadcastSync(currentRoom);
        }
    });

    socket.on('chat', async ({ message }) => {
        if(!currentRoom) return;
        await pool.query("INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, tgId, message]);
        broadcastSync(currentRoom);
    });

    socket.on('guess', async ({ guess }) => {
        if(!currentRoom) return;
        const [gCount] = await pool.query("SELECT COUNT(*) as c FROM guesses WHERE room_id = ? AND user_id = ?", [currentRoom, tgId]);
        if (gCount[0].c >= 5) {
            const [users] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tgId]);
            if (users[0].credits < 1) return socket.emit('alert', { message: 'Max 5 free guesses reached. Needs 1 credit.', type: 'error' });
            await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ?", [tgId]);
        }

        await pool.query("INSERT INTO guesses (room_id, user_id, guess_text) VALUES (?, ?, ?)", [currentRoom, tgId, guess]);
        
        const [rooms] = await pool.query("SELECT * FROM rooms WHERE id = ?", [currentRoom]);
        if (rooms[0].word_to_draw && guess.toLowerCase() === rooms[0].word_to_draw.toLowerCase()) {
            await endRound(currentRoom, rooms[0]);
        }
        broadcastSync(currentRoom);
    });

    socket.on('set_ready', async () => {
        if(!currentRoom) return;
        await pool.query("UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?", [currentRoom, tgId]);
        broadcastSync(currentRoom);
    });

    // WEBRTC & Calls Logic
    socket.on('initiate_call', async ({ receiver_id }) => {
        if(!currentRoom) return;
        const [u] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [tgId]);
        if(u[0].credits < 1) return socket.emit('alert', { message: 'Need 1 credit to call.', type: 'error' });

        const [c] = await pool.query("SELECT COUNT(*) as cnt FROM calls WHERE status IN ('RINGING', 'ACTIVE') AND (caller_id = ? OR receiver_id = ?)", [receiver_id, receiver_id]);
        if(c[0].cnt > 0) return socket.emit('alert', { message: 'User is busy.', type: 'error' });

        await pool.query("INSERT INTO calls (room_id, caller_id, receiver_id, status) VALUES (?, ?, ?, 'RINGING')", [currentRoom, tgId, receiver_id]);
        broadcastSync(currentRoom);
    });

    socket.on('call_action', async ({ call_id, action }) => {
        if(!currentRoom) return;
        if (action === 'accept') {
            const [call] = await pool.query("SELECT caller_id FROM calls WHERE id = ?", [call_id]);
            if(call.length > 0) {
                const [u] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [call[0].caller_id]);
                if(u[0].credits < 1) {
                    await pool.query("UPDATE calls SET status = 'DECLINED' WHERE id = ?", [call_id]);
                    return socket.emit('alert', { message: 'Caller out of credits.', type: 'error' });
                }
            }
            await pool.query("UPDATE calls SET status = 'ACTIVE', started_at = NOW(), last_billed_at = NOW() WHERE id = ?", [call_id]);
        } else if (action === 'decline') {
            await pool.query("UPDATE calls SET status = 'DECLINED' WHERE id = ?", [call_id]);
        } else if (action === 'end') {
            await pool.query("UPDATE calls SET status = 'ENDED' WHERE id = ?", [call_id]);
        }
        broadcastSync(currentRoom);
    });

    socket.on('webrtc_signal', ({ target_id, payload }) => {
        // Fast direct signaling via socket instead of DB polling
        socket.to(`room_${currentRoom}`).emit('webrtc_signal_received', { sender_id: tgId, target_id, payload });
    });

    socket.on('disconnect', () => {
        // We don't remove them from the DB immediately to allow rejoins, 
        // but we could mark them offline if needed.
    });
});

// Game Daemon: Handles timers, AFK kicks, and billing
setInterval(async () => {
    try {
        const [rooms] = await pool.query("SELECT * FROM rooms");
        
        for (const r of rooms) {
            let changed = false;
            const [members] = await pool.query("SELECT * FROM room_members WHERE room_id = ?", [r.id]);
            const mCount = members.length;

            if (mCount < 2 && r.status !== 'WAITING') {
                await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [r.id]);
                await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                changed = true;
            }

            if (r.status === 'WAITING' && mCount >= 2) {
                const allReady = members.every(m => m.is_ready);
                if (allReady) {
                    const nextDrawer = await getNextDrawerByStats(r.id);
                    await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                    await pool.query("UPDATE room_members SET consecutive_turns = 1, total_turns = total_turns + 1 WHERE room_id = ? AND user_id = ?", [r.id, nextDrawer]);
                    await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL, last_winner_id = NULL, next_drawer_id = NULL WHERE id = ?", [nextDrawer, r.id]);
                    await pool.query("DELETE FROM guesses WHERE room_id = ?", [r.id]);
                    changed = true;
                }
            }

            if (r.status === 'DRAWING' && new Date() >= new Date(r.round_end_time)) {
                await endRound(r.id, r);
                changed = true;
            }

            if (r.status === 'REVEAL' && new Date() >= new Date(r.break_end_time)) {
                await pool.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(NOW(), INTERVAL 600 SECOND) WHERE id = ?", [r.id]);
                changed = true;
            }

            if (['BREAK', 'REVEAL'].includes(r.status)) {
                const allReady = members.length >= 2 && members.every(m => m.is_ready);
                if (allReady) {
                    const nextDrawer = r.next_drawer_id || r.current_drawer_id;
                    await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                    await pool.query("UPDATE room_members SET total_turns = total_turns + 1 WHERE room_id = ? AND user_id = ?", [r.id, nextDrawer]);
                    await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL, last_winner_id = NULL, next_drawer_id = NULL WHERE id = ?", [nextDrawer, r.id]);
                    await pool.query("DELETE FROM guesses WHERE room_id = ?", [r.id]);
                    changed = true;
                }
            }

            // Call Billing 1 Credit / 2 Min
            const [calls] = await pool.query("SELECT * FROM calls WHERE status = 'ACTIVE' AND room_id = ?", [r.id]);
            for(const c of calls) {
                if (new Date() - new Date(c.last_billed_at) >= 120000) {
                    await pool.query("UPDATE users SET credits = credits - 1 WHERE tg_id = ? AND credits >= 1", [c.caller_id]);
                    const [u] = await pool.query("SELECT credits FROM users WHERE tg_id = ?", [c.caller_id]);
                    if (u[0].credits < 1) {
                        await pool.query("UPDATE calls SET status = 'ENDED' WHERE id = ?", [c.id]);
                    } else {
                        await pool.query("UPDATE calls SET last_billed_at = NOW() WHERE id = ?", [c.id]);
                    }
                    changed = true;
                }
            }

            if (changed) {
                // Manually trigger a broadcast sync instead of pulling everything again (simplified)
                io.to(`room_${r.id}`).emit('trigger_sync'); 
            }
        }
    } catch (e) { console.error("Daemon Loop Error", e); }
}, 2000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
