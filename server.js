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
                modified_at DATETIME,
                is_private BOOLEAN DEFAULT FALSE,
                password VARCHAR(255),
                max_members INT DEFAULT 4
            )
        `);

        const migrations = [
            "ALTER TABLE rooms ADD COLUMN is_private BOOLEAN DEFAULT FALSE",
            "ALTER TABLE rooms ADD COLUMN password VARCHAR(255)",
            "ALTER TABLE rooms ADD COLUMN max_members INT DEFAULT 4"
        ];
        
        for (let query of migrations) {
            try { await db.query(query); } catch (e) { }
        }

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

        const [rooms] = await db.query('SELECT COUNT(*) as count FROM rooms');
        if (rooms[0].count === 0) {
            for (let i = 0; i < 5; i++) {
                await db.query(`INSERT INTO rooms (status, modified_at, is_private, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, 4)`);
            }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

app.post('/webhook', async (req, res) => {
    const update = req.body;
    if (update?.message?.text === '/start') {
        const chatId = update.message.chat.id;
        const tgId = update.message.from.id;
        
        try {
            await db.query('INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())', [tgId.toString()]);
        } catch (e) {
            console.error('Webhook DB Error:', e);
        }

        const token = process.env.BOT_TOKEN; 
        const webAppUrl = process.env.WEBAPP_URL; 
        
        if (token && webAppUrl) {
            const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
            fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: 'Welcome to DoodleDash! Click below to play.',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
                    }
                })
            }).catch(console.error);
        }
    }
    res.sendStatus(200);
});

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
    if (!u.ad1_is_today) u.ad_claims_today = 0;
    if (!u.ad2_is_today) u.ad2_claims_today = 0;
    return u;
}

const activeCalls = new Map(); 
const roomRedoStacks = {}; // Memory for redo functionality

const broadcastRooms = async () => {
    const [rooms] = await db.query('SELECT r.id, r.status, r.is_private, r.max_members, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id WHERE r.is_private = 0 GROUP BY r.id');
    io.emit('lobby_rooms_update', rooms);
};

const syncRoom = async (roomId) => {
    if (!roomId) return;
    try {
        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        if (roomData.length === 0) return; 

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

        const activeCallsList = Array.from(activeCalls.values()).filter(c => c.room_id === roomId);

        io.to(`room_${roomId}`).emit('room_sync', {
            room: roomData[0],
            members,
            chats: chats.reverse(),
            guesses,
            drawings: drawings.map(d => d.line_data),
            profiles,
            activeCalls: activeCallsList,
            server_time: new Date()
        });
    } catch (error) {
        console.error("syncRoom error:", error);
    }
};

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;
    socket.lastActiveEvent = Date.now();

    socket.on('auth', async ({ tg_id, profile_pic }) => {
        try {
            if (!tg_id) return;
            currentUser = tg_id;
            socket.join(`user_${tg_id}`);
            
            await db.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [tg_id]);
            if (profile_pic) {
                await db.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, tg_id]);
            } else {
                await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tg_id]);
            }

            const userState = await getUserState(tg_id);
            const [rooms] = await db.query('SELECT r.id, r.status, r.is_private, r.max_members, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id WHERE r.is_private = 0 GROUP BY r.id');
            
            const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
            if (existing.length > 0) {
                currentRoom = existing[0].room_id;
                socket.join(`room_${currentRoom}`);
                syncRoom(currentRoom);
            }

            socket.emit('lobby_data', { user: userState, rooms, currentRoom });
        } catch (err) {
            console.error('Auth Error:', err);
        }
    });

    socket.on('active_event', () => {
        socket.lastActiveEvent = Date.now();
    });

    socket.on('claim_reward', async ({ type }) => {
        try {
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
                socket.emit('create_error', msg);
            }
        } catch (err) {
            console.error('Claim Reward Error:', err);
        }
    });

    socket.on('create_room', async ({ is_private, password, max_members }) => {
        try {
            if (!currentUser) return;
            const limit = [2, 3, 4].includes(max_members) ? max_members : 4;

            if (is_private) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < 4) return socket.emit('create_error', 'Not enough credits. Private rooms cost 4 credits.');
                await db.query('UPDATE users SET credits = credits - 4 WHERE tg_id = ?', [currentUser]);
            }

            const [res] = await db.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), ?, ?, ?)`, [is_private ? 1 : 0, password || null, limit]);
            socket.emit('room_created', { room_id: res.insertId });
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            broadcastRooms();
        } catch (err) {}
    });

    socket.on('search_room', async ({ room_id }) => {
        try {
            const [rows] = await db.query('SELECT id, is_private FROM rooms WHERE id = ?', [Number(room_id)]);
            if (rows.length === 0) return socket.emit('join_error', 'Room not found.');
            socket.emit('search_result', rows[0]);
        } catch (err) {}
    });

    socket.on('join_room', async ({ room_id, password }) => {
        try {
            if (!currentUser) return;
            const roomIdNum = Number(room_id);

            const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomIdNum]);
            if (roomData.length === 0) return socket.emit('join_error', 'Room not found.');
            const room = roomData[0];

            const [members] = await db.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [roomIdNum]);
            if (members[0].count >= room.max_members) return socket.emit('join_error', 'Room is full.');

            const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [currentUser]);
            if (existing.length > 0 && existing[0].room_id === roomIdNum) {
                currentRoom = roomIdNum;
                socket.join(`room_${currentRoom}`);
                socket.emit('join_success', currentRoom);
                return syncRoom(currentRoom);
            }

            if (room.is_private) {
                if (room.password !== password) return socket.emit('join_error', 'Incorrect password.');
            } else {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < 1) return socket.emit('join_error', 'Not enough credits. Public rooms cost 1 credit.');
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
            }

            const oldRoom = currentRoom;
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]); 
            if (oldRoom) socket.leave(`room_${oldRoom}`);

            await db.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [roomIdNum, currentUser]);
            currentRoom = roomIdNum;
            socket.join(`room_${currentRoom}`);
            
            socket.emit('join_success', currentRoom);
            
            if (oldRoom) syncRoom(oldRoom);
            syncRoom(currentRoom);
            broadcastRooms();

            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        } catch (err) {}
    });

    socket.on('leave_room', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            socket.leave(`room_${currentRoom}`);
            syncRoom(currentRoom);
            currentRoom = null;
            broadcastRooms();
        } catch (err) {}
    });

    socket.on('chat', async ({ message }) => {
        try {
            if (!currentUser || !currentRoom || !message.trim()) return;
            await db.query('INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)', [currentRoom, currentUser, message]);
            syncRoom(currentRoom);
        } catch (err) {}
    });

    socket.on('guess', async ({ guess }) => {
        try {
            if (!currentUser || !currentRoom || !guess.trim()) return;
            const [room] = await db.query('SELECT word_to_draw FROM rooms WHERE id = ?', [currentRoom]);
            const isCorrect = room[0]?.word_to_draw?.toLowerCase() === guess.toLowerCase();
            
            await db.query('INSERT INTO guesses (room_id, user_id, guess_text, is_correct) VALUES (?, ?, ?, ?)', [currentRoom, currentUser, guess, isCorrect]);
            if (isCorrect) {
                await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [currentUser, currentRoom]);
            }
            syncRoom(currentRoom);
        } catch (err) {}
    });

    socket.on('set_word', async ({ word }) => {
        try {
            if (!currentUser || !currentRoom) return;
            await db.query("UPDATE rooms SET word_to_draw = ?, status = 'DRAWING', round_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [word, currentRoom, currentUser]);
            await db.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
            await db.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
            roomRedoStacks[currentRoom] = [];
            syncRoom(currentRoom);
        } catch (err) {}
    });

    socket.on('set_ready', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            await db.query('UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            syncRoom(currentRoom);
        } catch (err) {}
    });

    socket.on('draw', async ({ lines }) => {
        try {
            if (!currentUser || !currentRoom) return;
            roomRedoStacks[currentRoom] = []; // clear redo logic on new draw
            await db.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [currentRoom, JSON.stringify(lines)]);
            socket.to(`room_${currentRoom}`).emit('live_draw', lines);
        } catch (err) {}
    });

    socket.on('undo', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            const [last] = await db.query('SELECT * FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1', [currentRoom]);
            if (last.length > 0) {
                if(!roomRedoStacks[currentRoom]) roomRedoStacks[currentRoom] = [];
                roomRedoStacks[currentRoom].push(last[0]);
                await db.query('DELETE FROM drawings WHERE id = ?', [last[0].id]);
                syncRoom(currentRoom);
            }
        } catch (err) {}
    });

    socket.on('redo', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            if(roomRedoStacks[currentRoom] && roomRedoStacks[currentRoom].length > 0) {
                const toRestore = roomRedoStacks[currentRoom].pop();
                await db.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [currentRoom, toRestore.line_data]);
                syncRoom(currentRoom);
            }
        } catch (err) {}
    });

    socket.on('initiate_call', async ({ receiver_id }) => {
        if (!currentUser || !currentRoom) return;
        const callId = `call_${Date.now()}_${Math.random()}`;
        activeCalls.set(callId, { id: callId, caller: currentUser, receiver: receiver_id, status: 'RINGING', room_id: currentRoom });
        syncRoom(currentRoom);
    });

    socket.on('accept_call', async ({ call_id }) => {
        const call = activeCalls.get(call_id);
        if (call && call.receiver === currentUser) {
            call.status = 'ACTIVE';
            call.startTime = Date.now();
            activeCalls.set(call_id, call);
            
            call.interval = setInterval(async () => {
                const c = activeCalls.get(call_id);
                if(!c) return clearInterval(call.interval);
                
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id IN (?, ?) AND credits > 0', [c.caller, c.receiver]);
                const [u1] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [c.caller]);
                const [u2] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [c.receiver]);
                
                if (u1[0].credits <= 0 || u2[0].credits <= 0) {
                    clearInterval(call.interval);
                    activeCalls.delete(call_id);
                    io.to(`room_${c.room_id}`).emit('call_ended', call_id);
                    syncRoom(c.room_id);
                } else {
                    const uState1 = await getUserState(c.caller);
                    const uState2 = await getUserState(c.receiver);
                    if(uState1) io.to(`user_${c.caller}`).emit('user_update', uState1);
                    if(uState2) io.to(`user_${c.receiver}`).emit('user_update', uState2);
                }
            }, 60000);

            syncRoom(currentRoom);
        }
    });

    socket.on('end_call', ({ call_id }) => {
        const call = activeCalls.get(call_id);
        if (call) {
            if(call.interval) clearInterval(call.interval);
            activeCalls.delete(call_id);
            io.to(`room_${currentRoom}`).emit('call_ended', call_id);
            syncRoom(currentRoom);
        }
    });

    socket.on('webrtc_signal', ({ call_id, target_id, signal }) => {
        socket.to(`room_${currentRoom}`).emit('webrtc_signal_receive', { call_id, sender_id: currentUser, target_id, signal });
    });

    socket.on('disconnect', async () => {
        if (currentUser && currentRoom) {
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            syncRoom(currentRoom);
            broadcastRooms();
        }
    });
});

