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

// Service Worker for Caching
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
        const CACHE_NAME = 'doodledash-cache-v1';
        const urlsToCache = [
            '/',
            '/audio/mgs_notification.mp3',
            '/audio/guess_notification.mp3',
            '/audio/call.mp3',
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
                last_ad_claim_time DATETIME,
                ad2_claims_today INT DEFAULT 0,
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
                max_members INT DEFAULT 4,
                base_hints VARCHAR(255) DEFAULT '[]'
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
            "ALTER TABLE room_members ADD COLUMN purchased_hints VARCHAR(255) DEFAULT '[]'"
        ];
        
        for (let query of migrations) {
            try { await db.query(query); } catch (e) { /* Ignore if column already exists */ }
        }

        await db.query(`
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

const activeCalls = new Map(); 
const roomRedoStacks = {}; 
const disconnectTimeouts = new Map(); 
let lastCleanupDay = new Date().getUTCDate(); 

const broadcastRooms = async () => {
    // Send both Private and Public Rooms
    const [rooms] = await db.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
    
    io.sockets.sockets.forEach(s => {
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
        await db.query("DELETE FROM rooms WHERE id = ?", [roomId]);
        await db.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
        await db.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
        await db.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
        await db.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
        delete roomRedoStacks[roomId];
    } catch (e) {
        console.error("Error completely deleting room:", roomId, e);
    }
};

// Auto Room Resetter and Deleter
const checkRoomReset = async (roomId) => {
    if (!roomId) return;
    try {
        const [members] = await db.query('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', [roomId]);
        if (members[0].c === 0) {
            const [roomInfo] = await db.query('SELECT is_private FROM rooms WHERE id = ?', [roomId]);
            const isPrivate = roomInfo.length > 0 && roomInfo[0].is_private;

            // Delete room completely if empty unless it's the fallback base rooms (1 or 2) OR it's a private room (let expire_at handle it)
            if (roomId !== 1 && roomId !== 2 && !isPrivate) {
                await deleteRoom(roomId);
            } else {
                await db.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
                await db.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
                await db.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
                await db.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
                await db.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
                delete roomRedoStacks[roomId];
            }
        } else if (members[0].c < 2) {
            await db.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
            await db.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [roomId]);
        }
    } catch(err) {
        console.error("Auto delete room error:", err);
    }
};

const syncRoom = async (roomId) => {
    if (!roomId) return;
    try {
        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        if (roomData.length === 0) return; 

        const [members] = await db.query('SELECT * FROM room_members WHERE room_id = ?', [roomId]);
        const [chats] = await db.query('SELECT * FROM chats WHERE room_id = ? ORDER BY id ASC', [roomId]); 
        const [guesses] = await db.query('SELECT * FROM guesses WHERE room_id = ? ORDER BY id ASC', [roomId]);
        const [drawings] = await db.query('SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC', [roomId]);
        
        const userIds = [...new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)])];
        let profiles = {};
        if (userIds.length > 0) {
            const [users] = await db.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (?)`, [userIds]);
            users.forEach(u => profiles[u.tg_id] = u.profile_pic);
        }

        const activeCallsList = Array.from(activeCalls.values())
            .filter(c => c.room_id === roomId)
            .map(c => ({
                id: c.id, caller: c.caller, receiver: c.receiver, status: c.status, room_id: c.room_id
            }));

        const roomSockets = io.sockets.adapter.rooms.get(`room_${roomId}`);
        if (roomSockets) {
            for (const socketId of roomSockets) {
                const s = io.sockets.sockets.get(socketId);
                if (s) {
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
            }
        }
    } catch (error) {
        console.error("syncRoom error:", error);
    }
};

