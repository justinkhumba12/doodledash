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

// ---------------------------------------------------------
// RAM MEMORY STORAGE (Replacing Heavy MySQL Usage)
// ---------------------------------------------------------
const memoryRooms = new Map();
const roomChats = {};
const roomGuesses = {};
const roomDrawings = {};
const roomRedoStacks = {};
const userProfiles = new Map(); // Cache profile pics to avoid DB lookups

let nextRoomId = 1;
let chatCounter = 1;
let guessCounter = 1;
let drawingCounter = 1;

// Initialize 5 Default Public Rooms into RAM
for (let i = 1; i <= 5; i++) {
    memoryRooms.set(i, {
        id: i, status: 'WAITING', current_drawer_id: null, word_to_draw: null,
        round_end_time: null, break_end_time: null, last_winner_id: null,
        next_drawer_id: null, modified_at: new Date(), is_private: 0,
        password: null, max_members: 4, base_hints: '[]', creator_id: null, expire_at: null,
        members: [] // Replaces room_members table
    });
    roomChats[i] = [];
    roomGuesses[i] = [];
    roomDrawings[i] = [];
    roomRedoStacks[i] = [];
    nextRoomId = 6;
}

// ---------------------------------------------------------
// DATABASE CONNECTION (Only for Users / Credits)
// ---------------------------------------------------------
let db;
async function initDB() {
    const dbUrl = process.env.MYSQL_URL || 'mysql://root:dKIKDNsnObjDvJlZawBHjzaEsoetaATX@mysql.railway.internal:3306/railway';
    try {
        // Upgraded to connection pool for stability
        db = mysql.createPool({ uri: dbUrl, timezone: 'Z', waitForConnections: true, connectionLimit: 10 });
        console.log('Connected to MySQL Database (Pool).');

        // Drop deprecated tables as requested
        const tablesToDrop = ['rooms', 'room_members', 'drawings', 'chats', 'guesses', 'chat_messages'];
        for (let table of tablesToDrop) {
            await db.query(`DROP TABLE IF EXISTS ${table}`);
        }
        console.log('Cleaned up deprecated tables.');

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
                last_active DATETIME,
                tg_username VARCHAR(100)
            )
        `);

        // Migration logic
        const migrations = ["ALTER TABLE users ADD COLUMN tg_username VARCHAR(100)"];
        for (let query of migrations) {
            try { await db.query(query); } catch (e) { /* Ignore if column already exists */ }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

app.post('/webhook', async (req, res) => {
    const update = req.body;
    res.sendStatus(200); 

    const token = process.env.BOT_TOKEN; 
    if (!token) return;

    // Build WebApp URL dynamically (Fallback for missing ENV)
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const fallbackUrl = `${protocol}://${host}/`;
    const webAppUrl = process.env.WEBAPP_URL || fallbackUrl; 

    // Native Node.js request wrapper (100% compatible & avoids fetch() crashes on older node environments)
    const tgApiCall = (method, data) => {
        const https = require('https');
        const payload = JSON.stringify(data);
        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${token}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const request = https.request(options);
        request.on('error', console.error);
        request.write(payload);
        request.end();
    };

    const sendMsg = (chatId, text, replyMarkup) => {
        tgApiCall('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
    };

    if (update?.pre_checkout_query) {
        tgApiCall('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
        return;
    }

    if (update?.message?.successful_payment) {
        try {
            const payload = JSON.parse(update.message.successful_payment.invoice_payload);
            const addedCredits = payload.amount;
            const buyerId = payload.tgId;
            
            await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [addedCredits, buyerId]);
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
            // Guarantee user registers ONCE, granting 5 credits.
            await db.query('INSERT IGNORE INTO users (tg_id, credits, last_active, tg_username) VALUES (?, 5, UTC_TIMESTAMP(), ?)', [tgId.toString(), username || null]);
            // Update activity state safely without resetting their credits.
            await db.query('UPDATE users SET last_active = UTC_TIMESTAMP(), tg_username = ? WHERE tg_id = ?', [username || null, tgId.toString()]);
        } catch (e) {
            console.error('Webhook DB Error:', e);
        }

        if (update.message.text === '/start load_balance') {
            sendMsg(chatId, "💎 Select a package to top up your credits:\n\n*Rate: 1 Credit = 1 Telegram Star*", {
                inline_keyboard: [
                    [{ text: '1 Credit (1 ⭐️)', callback_data: 'buy_1' }, { text: '10 Credits (10 ⭐️)', callback_data: 'buy_10' }],
                    [{ text: '20 Credits (20 ⭐️)', callback_data: 'buy_20' }, { text: '50 Credits (50 ⭐️)', callback_data: 'buy_50' }],
                    [{ text: '100 Credits (100 ⭐️)', callback_data: 'buy_100' }],
                    [{ text: '500 Credits (500 ⭐️)', callback_data: 'buy_500' }],
                    [{ text: '1000 Credits (1000 ⭐️)', callback_data: 'buy_1000' }]
                ]
            });
            return;
        }

        const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
        sendMsg(chatId, 'Welcome to DoodleDash! Click below to play.', {
            inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
        });
    } else if (update?.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const tgId = query.from.id;

        if (query.data.startsWith('buy_')) {
            const amount = parseInt(query.data.split('_')[1]);
            const stars = amount; // 1 cred = 1 star
            
            const payload = JSON.stringify({ tgId: tgId.toString(), amount: amount });
            
            tgApiCall('sendInvoice', {
                chat_id: chatId,
                title: `${amount} DoodleDash Credits`,
                description: `Top up your account with ${amount} credits.`,
                payload: payload,
                provider_token: "", // Empty for Telegram Stars
                currency: "XTR",
                prices: [{ label: `${amount} Credits`, amount: stars }]
            });
            
            tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
        }
    }
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
const disconnectTimeouts = new Map(); 

// ---------------------------------------------------------
// RAM-BASED LOBBY & ROOM FUNCTIONS
// ---------------------------------------------------------
const broadcastRooms = () => {
    const roomsList = [];
    for (const [id, room] of memoryRooms.entries()) {
        roomsList.push({
            id: room.id,
            status: room.status,
            is_private: room.is_private,
            max_members: room.max_members,
            creator_id: room.creator_id,
            password: room.password,
            member_count: room.members.length
        });
    }

    io.sockets.sockets.forEach(s => {
        const userId = s.currentUser;
        const customizedRooms = roomsList.map(r => {
            if (r.creator_id === userId) return r; 
            const { password, ...safeRoom } = r;
            return safeRoom;
        });
        s.emit('lobby_rooms_update', customizedRooms);
    });
};

const deleteRoom = (roomId) => {
    if (!roomId) return;
    memoryRooms.delete(roomId);
    delete roomChats[roomId];
    delete roomGuesses[roomId];
    delete roomDrawings[roomId];
    delete roomRedoStacks[roomId];
};

const checkRoomReset = (roomId) => {
    if (!roomId) return;
    const room = memoryRooms.get(roomId);
    if (!room) return;

    if (room.members.length === 0) {
        if (roomId !== 1 && roomId !== 2 && !room.is_private) {
            deleteRoom(roomId);
        } else {
            room.status = 'WAITING';
            room.current_drawer_id = null;
            room.word_to_draw = null;
            room.members = [];
            roomChats[roomId] = [];
            roomGuesses[roomId] = [];
            roomDrawings[roomId] = [];
            roomRedoStacks[roomId] = [];
        }
    } else if (room.members.length < 2) {
        room.status = 'WAITING';
        room.current_drawer_id = null;
        room.word_to_draw = null;
        room.members.forEach(m => m.has_given_up = 0);
    }
};

const syncRoom = (roomId) => {
    if (!roomId) return;
    const room = memoryRooms.get(roomId);
    if (!room) return;

    const members = room.members;
    const chats = roomChats[roomId] || [];
    const guesses = roomGuesses[roomId] || [];
    const drawings = roomDrawings[roomId] || [];

    // Zero Database Hits for Profile Syncing using RAM Cache
    let profiles = {};
    const userIds = new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)]);
    userIds.forEach(id => {
        profiles[id] = userProfiles.get(id) || null;
    });

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
                const isDrawer = room.current_drawer_id === userId;
                
                const sanitizedGuesses = guesses.map(g => {
                    if (isDrawer || g.user_id === userId || room.status === 'REVEAL' || room.status === 'BREAK') {
                        return g;
                    }
                    return { ...g, guess_text: '••••••••' };
                });

                let masked_word = null;
                if (['DRAWING', 'REVEAL', 'BREAK'].includes(room.status)) {
                    const base_hints = JSON.parse(room.base_hints || '[]');
                    const actual_word = room.word_to_draw || '';
                    const memberData = members.find(m => m.user_id === userId);
                    const purchased_hints = JSON.parse(memberData?.purchased_hints || '[]');
                    const isReveal = room.status !== 'DRAWING';
                    
                    masked_word = actual_word.split('').map((char, index) => {
                        if (char === ' ') return { char: ' ', index, revealed: true };
                        if (isDrawer || isReveal || base_hints.includes(index) || purchased_hints.includes(index)) {
                            return { char, index, revealed: true };
                        }
                        return { char: null, index, revealed: false };
                    });
                }

                s.emit('room_sync', {
                    room: { ...room, expire_at: room.expire_at ? room.expire_at.toISOString() : null }, // Serialize Date obj
                    members,
                    chats, 
                    guesses: sanitizedGuesses,
                    drawings: drawings.map(d => d.line_data),
                    profiles,
                    activeCalls: activeCallsList,
                    masked_word: masked_word,
                    server_time: new Date().toISOString()
                });
            }
        }
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

    const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
        const room = memoryRooms.get(roomIdNum);
        if (!room) return socket.emit('join_error', 'Room not found.');

        if (room.members.length >= room.max_members) return socket.emit('join_error', 'Room is full.');

        const existingMember = room.members.find(m => m.user_id === userId);
        if (existingMember) {
            currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.emit('join_success', roomIdNum);
            return syncRoom(roomIdNum);
        }

        if (!bypassCost) {
            if (room.is_private) {
                if (room.password !== password) return socket.emit('join_error', 'Incorrect password.');
            } else if (roomIdNum !== 1 && roomIdNum !== 2) {
                // Database check for premium features
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [userId]);
                if (u[0].credits < 1) return socket.emit('join_error', 'Not enough credits. Public rooms cost 1 credit.');
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [userId]);
            }
        }

        const oldRoom = currentRoom;
        if (oldRoom) {
            terminateCallsForUser(userId); 
            socket.leave(`room_${oldRoom}`);
            const oRoom = memoryRooms.get(oldRoom);
            if (oRoom) {
                oRoom.members = oRoom.members.filter(m => m.user_id !== userId);
                checkRoomReset(oldRoom);
            }
        }

        // Add to RAM Room
        room.members.push({
            room_id: roomIdNum,
            user_id: userId,
            is_ready: 0,
            consecutive_turns: 0,
            total_turns: 0,
            has_given_up: 0,
            purchased_hints: '[]',
            stroke_count: 0,
            extra_strokes: 0
        });

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
            
            if (profile_pic) userProfiles.set(tg_id, profile_pic);

            // Clear disconnect timeouts upon smooth reconnect
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
            
            // Re-bind to RAM Room seamlessly without dropping calls
            for (const [id, room] of memoryRooms.entries()) {
                if (room.members.some(m => m.user_id === tg_id)) {
                    currentRoom = id;
                    socket.join(`room_${currentRoom}`);
                    syncRoom(currentRoom);
                    break;
                }
            }

            // Build Room Data for Frontend
            const roomsList = [];
            for (const [id, room] of memoryRooms.entries()) {
                roomsList.push({
                    id: room.id, status: room.status, is_private: room.is_private, max_members: room.max_members,
                    creator_id: room.creator_id, password: room.creator_id === tg_id ? room.password : null, member_count: room.members.length
                });
            }

            socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom });
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
            let cost = (auto_join && !is_private) ? 1 : 0;
            let expDate = null;
            
            if (is_private) {
                if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be exactly 6 to 10 characters.');
                const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
                let timeCost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
                cost += limit + timeCost;
                expDate = new Date(Date.now() + hours * 3600000);
            }

            if (cost > 0) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < cost) return socket.emit('create_error', `Not enough credits. Costs ${cost} credits.`);
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            }

            const newRoomId = nextRoomId++;
            memoryRooms.set(newRoomId, {
                id: newRoomId, status: 'WAITING', current_drawer_id: null, word_to_draw: null,
                round_end_time: null, break_end_time: null, last_winner_id: null, next_drawer_id: null,
                modified_at: new Date(), is_private: is_private ? 1 : 0, password: is_private ? password : null,
                max_members: limit, base_hints: '[]', creator_id: is_private ? currentUser : null, expire_at: expDate,
                members: []
            });
            roomChats[newRoomId] = [];
            roomGuesses[newRoomId] = [];
            roomDrawings[newRoomId] = [];
            roomRedoStacks[newRoomId] = [];

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

    socket.on('search_room', ({ room_id }) => {
        const room = memoryRooms.get(Number(room_id));
        if (!room) return socket.emit('join_error', 'Room not found.');
        socket.emit('search_result', { id: room.id, is_private: room.is_private });
    });

    socket.on('join_room', async ({ room_id, password }) => {
        try {
            if (!currentUser) return;
            await performJoinRoom(currentUser, Number(room_id), password, false);
        } catch (err) {}
    });

    socket.on('leave_room', () => {
        if (!currentUser || !currentRoom) return;
        terminateCallsForUser(currentUser); 
        const room = memoryRooms.get(currentRoom);
        if (room) {
            room.members = room.members.filter(m => m.user_id !== currentUser);
            checkRoomReset(currentRoom);
        }
        socket.leave(`room_${currentRoom}`);
        syncRoom(currentRoom);
        currentRoom = null;
        broadcastRooms();
    });

    socket.on('extend_room', async ({ expire_hours }) => {
        try {
            if (!currentUser || !currentRoom) return;
            const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
            let cost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
            
            const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');
            
            const room = memoryRooms.get(currentRoom);
            if (!room || !room.is_private) return;

            await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
            room.expire_at = new Date(room.expire_at.getTime() + hours * 3600000);
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            syncRoom(currentRoom);
        } catch(err) { console.error('Extend room error:', err); }
    });

    socket.on('change_password', ({ password }) => {
        if (!currentUser || !currentRoom) return;
        if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be 6-10 characters.');
        
        const room = memoryRooms.get(currentRoom);
        if (!room || !room.is_private || room.creator_id !== currentUser) return socket.emit('create_error', 'Unauthorized.');

        room.password = password;
        socket.emit('reward_success', 'Room password updated successfully!');
        broadcastRooms();
        syncRoom(currentRoom);
    });

    socket.on('kick_player', async ({ target_id }) => {
        if (!currentUser || !currentRoom) return;
        const room = memoryRooms.get(currentRoom);
        if (!room || !room.is_private || room.creator_id !== currentUser) return;

        room.members = room.members.filter(m => m.user_id !== target_id);
        
        io.to(`user_${target_id}`).emit('kicked_by_admin');
        const sockets = await io.in(`user_${target_id}`).fetchSockets();
        sockets.forEach(s => {
            s.leave(`room_${currentRoom}`);
            if (s.currentRoom === currentRoom) s.currentRoom = null;
        });

        syncRoom(currentRoom);
        broadcastRooms();
    });

    socket.on('chat', ({ message }) => {
        if (!currentUser || !currentRoom || !message.trim()) return;
        
        if (!roomChats[currentRoom]) roomChats[currentRoom] = [];
        roomChats[currentRoom].push({ id: chatCounter++, room_id: currentRoom, user_id: currentUser, message, created_at: new Date() });
        
        if (roomChats[currentRoom].length > 40) {
            roomChats[currentRoom].shift(); 
        }

        syncRoom(currentRoom);
    });

    socket.on('give_up', () => {
        if (!currentUser || !currentRoom) return;
        const room = memoryRooms.get(currentRoom);
        if (!room || room.status !== 'DRAWING') return;

        const isDrawer = room.current_drawer_id === currentUser;

        if (isDrawer) {
            room.status = 'REVEAL';
            room.break_end_time = new Date(Date.now() + 5000); // 5 sec reveal wait
            room.last_winner_id = null;
            if (!roomChats[currentRoom]) roomChats[currentRoom] = [];
            roomChats[currentRoom].push({ id: chatCounter++, room_id: currentRoom, user_id: 'System', message: 'The drawer gave up.', created_at: new Date() });
        } else {
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) member.has_given_up = 1;
            
            if (!roomChats[currentRoom]) roomChats[currentRoom] = [];
            roomChats[currentRoom].push({ id: chatCounter++, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} voted to give up.`, created_at: new Date() });

            const guessers = room.members.filter(m => m.user_id !== room.current_drawer_id);
            const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

            if (allGivenUp) {
                room.status = 'REVEAL';
                room.break_end_time = new Date(Date.now() + 5000);
                room.last_winner_id = null;
                roomChats[currentRoom].push({ id: chatCounter++, room_id: currentRoom, user_id: 'System', message: 'All guessers gave up.', created_at: new Date() });
            }
        }
        syncRoom(currentRoom);
    });

    socket.on('guess', async ({ guess }) => {
        try {
            if (!currentUser || !currentRoom) return socket.emit('create_error', 'Not logged in or in room.');
            if (!guess || !guess.trim()) return;
            
            const room = memoryRooms.get(currentRoom);
            if (!room) return;
            if (room.status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
            if (room.current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');
            
            const currentGuesses = roomGuesses[currentRoom] || [];
            const myGuessCount = currentGuesses.filter(g => g.user_id === currentUser).length;
            
            if (myGuessCount >= 5) {
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (u[0].credits < 1) return socket.emit('create_error', 'Not enough credits for extra guesses! (Cost: 1 Credit)');
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
            }
            
            const isCorrect = room.word_to_draw && room.word_to_draw.toLowerCase() === guess.trim().toLowerCase();
            
            roomGuesses[currentRoom].push({ id: guessCounter++, room_id: currentRoom, user_id: currentUser, guess_text: guess.trim(), is_correct: isCorrect ? 1 : 0, created_at: new Date() });

            if (isCorrect) {
                room.status = 'REVEAL';
                room.break_end_time = new Date(Date.now() + 5000); // 5 sec show screen
                room.last_winner_id = currentUser;
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

            const room = memoryRooms.get(currentRoom);
            if (!room) return;
            const member = room.members.find(m => m.user_id === currentUser);
            if (!member) return;

            let purchased = JSON.parse(member.purchased_hints || '[]');
            if (!purchased.includes(index)) {
                purchased.push(index);
                await db.query('UPDATE users SET credits = credits - 2 WHERE tg_id = ?', [currentUser]);
                member.purchased_hints = JSON.stringify(purchased);
                
                if (!roomChats[currentRoom]) roomChats[currentRoom] = [];
                roomChats[currentRoom].push({ id: chatCounter++, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} used a hint for 2 Credits!`, created_at: new Date() });
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                
                syncRoom(currentRoom);
            }
        } catch (err) {
            console.error('Buy Hint Error:', err);
        }
    });

    socket.on('set_word', ({ word }) => {
        if (!currentUser || !currentRoom) return;
        const room = memoryRooms.get(currentRoom);
        if (!room || room.current_drawer_id !== currentUser) return;

        const wordClean = word.trim().toUpperCase();
        if (wordClean.length < 3 || wordClean.length > 10) return socket.emit('create_error', 'Word must be between 3 and 10 characters.');

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

        room.word_to_draw = wordClean;
        room.base_hints = JSON.stringify(hints);
        room.status = 'DRAWING';
        room.round_end_time = new Date(Date.now() + 120000);
        
        room.members.forEach(m => {
            m.purchased_hints = '[]';
            m.has_given_up = 0;
            m.stroke_count = 0;
            m.extra_strokes = 0;
        });
        
        // RAM Clearing for new round
        roomDrawings[currentRoom] = [];
        roomGuesses[currentRoom] = [];
        roomRedoStacks[currentRoom] = [];
        
        syncRoom(currentRoom);
    });

    socket.on('set_ready', () => {
        if (!currentUser || !currentRoom) return;
        const room = memoryRooms.get(currentRoom);
        if (!room) return;
        const member = room.members.find(m => m.user_id === currentUser);
        if (member) {
            member.is_ready = 1;
            syncRoom(currentRoom);
        }
    });

    socket.on('draw', ({ lines }) => {
        if (!currentUser || !currentRoom) return;
        const room = memoryRooms.get(currentRoom);
        if (!room) return;

        const member = room.members.find(m => m.user_id === currentUser);
        if (member) {
            const maxStrokes = 30 + (member.extra_strokes || 0); // Cap at 30 strokes
            
            if ((member.stroke_count || 0) >= maxStrokes) {
                return socket.emit('ink_empty'); // Tell client they are out of ink
            }
            member.stroke_count = (member.stroke_count || 0) + 1;
        }

        roomRedoStacks[currentRoom] = []; 
        if (!roomDrawings[currentRoom]) roomDrawings[currentRoom] = [];
        roomDrawings[currentRoom].push({ id: drawingCounter++, line_data: JSON.stringify(lines) });
        socket.to(`room_${currentRoom}`).emit('live_draw', lines);
    });

    socket.on('buy_ink', async () => {
        try {
            if (!currentUser || !currentRoom) return;
            const room = memoryRooms.get(currentRoom);
            if (!room || room.status !== 'DRAWING') return;

            const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (u[0].credits < 1) return socket.emit('create_error', 'Not enough credits to buy more ink.');

            await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);

            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                member.extra_strokes = (member.extra_strokes || 0) + 30; // Grant 30 more strokes
                socket.emit('reward_success', '+30 Extra Strokes added!');
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            }
        } catch (err) {
            console.error('Buy Ink Error:', err);
        }
    });

    socket.on('undo', () => {
        if (!currentUser || !currentRoom) return;
        if (roomDrawings[currentRoom] && roomDrawings[currentRoom].length > 0) {
            if (!roomRedoStacks[currentRoom]) roomRedoStacks[currentRoom] = [];
            const toRestore = roomDrawings[currentRoom].pop();
            roomRedoStacks[currentRoom].push(toRestore);
            syncRoom(currentRoom);
        }
    });

    socket.on('redo', () => {
        if (!currentUser || !currentRoom) return;
        if (roomRedoStacks[currentRoom] && roomRedoStacks[currentRoom].length > 0) {
            const toRestore = roomRedoStacks[currentRoom].pop();
            roomDrawings[currentRoom].push(toRestore);
            syncRoom(currentRoom);
        }
    });

    socket.on('initiate_call', async ({ receiver_id }) => {
        if (!currentUser || !currentRoom) return;
        
        const isInCall = Array.from(activeCalls.values()).some(
            c => c.caller === currentUser || c.receiver === currentUser ||
                 c.caller === receiver_id || c.receiver === receiver_id
        );
        
        if (isInCall) return socket.emit('create_error', 'Cannot initiate call: User is already busy.');

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
            const timeoutId = setTimeout(() => {
                terminateCallsForUser(currentUser); 
                if (currentRoom) {
                    const room = memoryRooms.get(currentRoom);
                    if (room) {
                        room.members = room.members.filter(m => m.user_id !== currentUser);
                        checkRoomReset(currentRoom);
                    }
                    syncRoom(currentRoom);
                    broadcastRooms();
                }
                disconnectTimeouts.delete(currentUser);
            }, 120000); // Massive 2-minute grace period to completely hide TCP disconnections / Server Restarts from user.

            disconnectTimeouts.set(currentUser, timeoutId);
        }
    });
});

