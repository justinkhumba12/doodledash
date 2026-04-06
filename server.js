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
    const dbUrl = process.env.MYSQL_URL || 'mysql://root:dKIKDNsnObjDvJlZawBHjzaEsoetaATX@mysql.railway.internal:3306/railway';
    try {
        db = await mysql.createConnection({ uri: dbUrl, timezone: 'Z' });
        console.log('Connected to MySQL Database.');

        // Users Table
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

        // Rooms Table
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

        // Safely alter existing rooms table for new features
        try { await db.query('ALTER TABLE rooms ADD COLUMN is_private BOOLEAN DEFAULT FALSE'); } catch (e) {}
        try { await db.query('ALTER TABLE rooms ADD COLUMN password VARCHAR(255)'); } catch (e) {}

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

        // Ensure at least a few empty public rooms exist
        const [rooms] = await db.query('SELECT COUNT(*) as count FROM rooms');
        if (rooms[0].count === 0) {
            for (let i = 0; i < 5; i++) {
                await db.query(`INSERT INTO rooms (status, modified_at, is_private) VALUES ('WAITING', UTC_TIMESTAMP(), 0)`);
            }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

// Helper to fetch user with calculated UTC limits
async function getUserState(tg_id) {
    const [rows] = await db.query(`
        SELECT *,
        (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as daily_available,
        
        (last_ad_claim_date IS NULL OR DATE_FORMAT(last_ad_claim_date, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad_claims_today < 2 AND TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()) >= 180)) as ad1_available,
        
        (last_ad2_claim_date IS NULL OR DATE_FORMAT(last_ad2_claim_date, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad2_claims_today < 2 AND TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()) >= 180)) as ad2_available,
        
        GREATEST(0, 180 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()), 180)) as ad1_wait_mins,
        GREATEST(0, 180 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()), 180)) as ad2_wait_mins,
        
        (DATE_FORMAT(last_ad_claim_date, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad1_is_today,
        (DATE_FORMAT(last_ad2_claim_date, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad2_is_today
        
        FROM users WHERE tg_id = ?
    `, [tg_id]);

    if (rows.length === 0) return null;
    let u = rows[0];
    
    // UI resets for new days
    if (!u.ad1_is_today) u.ad_claims_today = 0;
    if (!u.ad2_is_today) u.ad2_claims_today = 0;

    return u;
}

// In-Memory Call Management for WebRTC
const activeCalls = new Map(); 

// WebSockets Game Engine
io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;

    const syncRoom = async (roomId) => {
        if (!roomId) return;
        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        const [members] = await db.query('SELECT * FROM room_members WHERE room_id = ?', [roomId]);
        const [chats] = await db.query('SELECT * FROM chats WHERE room_id = ? ORDER BY id DESC LIMIT 20', [roomId]);
        const [guesses] = await db.query('SELECT * FROM guesses WHERE room_id = ? ORDER BY id ASC', [roomId]);
        const [drawings] = await db.query('SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC', [roomId]);
        
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
        
        await db.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [tg_id]);
        if (profile_pic) {
            await db.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, tg_id]);
        } else {
            await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tg_id]);
        }

        const userState = await getUserState(tg_id);
        const [rooms] = await db.query('SELECT r.id, r.status, r.is_private, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id WHERE r.is_private = 0 GROUP BY r.id');
        
        const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
        if (existing.length > 0) {
            currentRoom = existing[0].room_id;
            socket.join(`room_${currentRoom}`);
            syncRoom(currentRoom);
        }

        socket.emit('lobby_data', { user: userState, rooms, currentRoom });
    });

    socket.on('claim_reward', async ({ type }) => {
        if (!currentUser) return;
        let success = false;
        let msg = '';

        if (type === 'daily') {
            const [res] = await db.query(`
                UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
            `, [currentUser]);
            if (res.affectedRows > 0) { success = true; msg = 'Daily reward claimed! +1 Credit'; }
            else { msg = 'Daily reward already claimed today.'; }
        } 
        else if (type === 'ad' || type === 'ad2') {
            const prefix = type === 'ad' ? 'ad' : 'ad2';
            const [u] = await db.query(`SELECT
                ${prefix}_claims_today as claims,
                DATE_FORMAT(last_${prefix}_claim_date, '%Y-%m-%d') as last_date,
                DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                FROM users WHERE tg_id = ?`, [currentUser]);

            if (u.length > 0) {
                const user = u[0];
                const isToday = user.last_date === user.today;

                if (!user.last_date || !isToday) {
                    await db.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = 1, last_${prefix}_claim_date = UTC_DATE(), last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                    success = true; msg = 'Reward claimed! +2 Credits';
                } else if (user.claims < 2 && (user.mins_passed === null || user.mins_passed >= 180)) {
                    await db.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = ${prefix}_claims_today + 1, last_${prefix}_claim_date = UTC_DATE(), last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                    success = true; msg = 'Reward claimed! +2 Credits';
                } else {
                    msg = 'Ad reward not available yet. Max 2 per day, 3 hours apart.';
                }
            }
        }

        if (success) {
            socket.emit('reward_success', msg);
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        } else {
            socket.emit('reward_error', msg);
        }
    });

    socket.on('create_room', async ({ is_private, password }) => {
        if (!currentUser) return;
        const [res] = await db.query(`INSERT INTO rooms (status, modified_at, is_private, password) VALUES ('WAITING', UTC_TIMESTAMP(), ?, ?)`, [is_private ? 1 : 0, password || null]);
        socket.emit('room_created', { room_id: res.insertId });
    });

    socket.on('search_room', async ({ room_id }) => {
        const [rows] = await db.query('SELECT id, is_private FROM rooms WHERE id = ?', [room_id]);
        if (rows.length === 0) return socket.emit('join_error', 'Room not found.');
        socket.emit('search_result', rows[0]);
    });

    socket.on('join_room', async ({ room_id, password }) => {
        if (!currentUser) return;

        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [room_id]);
        if (roomData.length === 0) return socket.emit('join_error', 'Room not found.');
        const room = roomData[0];

        const [members] = await db.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [room_id]);
        if (members[0].count >= 4) return socket.emit('join_error', 'Room is full.');

        // Verify if user is already inside
        const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [currentUser]);
        if (existing.length > 0 && existing[0].room_id === room_id) {
            currentRoom = room_id;
            socket.join(`room_${currentRoom}`);
            return syncRoom(currentRoom);
        }

        if (room.is_private) {
            if (room.password !== password) return socket.emit('join_error', 'Incorrect password.');
        } else {
            // Deduct 1 credit for public rooms
            const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < 1) return socket.emit('join_error', 'Not enough credits. Public rooms cost 1 credit.');
            await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
        }

        await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]); 
        if (currentRoom) socket.leave(`room_${currentRoom}`);

        await db.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [room_id, currentUser]);
        currentRoom = room_id;
        socket.join(`room_${currentRoom}`);
        syncRoom(currentRoom);

        // Update Client credits locally
        const userState = await getUserState(currentUser);
        if (userState) socket.emit('user_update', userState);
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
            await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [currentUser, currentRoom]);
        }
        syncRoom(currentRoom);
    });

    socket.on('set_word', async ({ word }) => {
        if (!currentUser || !currentRoom) return;
        await db.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [word, currentRoom, currentUser]);
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

    socket.on('initiate_call', async ({ receiver_id }) => {
        if (!currentUser) return;
        const callId = `call_${Date.now()}_${Math.random()}`;
        activeCalls.set(callId, { id: callId, caller: currentUser, receiver: receiver_id, status: 'RINGING' });
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
        socket.to(`room_${currentRoom}`).emit('webrtc_signal_receive', { call_id, sender_id: currentUser, target_id, signal });
    });

    socket.on('disconnect', async () => {
        if (currentUser && currentRoom) {
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            syncRoom(currentRoom);
        }
    });
});

// Server Game Loop explicitly using UTC time constraints from Database
setInterval(async () => {
    try {
        const [drawingRooms] = await db.query("SELECT id FROM rooms WHERE status = 'DRAWING' AND round_end_time <= UTC_TIMESTAMP()");
        for (let r of drawingRooms) {
            await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE id = ?", [r.id]);
            io.to(`room_${r.id}`).emit('trigger_sync');
        }

        const [revealRooms] = await db.query("SELECT id FROM rooms WHERE status = 'REVEAL' AND break_end_time <= UTC_TIMESTAMP()");
        for (let r of revealRooms) {
            await db.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 600 SECOND) WHERE id = ?", [r.id]);
            io.to(`room_${r.id}`).emit('trigger_sync');
        }

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