// Main Game Timers (Drawing timeout removed)
setInterval(async () => {
    try {
        const [revealRooms] = await db.query("SELECT id FROM rooms WHERE status = 'REVEAL' AND break_end_time <= UTC_TIMESTAMP()");
        for (let r of revealRooms) {
            await db.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 600 SECOND) WHERE id = ?", [r.id]);
            syncRoom(r.id);
        }

        const [waitingRooms] = await db.query("SELECT * FROM rooms WHERE status IN ('WAITING', 'BREAK')");
        for (let r of waitingRooms) {
            const [members] = await db.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [r.id]);
            if (members.length >= 2 && members.every(m => m.is_ready)) {
                const nextDrawer = members[Math.floor(Math.random() * members.length)].user_id;
                await db.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?", [nextDrawer, r.id]);
                await db.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                await db.query("DELETE FROM guesses WHERE room_id = ?", [r.id]);
                syncRoom(r.id);
            }
        }
        
        // Idle Tracker - 60 sec inactivity remove logic
        const now = Date.now();
        io.sockets.sockets.forEach(s => {
            if (s.currentRoom && now - (s.lastActiveEvent || now) > 60000) {
                s.emit('kick_idle');
                db.query('DELETE FROM room_members WHERE user_id = ?', [s.currentUser]).then(() => {
                    syncRoom(s.currentRoom);
                    broadcastRooms();
                });
                s.leave(`room_${s.currentRoom}`);
                s.currentRoom = null;
            }
        });
    } catch (e) { console.error("Game Loop Error:", e); }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