const terminateCallsForUser = (userId) => {
    for (const [callId, call] of activeCalls.entries()) {
        if (call.caller === userId || call.receiver === userId) {
            if (call.interval) clearInterval(call.interval);
            activeCalls.delete(callId);
            io.to(`room_${call.room_id}`).emit('call_ended', callId);
            syncRoom(call.room_id);
        }
    }
};

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;
    socket.lastActiveEvent = Date.now();
    socket.idleWarned = false;

    // Extracted robust helper logic for joining rooms gracefully behind the scenes (for standard & Auto-Join)
    const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
        const [roomData] = await db.query('SELECT * FROM rooms WHERE id = ?', [roomIdNum]);
        if (roomData.length === 0) return socket.emit('join_error', 'Room not found.');
        const room = roomData[0];

        const [members] = await db.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [roomIdNum]);
        if (members[0].count >= room.max_members) return socket.emit('join_error', 'Room is full.');

        const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [userId]);
        if (existing.length > 0 && existing[0].room_id === roomIdNum) {
            currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.emit('join_success', roomIdNum);
            return syncRoom(roomIdNum);
        }

        if (!bypassCost) {
            if (room.is_private) {
                if (room.password !== password) return socket.emit('join_error', 'Incorrect password.');
            } else if (roomIdNum !== 1 && roomIdNum !== 2) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [userId]);
                if (u[0].credits < 1) return socket.emit('join_error', 'Not enough credits. Public rooms cost 1 credit.');
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [userId]);
            }
        }

        const oldRoom = currentRoom;
        if (oldRoom) {
            terminateCallsForUser(userId); 
            socket.leave(`room_${oldRoom}`);
            await db.query('DELETE FROM room_members WHERE user_id = ?', [userId]); 
            await checkRoomReset(oldRoom);
        }

        await db.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [roomIdNum, userId]);
        currentRoom = roomIdNum;
        socket.join(`room_${currentRoom}`);
        
        socket.emit('join_success', currentRoom);
        
        if (oldRoom) syncRoom(oldRoom);
        syncRoom(currentRoom);
        broadcastRooms();

        const userState = await getUserState(userId);
        if (userState) socket.emit('user_update', userState);
    };

    socket.on('auth', async ({ tg_id, profile_pic }) => {
        try {
            if (!tg_id) return;
            currentUser = tg_id;
            socket.currentUser = tg_id; 
            
            if (disconnectTimeouts.has(tg_id)) {
                clearTimeout(disconnectTimeouts.get(tg_id));
                disconnectTimeouts.delete(tg_id);
            }

            socket.join(`user_${tg_id}`);
            
            await db.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [tg_id]);
            if (profile_pic) {
                await db.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, tg_id]);
            } else {
                await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tg_id]);
            }

            const userState = await getUserState(tg_id);
            const [rooms] = await db.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
            const customizedRooms = rooms.map(r => r.creator_id === tg_id ? r : { ...r, password: null });
            
            const [existing] = await db.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
            if (existing.length > 0) {
                currentRoom = existing[0].room_id;
                socket.join(`room_${currentRoom}`);
                syncRoom(currentRoom);
            }

            socket.emit('lobby_data', { user: userState, rooms: customizedRooms, currentRoom });
        } catch (err) {}
    });

    socket.on('active_event', () => {
        socket.lastActiveEvent = Date.now();
        socket.idleWarned = false;
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
                    DATE_FORMAT(last_${prefix}_claim_time, '%Y-%m-%d') as last_date,
                    DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                    TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                    FROM users WHERE tg_id = ?`, [currentUser]);

                if (u.length > 0) {
                    const user = u[0];
                    const isToday = user.last_date === user.today;

                    if (!user.last_date || !isToday) {
                        await db.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                        success = true; msg = 'Reward claimed! +2 Credits';
                    } else if (user.claims < 3 && (user.mins_passed === null || user.mins_passed >= 180)) {
                        await db.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = ${prefix}_claims_today + 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
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

    socket.on('create_room', async ({ is_private, password, max_members, expire_hours, auto_join }) => {
        try {
            if (!currentUser) return;
            const limit = [2, 3, 4].includes(max_members) ? max_members : 4;
            let insertRes;
            
            // Only cost 1 extra credit for auto_join IF it's a public room.
            let cost = (auto_join && !is_private) ? 1 : 0;
            
            if (is_private) {
                if (!password || password.length < 6 || password.length > 10) {
                    return socket.emit('create_error', 'Password must be exactly 6 to 10 characters.');
                }

                const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
                let timeCost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
                cost += limit + timeCost;
            }

            if (cost > 0) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < cost) return socket.emit('create_error', `Not enough credits. Costs ${cost} credits.`);
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            }

            if (is_private) {
                const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
                [insertRes] = await db.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members, creator_id, expire_at) VALUES ('WAITING', UTC_TIMESTAMP(), 1, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`, [password, limit, currentUser, hours]);
            } else {
                [insertRes] = await db.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, NULL, ?)`, [limit]);
            }

            const newRoomId = insertRes.insertId;

            if (auto_join) {
                // Immediately transport user inside explicitly bypassing regular Join Checks
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
            const [rows] = await db.query('SELECT id, is_private FROM rooms WHERE id = ?', [Number(room_id)]);
            if (rows.length === 0) return socket.emit('join_error', 'Room not found.');
            socket.emit('search_result', rows[0]);
        } catch (err) {}
    });

    socket.on('join_room', async ({ room_id, password }) => {
        try {
            if (!currentUser) return;
            await performJoinRoom(currentUser, Number(room_id), password, false);
        } catch (err) {}
    });

    socket.on('leave_room', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            terminateCallsForUser(currentUser); 
            await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
            await checkRoomReset(currentRoom);
            socket.leave(`room_${currentRoom}`);
            syncRoom(currentRoom);
            currentRoom = null;
            broadcastRooms();
        } catch (err) {}
    });

    socket.on('extend_room', async ({ expire_hours }) => {
        try {
            if (!currentUser || !currentRoom) return;
            const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
            let cost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
            
            const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');
            
            await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            await db.query('UPDATE rooms SET expire_at = DATE_ADD(expire_at, INTERVAL ? HOUR) WHERE id = ?', [hours, currentRoom]);
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            syncRoom(currentRoom);
        } catch(err) { console.error('Extend room error:', err); }
    });

    socket.on('change_password', async ({ password }) => {
        try {
            if (!currentUser || !currentRoom) return;
            if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be 6-10 characters.');
            
            const [room] = await db.query('SELECT creator_id FROM rooms WHERE id = ? AND is_private = 1', [currentRoom]);
            if (room.length === 0 || room[0].creator_id !== currentUser) return socket.emit('create_error', 'Unauthorized.');

            await db.query('UPDATE rooms SET password = ? WHERE id = ?', [password, currentRoom]);
            socket.emit('reward_success', 'Room password updated successfully!');
            broadcastRooms();
            syncRoom(currentRoom);
        } catch (err) { console.error('Change password error:', err); }
    });

    socket.on('kick_player', async ({ target_id }) => {
        try {
            if (!currentUser || !currentRoom) return;
            const [roomRows] = await db.query('SELECT is_private, creator_id FROM rooms WHERE id = ?', [currentRoom]);
            if (roomRows.length === 0 || !roomRows[0].is_private || roomRows[0].creator_id !== currentUser) return;

            await db.query('DELETE FROM room_members WHERE user_id = ? AND room_id = ?', [target_id, currentRoom]);
            
            io.to(`user_${target_id}`).emit('kicked_by_admin');
            
            const sockets = await io.in(`user_${target_id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                if (s.currentRoom === currentRoom) s.currentRoom = null;
            });

            syncRoom(currentRoom);
            broadcastRooms();
        } catch(err) { console.error('Kick player error:', err); }
    });

    socket.on('chat', async ({ message }) => {
        try {
            if (!currentUser || !currentRoom || !message.trim()) return;
            await db.query('INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)', [currentRoom, currentUser, message]);
            
            const [countRes] = await db.query('SELECT COUNT(*) as c FROM chats WHERE room_id = ?', [currentRoom]);
            if (countRes[0].c >= 40) {
                // Delete oldest ones ensuring only latest 20 remain
                await db.query(`
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
            const [room] = await db.query('SELECT current_drawer_id, status FROM rooms WHERE id = ?', [currentRoom]);
            if (room.length === 0 || room[0].status !== 'DRAWING') return;

            const isDrawer = room[0].current_drawer_id === currentUser;

            if (isDrawer) {
                await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [currentRoom]);
                await db.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', 'The drawer gave up.']);
            } else {
                await db.query('UPDATE room_members SET has_given_up = 1 WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
                await db.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', `${toHex(currentUser)} voted to give up.`]);

                const [members] = await db.query('SELECT user_id, has_given_up FROM room_members WHERE room_id = ?', [currentRoom]);
                const guessers = members.filter(m => m.user_id !== room[0].current_drawer_id);
                const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

                if (allGivenUp) {
                    await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [currentRoom]);
                    await db.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', 'All guessers gave up.']);
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
            
            const [room] = await db.query('SELECT word_to_draw, current_drawer_id, status FROM rooms WHERE id = ?', [currentRoom]);
            if (room.length === 0) return;
            if (room[0].status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
            if (room[0].current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');
            
            const [guessCount] = await db.query('SELECT COUNT(*) as count FROM guesses WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            
            if (guessCount[0].count >= 5) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < 1) {
                    return socket.emit('create_error', 'Not enough credits for extra guesses! (Cost: 1 Credit)');
                }
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
            }
            
            const isCorrect = room[0].word_to_draw && room[0].word_to_draw.toLowerCase() === guess.trim().toLowerCase();
            
            await db.query('INSERT INTO guesses (room_id, user_id, guess_text, is_correct) VALUES (?, ?, ?, ?)', [currentRoom, currentUser, guess.trim(), isCorrect]);
            if (isCorrect) {
                await db.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [currentUser, currentRoom]);
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

            const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < 2) return socket.emit('create_error', 'Not enough credits to buy a hint.');

            const [member] = await db.query('SELECT purchased_hints FROM room_members WHERE room_id = ? AND user_id = ?', [currentRoom, currentUser]);
            if(member.length === 0) return;

            let purchased = JSON.parse(member[0].purchased_hints || '[]');
            if (!purchased.includes(index)) {
                purchased.push(index);
                await db.query('UPDATE users SET credits = credits - 2 WHERE tg_id = ?', [currentUser]);
                await db.query('UPDATE room_members SET purchased_hints = ? WHERE room_id = ? AND user_id = ?', [JSON.stringify(purchased), currentRoom, currentUser]);
                
                await db.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [currentRoom, 'System', `${toHex(currentUser)} used a hint for 2 Credits!`]);
                
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

            await db.query("UPDATE rooms SET word_to_draw = ?, base_hints = ?, status = 'DRAWING', round_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [wordClean, JSON.stringify(hints), currentRoom, currentUser]);
            await db.query("UPDATE room_members SET purchased_hints = '[]', has_given_up = 0 WHERE room_id = ?", [currentRoom]);
            
            // Clean up drawing traces and guesses for the new round
            await db.query("DELETE FROM drawings WHERE room_id = ?", [currentRoom]);
            await db.query("DELETE FROM guesses WHERE room_id = ?", [currentRoom]);
            roomRedoStacks[currentRoom] = [];
            syncRoom(currentRoom);
        } catch (err) {
            console.error('Set Word Error:', err);
        }
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
            roomRedoStacks[currentRoom] = []; 
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
        
        const isInCall = Array.from(activeCalls.values()).some(
            c => c.caller === currentUser || c.receiver === currentUser ||
                 c.caller === receiver_id || c.receiver === receiver_id
        );
        
        if (isInCall) {
            return socket.emit('create_error', 'Cannot initiate call: User is already busy.');
        }

        const callId = `call_${Date.now()}_${Math.random()}`;
        const callObj = { id: callId, caller: currentUser, receiver: receiver_id, status: 'RINGING', room_id: currentRoom };
        activeCalls.set(callId, callObj);
        io.to(`room_${currentRoom}`).emit('call_update', callObj);
        syncRoom(currentRoom);
    });

    socket.on('accept_call', async ({ call_id }) => {
        const call = activeCalls.get(call_id);
        if (call && call.receiver === currentUser) {
            call.status = 'ACTIVE';
            call.startTime = Date.now();
            activeCalls.set(call_id, call);
            io.to(`room_${call.room_id}`).emit('call_update', call);
            
            call.interval = setInterval(async () => {
                const c = activeCalls.get(call_id);
                if(!c) return clearInterval(call.interval);
                
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ? AND credits > 0', [c.caller]);
                const [u1] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [c.caller]);
                
                if (u1[0].credits <= 0) {
                    clearInterval(call.interval);
                    activeCalls.delete(call_id);
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

    socket.on('end_call', ({ call_id }) => {
        const call = activeCalls.get(call_id);
        if (call) {
            if(call.interval) clearInterval(call.interval);
            activeCalls.delete(call_id);
            io.to(`room_${currentRoom || call.room_id}`).emit('call_ended', call_id);
            syncRoom(currentRoom || call.room_id);
        }
    });

    socket.on('webrtc_signal', ({ call_id, target_id, signal }) => {
        socket.to(`user_${target_id}`).emit('webrtc_signal_receive', { call_id, sender_id: currentUser, target_id, signal });
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            const timeoutId = setTimeout(async () => {
                terminateCallsForUser(currentUser); 
                if (currentRoom) {
                    await db.query('DELETE FROM room_members WHERE user_id = ?', [currentUser]);
                    await checkRoomReset(currentRoom);
                    syncRoom(currentRoom);
                    broadcastRooms();
                }
                disconnectTimeouts.delete(currentUser);
            }, 10000);

            disconnectTimeouts.set(currentUser, timeoutId);
        }
    });
});

setInterval(async () => {
    try {
        const [revealRooms] = await db.query("SELECT id FROM rooms WHERE status = 'REVEAL' AND break_end_time <= UTC_TIMESTAMP()");
        for (let r of revealRooms) {
            await db.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 600 SECOND) WHERE id = ?", [r.id]);
            await db.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [r.id]);
            syncRoom(r.id);
        }

        const [waitingRooms] = await db.query("SELECT * FROM rooms WHERE status IN ('WAITING', 'BREAK')");
        for (let r of waitingRooms) {
            const [members] = await db.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [r.id]);
            if (members.length >= 2 && members.every(m => m.is_ready)) {
                const nextDrawer = members[Math.floor(Math.random() * members.length)].user_id;
                await db.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?", [nextDrawer, r.id]);
                await db.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [r.id]);
                
                // Clear drawings and guesses for the upcoming round automatically
                await db.query("DELETE FROM guesses WHERE room_id = ?", [r.id]);
                await db.query("DELETE FROM drawings WHERE room_id = ?", [r.id]);
                roomRedoStacks[r.id] = [];
                syncRoom(r.id);
            }
        }
        
        const now = Date.now();
        io.sockets.sockets.forEach(s => {
            if (s.currentRoom) {
                const idleTime = now - (s.lastActiveEvent || now);
                if (idleTime > 60000) {
                    s.emit('kick_idle');
                    db.query('DELETE FROM room_members WHERE user_id = ?', [s.currentUser]).then(() => {
                        checkRoomReset(s.currentRoom).then(() => {
                            syncRoom(s.currentRoom);
                            broadcastRooms();
                        });
                    });
                    s.leave(`room_${s.currentRoom}`);
                    s.currentRoom = null;
                } else if (idleTime > 50000 && !s.idleWarned) {
                    s.idleWarned = true;
                    s.emit('idle_warning');
                } else if (idleTime <= 50000) {
                    s.idleWarned = false;
                }
            }
        });

        const currentDay = new Date().getUTCDate();
        if (currentDay !== lastCleanupDay) {
            lastCleanupDay = currentDay;
            db.query("DELETE FROM chats WHERE DATE(created_at) < UTC_DATE()").catch(console.error);
        }

        // Expiration check for private rooms
        const [expiredRooms] = await db.query("SELECT id FROM rooms WHERE is_private = 1 AND expire_at <= UTC_TIMESTAMP()");
        for (let r of expiredRooms) {
            io.to(`room_${r.id}`).emit('room_expired');
            await deleteRoom(r.id); // Cascade Deletion handled safely
            
            const sockets = await io.in(`room_${r.id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${r.id}`);
                s.currentRoom = null;
            });
            broadcastRooms();
        }

    } catch (e) { console.error("Game Loop Error:", e); }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