// ---------------------------------------------------------
// RAM-BASED GAME LOOP ENGINE
// ---------------------------------------------------------
setInterval(() => {
    try {
        const now = Date.now();
        
        // Handle Game States for all active rooms
        for (const [roomId, room] of memoryRooms.entries()) {
            
            // 1. Reveal -> Break Transition
            if (room.status === 'REVEAL' && room.break_end_time && now >= room.break_end_time.getTime()) {
                room.status = 'BREAK';
                room.break_end_time = new Date(now + 600000); // Wait up to 10 min for ready
                room.members.forEach(m => m.has_given_up = 0);
                syncRoom(roomId);
            }

            // 2. Waiting/Break -> Pre Draw Transition
            if (room.status === 'WAITING' || room.status === 'BREAK') {
                if (room.members.length >= 2 && room.members.every(m => m.is_ready)) {
                    const nextDrawer = room.members[Math.floor(Math.random() * room.members.length)].user_id;
                    room.status = 'PRE_DRAW';
                    room.current_drawer_id = nextDrawer;
                    room.word_to_draw = null;
                    room.members.forEach(m => m.is_ready = 0);
                    
                    // Clear round data
                    roomGuesses[roomId] = [];
                    roomDrawings[roomId] = [];
                    roomRedoStacks[roomId] = [];
                    syncRoom(roomId);
                }
            }

            // 3. Expiration Check for Private Rooms
            if (room.is_private && room.expire_at && now >= room.expire_at.getTime()) {
                io.to(`room_${roomId}`).emit('room_expired');
                deleteRoom(roomId); 
                
                io.in(`room_${roomId}`).fetchSockets().then(sockets => {
                    sockets.forEach(s => {
                        s.leave(`room_${roomId}`);
                        s.currentRoom = null;
                    });
                });
                broadcastRooms();
            }
        }
        
        // 4. Idle Client Kick Check
        io.sockets.sockets.forEach(s => {
            if (s.currentRoom) {
                const idleTime = now - (s.lastActiveEvent || now);
                if (idleTime > 60000) {
                    s.emit('kick_idle');
                    const room = memoryRooms.get(s.currentRoom);
                    if (room) {
                        room.members = room.members.filter(m => m.user_id !== s.currentUser);
                        checkRoomReset(s.currentRoom);
                        syncRoom(s.currentRoom);
                        broadcastRooms();
                    }
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

    } catch (e) { console.error("Game Loop Error:", e); }
}, 5000); // 5-second interval instead of 1-second to drastically reduce CPU load.

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
