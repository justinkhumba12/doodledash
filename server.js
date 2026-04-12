const cluster = require('cluster');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MYSQL_URL = process.env.MYSQL_URL || 'mysql://root:password@localhost:3306/db';
const PORT = process.env.PORT || 3000;
const NUM_WORKERS = process.env.WORKERS ? parseInt(process.env.WORKERS) : (os.cpus().length || 8);

// ---------------------------------------------------------
// PRIMARY PROCESS (Run once on startup)
// ---------------------------------------------------------
if (cluster.isPrimary) {
    console.log(`[Primary] Process ID: ${process.pid}`);
    console.log(`[Primary] Preparing to fork ${NUM_WORKERS} workers...`);

    const setupPrimary = async () => {
        // 1. DATABASE SETUP (Run only once to avoid race conditions)
        let db;
        try {
            console.log('[Primary] Connecting to MySQL for initial setup...');
            db = await mysql.createConnection(MYSQL_URL);
            
            const tablesToDrop = ['rooms', 'room_members', 'drawings', 'chats', 'guesses', 'chat_messages'];
            for (let table of tablesToDrop) {
                await db.query(`DROP TABLE IF EXISTS ${table}`);
            }

            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    tg_id VARCHAR(50) PRIMARY KEY,
                    credits DECIMAL(10,2) DEFAULT 0,
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

            const migrations = [
                "ALTER TABLE users ADD COLUMN tg_username VARCHAR(100)",
                "ALTER TABLE users MODIFY COLUMN credits DECIMAL(10,2) DEFAULT 0"
            ];
            for (let query of migrations) {
                try { await db.query(query); } catch (e) { /* Ignore existing column errors */ }
            }
            console.log('[Primary] MySQL setup complete.');
        } catch (err) {
            console.error('[Primary] MySQL Init Error:', err);
            process.exit(1);
        } finally {
            if (db) await db.end();
        }

        // 2. REDIS SETUP (Initialize default rooms)
        let redis;
        try {
            console.log('[Primary] Connecting to Redis for initial setup...');
            redis = new Redis(REDIS_URL);
            
            const nextId = await redis.get('next_room_id');
            if (!nextId) await redis.set('next_room_id', 6);

            for (let i = 1; i <= 5; i++) {
                const exists = await redis.sismember('active_rooms', i);
                if (!exists) {
                    const room = {
                        id: i, status: 'WAITING', current_drawer_id: null, word_to_draw: null,
                        round_end_time: null, break_end_time: null, last_winner_id: null, end_reason: null,
                        turn_index: 0, modified_at: new Date(), is_private: 0,
                        password: null, max_members: 4, base_hints: '[]', creator_id: null, expire_at: null,
                        undo_steps: 0, redo_steps: 0,
                        members: [] 
                    };
                    await redis.set(`room:${i}`, JSON.stringify(room));
                    await redis.sadd('active_rooms', i);
                }
            }
            console.log('[Primary] Redis room setup complete.');
        } catch (err) {
            console.error('[Primary] Redis Init Error:', err);
            process.exit(1);
        } finally {
            if (redis) await redis.quit();
        }

        // 3. FORK WORKERS
        for (let i = 0; i < NUM_WORKERS; i++) {
            cluster.fork();
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[Primary] Worker ${worker.process.pid} died. Restarting...`);
            cluster.fork();
        });
    };

    setupPrimary();

} else {
    // ---------------------------------------------------------
    // WORKER PROCESS
    // ---------------------------------------------------------
    const app = express();
    const server = http.createServer(app);

    // Redis Connections for this worker
    const redis = new Redis(REDIS_URL);
    const pubClient = redis.duplicate();
    const subClient = redis.duplicate();

    redis.on('error', (err) => console.error(`[Worker ${process.pid}] Redis Error:`, err));

    const io = new Server(server, {
        cors: { origin: "*", methods: ["GET", "POST"] },
        adapter: createAdapter(pubClient, subClient)
    });

    // Database Connection Pool for this worker (Limited to 5 to avoid Max Connections errors across 8 workers)
    const db = mysql.createPool({ 
        uri: MYSQL_URL, 
        timezone: 'Z', 
        waitForConnections: true, 
        connectionLimit: 5 
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

    const INK_CONFIG = {
        black: { free: 2500, extra: 2000, cost: 0.5 }
    };

    // ---------------------------------------------------------
    // REDIS HELPERS
    // ---------------------------------------------------------
    async function getRoom(roomId) {
        const data = await redis.get(`room:${roomId}`);
        if (!data) return null;
        const room = JSON.parse(data);
        if (room.modified_at) room.modified_at = new Date(room.modified_at);
        if (room.expire_at) room.expire_at = new Date(room.expire_at);
        if (room.break_end_time) room.break_end_time = new Date(room.break_end_time);
        if (room.round_end_time) room.round_end_time = new Date(room.round_end_time);
        return room;
    }

    async function saveRoom(room) {
        room.modified_at = new Date();
        await redis.set(`room:${room.id}`, JSON.stringify(room));
        await redis.sadd('active_rooms', room.id);
    }

    async function releaseRoomMemory(roomId) {
        await redis.del(`room:${roomId}:drawings`, `room:${roomId}:redo`);
    }

    async function deleteRoomData(roomId) {
        if (!roomId) return;
        await redis.del(`room:${roomId}`, `room:${roomId}:chats`, `room:${roomId}:guesses`, `room:${roomId}:drawings`, `room:${roomId}:redo`);
        await redis.srem('active_rooms', roomId);
    }

    // ---------------------------------------------------------
    // WEBHOOK & REST API
    // ---------------------------------------------------------
    app.post('/webhook', async (req, res) => {
        const update = req.body;
        res.sendStatus(200); 

        const token = process.env.BOT_TOKEN; 
        if (!token) return;

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const fallbackUrl = `${protocol}://${host}/`;
        const webAppUrl = process.env.WEBAPP_URL || fallbackUrl; 

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
                
                const currentCredits = parseFloat(await redis.hget('user_credits', buyerId)) || 0;
                await redis.hset('user_credits', buyerId, currentCredits + addedCredits);
                
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
                await db.query('INSERT IGNORE INTO users (tg_id, credits, last_active, UTC_TIMESTAMP(), ?)', [tgId.toString(), username || null]);
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
                const stars = amount; 
                
                const payload = JSON.stringify({ tgId: tgId.toString(), amount: amount });
                
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `${amount} DoodleDash Credits`,
                    description: `Top up your account with ${amount} credits.`,
                    payload: payload,
                    provider_token: "", 
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
            (last_ad_claim_time IS NULL OR DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad_claims_today < 3 AND TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()) >= 60)) as ad1_available,
            (last_ad2_claim_time IS NULL OR DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad2_claims_today < 5 AND TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()) >= 45)) as ad2_available,
            GREATEST(0, 60 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()), 60)) as ad1_wait_mins,
            GREATEST(0, 45 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()), 45)) as ad2_wait_mins,
            (DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad1_is_today,
            (DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad2_is_today
            FROM users WHERE tg_id = ?
        `, [tg_id]);

        if (rows.length === 0) return null;
        let u = rows[0];
        
        // Fix for manual DB Edits: ALWAYS sync DB value to Redis cache
        await redis.hset('user_credits', tg_id, u.credits);
        
        if (!u.ad1_is_today) u.ad_claims_today = 0;
        if (!u.ad2_is_today) u.ad2_claims_today = 0;
        return u;
    }

    // ---------------------------------------------------------
    // LOBBY & ROOM FUNCTIONS
    // ---------------------------------------------------------
    const broadcastRooms = async () => {
        const activeIds = await redis.smembers('active_rooms');
        const roomsList = [];
        for (const id of activeIds) {
            const room = await getRoom(id);
            if (room) {
                roomsList.push({
                    id: room.id,
                    status: room.status,
                    is_private: room.is_private,
                    max_members: room.max_members,
                    creator_id: room.creator_id,
                    member_count: room.members.length
                });
            }
        }
        io.to('lobby').emit('lobby_rooms_update', roomsList);
    };

    const checkRoomReset = async (roomId) => {
        if (!roomId) return;
        const room = await getRoom(roomId);
        if (!room) return;

        if (room.members.length === 0) {
            if (roomId > 5 && !room.is_private) {
                await deleteRoomData(roomId);
            } else if (!room.is_private) {
                room.status = 'WAITING';
                room.current_drawer_id = null;
                room.word_to_draw = null;
                room.break_end_time = null;
                room.round_end_time = null;
                room.end_reason = null;
                room.members = [];
                room.turn_index = 0;
                await releaseRoomMemory(roomId); 
                await redis.del(`room:${roomId}:guesses`, `room:${roomId}:chats`); 
                await saveRoom(room);
            }
        } else if (room.members.length < 2) {
            room.status = 'WAITING';
            room.current_drawer_id = null;
            room.word_to_draw = null;
            room.break_end_time = null;
            room.round_end_time = null;
            room.end_reason = null;
            room.members.forEach(m => m.has_given_up = 0);
            await releaseRoomMemory(roomId); 
            await redis.del(`room:${roomId}:guesses`);
            await saveRoom(room);
        }
    };

    const syncRoom = async (roomId) => {
        if (!roomId) return;
        const room = await getRoom(roomId);
        if (!room) return;

        const members = room.members;
        const rawChats = await redis.lrange(`room:${roomId}:chats`, 0, -1);
        const chats = rawChats.map(c => JSON.parse(c));
        
        const rawGuesses = await redis.lrange(`room:${roomId}:guesses`, 0, -1);
        const guesses = rawGuesses.map(g => JSON.parse(g));

        const userIds = new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)]);
        const profiles = {};
        if (userIds.size > 0) {
            const idsArr = Array.from(userIds);
            const results = await redis.hmget('user_profiles', ...idsArr);
            idsArr.forEach((id, i) => profiles[id] = results[i] || null);
        }

        const allCalls = await redis.hgetall('active_calls');
        const activeCallsList = [];
        for (const key in allCalls) {
            const c = JSON.parse(allCalls[key]);
            if (c.room_id == roomId) {
                activeCallsList.push({ id: c.id, caller: c.caller, receiver: c.receiver, status: c.status, room_id: c.room_id });
            }
        }

        const roomSockets = await io.in(`room_${roomId}`).fetchSockets();
        if (roomSockets) {
            for (const s of roomSockets) {
                const userId = s.data.currentUser;
                if (!userId) continue;

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
                    room: { 
                        ...room, 
                        expire_at: room.expire_at ? room.expire_at.toISOString() : null,
                        break_end_time: room.break_end_time ? room.break_end_time.toISOString() : null,
                        round_end_time: room.round_end_time ? room.round_end_time.toISOString() : null
                    },
                    members,
                    chats, 
                    guesses: sanitizedGuesses,
                    profiles,
                    activeCalls: activeCallsList,
                    masked_word: masked_word,
                    server_time: new Date().toISOString()
                });
            }
        }
    };

    const terminateCallsForUser = async (userId) => {
        const allCalls = await redis.hgetall('active_calls');
        for (const [callId, callStr] of Object.entries(allCalls)) {
            const call = JSON.parse(callStr);
            if (call.caller === userId || call.receiver === userId) {
                await redis.hdel('active_calls', callId);
                io.to(`room_${call.room_id}`).emit('call_ended', callId);
                await syncRoom(call.room_id);
            }
        }
    };

    // ---------------------------------------------------------
    // SOCKET.IO EVENTS
    // ---------------------------------------------------------
    io.on('connection', (socket) => {
        socket.data.lastActiveEvent = Date.now();
        socket.data.idleWarned = false;
        socket.data.currentUser = null;
        socket.data.currentRoom = null;

        const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
            const room = await getRoom(roomIdNum);
            if (!room) return socket.emit('join_error', 'Room not found.');
            if (room.members.length >= room.max_members) return socket.emit('join_error', 'Room is full.');

            const existingMember = room.members.find(m => m.user_id === userId);
            if (existingMember) {
                socket.data.currentRoom = roomIdNum;
                socket.join(`room_${roomIdNum}`);
                socket.leave('lobby'); 
                socket.emit('join_success', roomIdNum);
                return await syncRoom(roomIdNum);
            }

            if (!bypassCost) {
                if (room.is_private) {
                    if (room.creator_id !== userId && room.password !== password) {
                        return socket.emit('join_error', 'Incorrect password.');
                    }
                }
            }

            const oldRoom = socket.data.currentRoom;
            if (oldRoom) {
                await terminateCallsForUser(userId); 
                socket.leave(`room_${oldRoom}`);
                const oRoom = await getRoom(oldRoom);
                if (oRoom) {
                    oRoom.members = oRoom.members.filter(m => m.user_id !== userId);
                    await saveRoom(oRoom);
                    await checkRoomReset(oldRoom);
                }
            }

            room.members.push({
                room_id: roomIdNum,
                user_id: userId,
                is_ready: 0,
                consecutive_turns: 0,
                total_turns: 0,
                has_given_up: 0,
                purchased_hints: '[]',
                ink_used: {},      
                ink_extra: {},     
                joined_at: Date.now() 
            });

            await saveRoom(room);
            socket.data.currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.leave('lobby');
            socket.emit('join_success', roomIdNum);
            
            if (oldRoom) await syncRoom(oldRoom);
            await syncRoom(roomIdNum);
            await broadcastRooms();

            const userState = await getUserState(userId);
            if (userState) socket.emit('user_update', userState);
        };

        socket.on('auth', async ({ tg_id, profile_pic }) => {
            try {
                if (!tg_id) return;
                socket.data.currentUser = String(tg_id);
                const currentUser = socket.data.currentUser;
                
                if (profile_pic) {
                    await redis.hset('user_profiles', currentUser, profile_pic);
                }

                await redis.hdel('user_disconnects', currentUser);

                socket.join(`user_${currentUser}`);
                
                await db.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [currentUser]);
                if (profile_pic) {
                    await db.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, currentUser]);
                } else {
                    await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [currentUser]);
                }

                // Removed redundant Redis setting here because getUserState will handle DB priority.
                const userState = await getUserState(currentUser);
                
                const activeRooms = await redis.smembers('active_rooms');
                let foundRoom = null;
                for (const id of activeRooms) {
                    const room = await getRoom(id);
                    if (room && room.members.some(m => String(m.user_id) === currentUser)) {
                        foundRoom = id;
                        socket.data.currentRoom = foundRoom;
                        socket.join(`room_${foundRoom}`);
                        await syncRoom(foundRoom);
                        break;
                    }
                }

                if (!foundRoom) {
                    socket.join('lobby');
                }

                const roomsList = [];
                for (const id of activeRooms) {
                    const room = await getRoom(id);
                    if(room) {
                        roomsList.push({
                            id: room.id, status: room.status, is_private: room.is_private, max_members: room.max_members,
                            creator_id: room.creator_id, member_count: room.members.length
                        });
                    }
                }

                socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom: socket.data.currentRoom });
            } catch (err) { 
                console.error('Auth Error', err); 
                socket.emit('auth_error', 'Database or Server configuration issue.');
            }
        });
        
        socket.on('request_initial_drawings', async () => {
            const currentRoom = socket.data.currentRoom;
            if (currentRoom) {
                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                socket.emit('sync_initial_drawings', drawings.map(d => ({ lines: d.lines, color: d.color })));
            }
        });

        socket.on('active_event', () => {
            socket.data.lastActiveEvent = Date.now();
            socket.data.idleWarned = false;
        });

        socket.on('claim_reward', async ({ type }) => {
            try {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;
                let success = false;
                let msg = '';
                let rewardAmount = 0;

                if (type === 'daily') {
                    const [res] = await db.query(`
                        UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                        WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
                    `, [currentUser]);
                    if (res.affectedRows > 0) { success = true; rewardAmount = 1; msg = 'Daily reward claimed! +1 Credit'; }
                    else { msg = 'Daily reward already claimed today.'; }
                } 
                else if (type === 'ad' || type === 'ad2') {
                    const prefix = type === 'ad' ? 'ad' : 'ad2';
                    const cooldown = prefix === 'ad' ? 60 : 45;
                    const maxClaims = prefix === 'ad' ? 3 : 5; 
                    
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
                            rewardAmount = 1;
                            await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, currentUser]);
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit`;
                        } else if (user.claims < maxClaims && (user.mins_passed === null || user.mins_passed >= cooldown)) {
                            const newClaimCount = user.claims + 1;
                            rewardAmount = 1;
                            if (prefix === 'ad' && newClaimCount === 3) rewardAmount = 2;
                            if (prefix === 'ad2' && (newClaimCount === 4 || newClaimCount === 5)) rewardAmount = 2;

                            await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = ?, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit${rewardAmount > 1 ? 's' : ''}`;
                        } else {
                            msg = `Ad reward not available yet. Max ${maxClaims} per day, ${cooldown} mins apart.`;
                        }
                    }
                }

                if (success) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    await redis.hset('user_credits', currentUser, currentCredits + rewardAmount);
                    
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
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;

                const activeRooms = await redis.smembers('active_rooms');
                if (activeRooms.length >= 1250) {
                    return socket.emit('create_error', 'Maximum room limit (1250) reached. Cannot create more rooms at this time.');
                }

                const limit = [2, 3, 4].includes(max_members) ? max_members : 4;
                let cost = 0; 
                let expDate = null;
                
                if (is_private) {
                    let hasRoom = false;
                    for(const id of activeRooms) {
                        const r = await getRoom(id);
                        if(r && r.creator_id === currentUser) { hasRoom = true; break; }
                    }

                    if (hasRoom) return socket.emit('create_error', 'You can only have 1 private room active at a time.');
                    if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be exactly 6 to 10 characters.');
                    
                    const limitCost = limit === 2 ? 1 : (limit === 3 ? 3 : 4);
                    const durationCost = expire_hours === 2 ? 1 : (expire_hours === 4 ? 2 : 1);
                    
                    cost += limitCost + durationCost; 
                    const hours = [2, 4].includes(expire_hours) ? expire_hours : 2;
                    expDate = new Date(Date.now() + hours * 3600000);
                }

                if (cost > 0) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < cost) return socket.emit('create_error', `Not enough credits. Costs ${cost} credits.`);
                    
                    await redis.hset('user_credits', currentUser, currentCredits - cost);
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                }

                const newRoomId = await redis.incr('next_room_id');
                await saveRoom({
                    id: newRoomId, status: 'WAITING', current_drawer_id: null, word_to_draw: null,
                    round_end_time: null, break_end_time: null, last_winner_id: null, end_reason: null, turn_index: 0,
                    modified_at: new Date(), is_private: is_private ? 1 : 0, password: is_private ? password : null,
                    max_members: limit, base_hints: '[]', creator_id: is_private ? currentUser : null, expire_at: expDate,
                    undo_steps: 0, redo_steps: 0,
                    members: []
                });

                if (auto_join) {
                    await performJoinRoom(currentUser, newRoomId, password, true);
                } else {
                    socket.emit('room_created', { room_id: newRoomId });
                }
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await broadcastRooms();
            } catch (err) { console.error('Create room error:', err); }
        });

        socket.on('search_room', async ({ room_id }) => {
            const room = await getRoom(Number(room_id));
            if (!room) return socket.emit('join_error', 'Room not found.');
            socket.emit('search_result', { id: room.id, is_private: room.is_private });
        });

        socket.on('join_room', async ({ room_id, password }) => {
            try {
                if (!socket.data.currentUser) return;
                await performJoinRoom(socket.data.currentUser, Number(room_id), password, false);
            } catch (err) {}
        });

        socket.on('leave_room', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            await terminateCallsForUser(currentUser); 
            const room = await getRoom(currentRoom);
            if (room) {
                if (room.current_drawer_id === currentUser && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                    room.status = 'BREAK';
                    room.end_reason = 'drawer_disconnected';
                    room.break_end_time = new Date(Date.now() + 5000); 
                    room.word_to_draw = null;
                    room.round_end_time = null;
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: 'Drawer left the game.', created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                }

                room.members = room.members.filter(m => m.user_id !== currentUser);
                await saveRoom(room);
                await checkRoomReset(currentRoom);
            }
            socket.leave(`room_${currentRoom}`);
            socket.join('lobby'); 
            await syncRoom(currentRoom);
            socket.data.currentRoom = null;
            await broadcastRooms();
        });

        socket.on('delete_room', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.creator_id !== currentUser) return;

            io.to(`room_${currentRoom}`).emit('room_expired'); 
            
            await deleteRoomData(currentRoom);
            
            const sockets = await io.in(`room_${currentRoom}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                s.join('lobby'); 
                s.data.currentRoom = null;
            });
            
            await broadcastRooms();
        });

        socket.on('extend_room', async ({ expire_hours }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                const hours = [2, 4].includes(expire_hours) ? expire_hours : 2;
                let cost = hours === 4 ? 2 : 1;
                
                const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                if (currentCredits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');
                
                const room = await getRoom(currentRoom);
                if (!room || !room.is_private || room.creator_id !== currentUser) return;

                await redis.hset('user_credits', currentUser, currentCredits - cost);
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                
                room.expire_at = new Date(room.expire_at.getTime() + hours * 3600000);
                await saveRoom(room);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await syncRoom(currentRoom);
            } catch(err) { console.error('Extend room error:', err); }
        });

        socket.on('change_password', async ({ password }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            if (!password || password.length < 6 || password.length > 10) return socket.emit('create_error', 'Password must be 6-10 characters.');
            
            const room = await getRoom(currentRoom);
            if (!room || !room.is_private || room.creator_id !== currentUser) return socket.emit('create_error', 'Unauthorized.');

            room.password = password;
            await saveRoom(room);
            socket.emit('reward_success', `Room password updated successfully! New password: ${password}`);
            await broadcastRooms();
            await syncRoom(currentRoom);
        });

        socket.on('kick_player', async ({ target_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || !room.is_private || room.creator_id !== currentUser) return;

            room.members = room.members.filter(m => m.user_id !== target_id);
            await saveRoom(room);
            
            io.to(`user_${target_id}`).emit('kicked_by_admin');
            const sockets = await io.in(`user_${target_id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                s.join('lobby'); 
                if (s.data.currentRoom === currentRoom) s.data.currentRoom = null;
            });

            await syncRoom(currentRoom);
            await broadcastRooms();
        });

        socket.on('chat', async ({ message }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !message.trim()) return;
            
            const cId = await redis.incr('global_chat_id');
            const newChat = { id: cId, room_id: currentRoom, user_id: currentUser, message, created_at: new Date() };
            
            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(newChat));
            await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);

            io.to(`room_${currentRoom}`).emit('new_chat', newChat);
        });

        socket.on('give_up', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || !['DRAWING', 'PRE_DRAW'].includes(room.status)) return;

            const isDrawer = room.current_drawer_id === currentUser;

            if (isDrawer) {
                if (room.status === 'PRE_DRAW') {
                    room.status = 'BREAK';
                    room.end_reason = 'drawer_skipped';
                } else {
                    room.status = 'REVEAL'; 
                    room.end_reason = 'drawer_gave_up';
                }
                room.break_end_time = new Date(Date.now() + 5000); 
                room.round_end_time = null;
                
                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: 'The drawer gave up their turn.', created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                await saveRoom(room);
            } else {
                if (room.status !== 'DRAWING') return; 
                const member = room.members.find(m => m.user_id === currentUser);
                if (member) member.has_given_up = 1;
                
                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} voted to give up.`, created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);

                const guessers = room.members.filter(m => m.user_id !== room.current_drawer_id);
                const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

                if (allGivenUp) {
                    room.status = 'REVEAL';
                    room.end_reason = 'all_gave_up';
                    room.break_end_time = new Date(Date.now() + 5000);
                    room.round_end_time = null;
                    room.last_winner_id = null;
                    
                    const cId2 = await redis.incr('global_chat_id');
                    const sysChat2 = { id: cId2, room_id: currentRoom, user_id: 'System', message: 'All guessers gave up.', created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat2));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                }
                await saveRoom(room);
            }
            await syncRoom(currentRoom);
        });

        socket.on('guess', async ({ guess }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return socket.emit('create_error', 'Not logged in or in room.');
                if (!guess || !guess.trim()) return;
                
                const room = await getRoom(currentRoom);
                if (!room) return;
                if (room.status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
                if (room.current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');
                
                const rawGuesses = await redis.lrange(`room:${currentRoom}:guesses`, 0, -1);
                const myGuessCount = rawGuesses.map(g => JSON.parse(g)).filter(g => g.user_id === currentUser).length;
                
                if (myGuessCount >= 6) {
                    return socket.emit('create_error', 'No more guesses allowed this round.');
                }

                if (myGuessCount === 4) {
                    const lockKey = `guess_payment_lock:${currentUser}`;
                    const locked = await redis.set(lockKey, "1", "EX", 10, "NX");
                    if (!locked) return; 

                    try {
                        const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                        if (currentCredits < 1) {
                            await redis.del(lockKey);
                            return socket.emit('create_error', 'Not enough credits to unlock extra guesses! (Cost: 1 Credit)');
                        }
                        
                        await redis.hset('user_credits', currentUser, currentCredits - 1);
                        await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                        
                        const userState = await getUserState(currentUser);
                        if (userState) socket.emit('user_update', userState);
                    } catch (e) {
                        await redis.del(lockKey);
                        return console.error('Guess Payment Error:', e);
                    }
                    await redis.del(lockKey);
                }

                const isCorrect = room.word_to_draw && room.word_to_draw.toLowerCase() === guess.trim().toLowerCase();
                const gId = await redis.incr('global_guess_id');
                const newGuess = { id: gId, room_id: currentRoom, user_id: currentUser, guess_text: guess.trim(), is_correct: isCorrect ? 1 : 0, created_at: new Date() };
                
                await redis.rpush(`room:${currentRoom}:guesses`, JSON.stringify(newGuess));
                io.to(`room_${currentRoom}`).emit('new_guess', newGuess);

                if (isCorrect) {
                    room.status = 'REVEAL';
                    room.end_reason = 'guessed';
                    room.break_end_time = new Date(Date.now() + 5000); 
                    room.round_end_time = null;
                    room.last_winner_id = currentUser;
                    await saveRoom(room);
                    await syncRoom(currentRoom); 
                }

            } catch (err) { console.error('Guess Error:', err); }
        });

        socket.on('buy_hint', async ({ index }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                const room = await getRoom(currentRoom);
                if (!room) return;
                const member = room.members.find(m => m.user_id === currentUser);
                if (!member) return;

                let purchased = JSON.parse(member.purchased_hints || '[]');
                if (purchased.length >= 1) return socket.emit('create_error', 'You can only buy 1 hint per round.');

                if (!purchased.includes(index)) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < 1) return socket.emit('create_error', 'Not enough credits to buy a hint.');

                    await redis.hset('user_credits', currentUser, currentCredits - 1);
                    await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                    
                    purchased.push(index);
                    member.purchased_hints = JSON.stringify(purchased);
                    await saveRoom(room);
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${toHex(currentUser)} used a hint for 1 Credit!`, created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                    
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                    
                    await syncRoom(currentRoom);
                }
            } catch (err) { console.error('Buy Hint Error:', err); }
        });

        socket.on('set_word', async ({ word }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
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
            room.end_reason = null; 
            room.round_end_time = null; 
            
            room.undo_steps = 0;
            room.redo_steps = 0;

            room.members.forEach(m => {
                m.purchased_hints = '[]';
                m.has_given_up = 0;
                m.ink_used = {}; 
                m.ink_extra = {}; 
            });
            
            await saveRoom(room);
            await releaseRoomMemory(currentRoom); 
            await redis.del(`room:${currentRoom}:redo`);
            io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []); 
            await syncRoom(currentRoom);
        });

        socket.on('set_ready', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room) return;
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                member.is_ready = 1;

                if (room.members.length >= 2 && room.members.every(m => m.is_ready)) {
                    const sortedMembers = [...room.members].sort((a, b) => a.joined_at - b.joined_at);

                    let idx = room.turn_index || 0;
                    if (idx >= sortedMembers.length) idx = 0;
                    const nextDrawer = sortedMembers[idx].user_id;

                    room.status = 'PRE_DRAW';
                    room.current_drawer_id = nextDrawer;
                    room.word_to_draw = null;
                    room.break_end_time = null;
                    room.end_reason = null; 
                    room.round_end_time = new Date(Date.now() + 30000); 
                    room.members.forEach(m => m.is_ready = 0);
                    room.turn_index = idx + 1; 

                    await releaseRoomMemory(currentRoom); 
                    await redis.del(`room:${currentRoom}:guesses`); 
                    io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []); 
                }

                await saveRoom(room);
                await syncRoom(currentRoom);
            }
        });

        socket.on('draw', async ({ lines }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.status !== 'DRAWING') return;

            const member = room.members.find(m => m.user_id === currentUser);
            const activeColor = 'black'; 
            
            let strokeLength = 0;
            if (lines && lines.length > 0) {
                for (let i = 0; i < lines.length; i += 4) {
                    const x0 = lines[i], y0 = lines[i+1], x1 = lines[i+2], y1 = lines[i+3];
                    strokeLength += Math.sqrt(Math.pow(x1 - x0, 2) + Math.pow(y1 - y0, 2));
                }
            }

            if (member) {
                if (!member.ink_used) member.ink_used = {};
                member.ink_used[activeColor] = (member.ink_used[activeColor] || 0) + strokeLength;
                room.undo_steps = Math.min((room.undo_steps || 0) + 1, 3);
                room.redo_steps = 0;
                await saveRoom(room);
            }

            await redis.del(`room:${currentRoom}:redo`); 
            
            const dId = await redis.incr('global_drawing_id');
            const drawing = { id: dId, lines, ink_cost: strokeLength, color: activeColor, user_id: currentUser };
            await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawing));
            
            socket.to(`room_${currentRoom}`).emit('live_draw', { lines, color: activeColor });
        });

        socket.on('buy_ink', async () => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                const room = await getRoom(currentRoom);
                if (!room || room.status !== 'DRAWING') return;
                
                const targetColor = 'black'; 
                const cost = INK_CONFIG[targetColor].cost;
                const extraInkAmount = INK_CONFIG[targetColor].extra; 

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    if (!member.ink_extra) member.ink_extra = {};
                    if (member.ink_extra[targetColor]) {
                        return socket.emit('create_error', 'You can only buy ink once per round.');
                    }

                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < cost) {
                        return socket.emit('create_error', `Not enough credits to buy ink.`);
                    }

                    await redis.hset('user_credits', currentUser, currentCredits - cost);
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);

                    member.ink_extra[targetColor] = extraInkAmount; 
                    await saveRoom(room);

                    socket.emit('reward_success', `+${extraInkAmount} Ink added!`);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                    
                    await syncRoom(currentRoom); 
                }
            } catch (err) { console.error('Buy Ink Error:', err); }
        });

        socket.on('undo', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || (room.undo_steps || 0) <= 0 || room.current_drawer_id !== currentUser) return;
            
            const lastRaw = await redis.rpop(`room:${currentRoom}:drawings`);
            if (lastRaw) {
                await redis.rpush(`room:${currentRoom}:redo`, lastRaw);
                const toRestore = JSON.parse(lastRaw);
                
                room.undo_steps = (room.undo_steps || 0) - 1;
                room.redo_steps = Math.min((room.redo_steps || 0) + 1, 3);

                const member = room.members.find(m => m.user_id === toRestore.user_id);
                if (member && toRestore.ink_cost) {
                    if (!member.ink_used) member.ink_used = {};
                    member.ink_used[toRestore.color] = Math.max(0, (member.ink_used[toRestore.color] || 0) - toRestore.ink_cost);
                }
                await saveRoom(room);
                
                const allRaw = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const allDrawings = allRaw.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', allDrawings.map(d => ({ lines: d.lines, color: d.color })));
                await syncRoom(currentRoom);
            }
        });

        socket.on('redo', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || (room.redo_steps || 0) <= 0 || room.current_drawer_id !== currentUser) return;

            const toRestoreRaw = await redis.rpop(`room:${currentRoom}:redo`);
            if (toRestoreRaw) {
                await redis.rpush(`room:${currentRoom}:drawings`, toRestoreRaw);
                const toRestore = JSON.parse(toRestoreRaw);
                
                room.redo_steps = (room.redo_steps || 0) - 1;
                room.undo_steps = Math.min((room.undo_steps || 0) + 1, 3);
                
                const member = room.members.find(m => m.user_id === toRestore.user_id);
                if (member && toRestore.ink_cost) {
                    if (!member.ink_used) member.ink_used = {};
                    member.ink_used[toRestore.color] = (member.ink_used[toRestore.color] || 0) + toRestore.ink_cost;
                }
                await saveRoom(room);
                
                const allRaw = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const allDrawings = allRaw.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', allDrawings.map(d => ({ lines: d.lines, color: d.color })));
                await syncRoom(currentRoom);
            }
        });

        socket.on('clear_all', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || room.status !== 'DRAWING' || room.current_drawer_id !== currentUser) return;

            await redis.del(`room:${currentRoom}:drawings`, `room:${currentRoom}:redo`);
            room.undo_steps = 0;
            room.redo_steps = 0;
            
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                if (member.ink_used) member.ink_used['black'] = 0;
            }
            await saveRoom(room);
            
            io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []);
            await syncRoom(currentRoom);
        });

        socket.on('initiate_call', async ({ receiver_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            
            const allCalls = await redis.hgetall('active_calls');
            const isInCall = Object.values(allCalls).some(str => {
                const c = JSON.parse(str);
                return c.caller === currentUser || c.receiver === currentUser ||
                       c.caller === receiver_id || c.receiver === receiver_id;
            });
            
            if (isInCall) return socket.emit('create_error', 'Cannot initiate call: User is already busy.');

            const callId = `call_${Date.now()}_${Math.random()}`;
            const callObj = { id: callId, caller: currentUser, receiver: String(receiver_id), status: 'RINGING', room_id: currentRoom };
            
            await redis.hset('active_calls', callId, JSON.stringify(callObj));
            io.to(`room_${currentRoom}`).emit('call_update', callObj);
            await syncRoom(currentRoom);
        });

        socket.on('accept_call', async ({ call_id }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                const callStr = await redis.hget('active_calls', call_id);
                if (callStr) {
                    const call = JSON.parse(callStr);
                    if (String(call.receiver) === currentUser) {
                        const currentCredits = parseFloat(await redis.hget('user_credits', call.caller)) || 0;
                        if (currentCredits < 1) {
                            await redis.hdel('active_calls', call_id);
                            io.to(`room_${call.room_id}`).emit('call_ended', call_id);
                            await syncRoom(call.room_id);
                            return;
                        }

                        await redis.hset('user_credits', call.caller, currentCredits - 1);
                        await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [call.caller]);

                        call.status = 'ACTIVE';
                        call.startTime = Date.now();
                        call.nextChargeTime = Date.now() + 180000; 
                        await redis.hset('active_calls', call_id, JSON.stringify(call));
                        
                        io.to(`room_${call.room_id}`).emit('call_update', call);
                        
                        const uState1 = await getUserState(call.caller);
                        if(uState1) io.to(`user_${call.caller}`).emit('user_update', uState1);

                        await syncRoom(currentRoom);
                    }
                }
            } catch (err) { console.error('Accept call error:', err); }
        });

        socket.on('end_call', async ({ call_id }) => {
            const currentRoom = socket.data.currentRoom;
            const callStr = await redis.hget('active_calls', call_id);
            if (callStr) {
                const call = JSON.parse(callStr);
                await redis.hdel('active_calls', call_id);
                io.to(`room_${currentRoom || call.room_id}`).emit('call_ended', call_id);
                await syncRoom(currentRoom || call.room_id);
            }
        });

        socket.on('webrtc_signal', ({ call_id, target_id, signal }) => {
            socket.to(`user_${String(target_id)}`).emit('webrtc_signal_receive', { 
                call_id, 
                sender_id: socket.data.currentUser, 
                target_id: String(target_id), 
                signal 
            });
        });

        socket.on('disconnect', async () => {
            const currentUser = socket.data.currentUser;
            if (currentUser) {
                await redis.hset('user_disconnects', currentUser, Date.now());
            }
        });
    });

    // ---------------------------------------------------------
    // GAME ENGINE LOOP (Runs inside each worker, syncs via Redis lock)
    // ---------------------------------------------------------
    let isGameLoopRunning = false;
    setInterval(async () => {
        const lock = await redis.set('game_loop_lock', '1', 'EX', 9, 'NX');
        if (!lock) return; 

        if (isGameLoopRunning) return;
        isGameLoopRunning = true;

        try {
            const now = Date.now();

            const disconnects = await redis.hgetall('user_disconnects');
            for (const [userId, disconnectTimeStr] of Object.entries(disconnects)) {
                if (now - parseInt(disconnectTimeStr) >= 30000) {
                    await terminateCallsForUser(userId);
                    
                    const activeRooms = await redis.smembers('active_rooms');
                    for (const roomId of activeRooms) {
                        const room = await getRoom(roomId);
                        if (room && room.members.some(m => String(m.user_id) === userId)) {
                            if (room.current_drawer_id === userId && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                                
                                const cId = await redis.incr('global_chat_id');
                                const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer disconnected.', created_at: new Date() };
                                await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                                await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                            }
                            room.members = room.members.filter(m => m.user_id !== userId);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            await syncRoom(roomId);
                        }
                    }
                    await redis.hdel('user_disconnects', userId);
                    await broadcastRooms();
                }
            }
            
            const allCalls = await redis.hgetall('active_calls');
            for (const [callId, callStr] of Object.entries(allCalls)) {
                const call = JSON.parse(callStr);
                if (call.status === 'ACTIVE' && now >= call.nextChargeTime) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', call.caller)) || 0;
                    if (currentCredits < 1) {
                        await redis.hdel('active_calls', callId);
                        io.to(`room_${call.room_id}`).emit('call_ended', callId);
                        await syncRoom(call.room_id);
                    } else {
                        await redis.hset('user_credits', call.caller, currentCredits - 1);
                        await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [call.caller]);
                        
                        call.nextChargeTime = now + 180000;
                        await redis.hset('active_calls', callId, JSON.stringify(call));

                        const uState = await getUserState(call.caller);
                        if (uState) io.to(`user_${call.caller}`).emit('user_update', uState);
                    }
                }
            }
            
            const activeRooms = await redis.smembers('active_rooms');
            let roomsChanged = false;

            for (const roomId of activeRooms) {
                const room = await getRoom(roomId);
                if (!room) continue;

                let needsSync = false;

                if (room.status === 'PRE_DRAW' && room.round_end_time && now >= room.round_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.end_reason = 'timeout_predraw';
                    room.break_end_time = new Date(now + 5000); 
                    room.word_to_draw = null;
                    room.round_end_time = null;
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer failed to choose a word in time. Turn skipped.', created_at: new Date() };
                    await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                    needsSync = true;
                }

                if (room.status === 'REVEAL' && room.break_end_time && now >= room.break_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.break_end_time = new Date(now + 10000); 
                    room.members.forEach(m => m.has_given_up = 0);
                    needsSync = true;
                }

                if (room.is_private && room.expire_at && now >= room.expire_at.getTime()) {
                    io.to(`room_${roomId}`).emit('room_expired');
                    await deleteRoomData(roomId);
                    
                    const roomSockets = await io.in(`room_${roomId}`).fetchSockets();
                    for (const s of roomSockets) {
                        s.leave(`room_${roomId}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    }
                    roomsChanged = true;
                    continue; 
                }

                if (needsSync) {
                    await saveRoom(room);
                    await syncRoom(roomId);
                }
            }

            if (roomsChanged) {
                await broadcastRooms();
            }
            
            const sockets = await io.fetchSockets();
            let idleChangedRooms = new Set();

            for (const s of sockets) {
                if (s.data.currentRoom) {
                    const idleTime = now - (s.data.lastActiveEvent || now);
                    if (idleTime > 60000) {
                        s.emit('kick_idle');
                        const roomId = s.data.currentRoom;
                        const room = await getRoom(roomId);

                        if (room) {
                            if (room.current_drawer_id === s.data.currentUser && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                            }

                            room.members = room.members.filter(m => m.user_id !== s.data.currentUser);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            idleChangedRooms.add(roomId);
                        }
                        s.leave(`room_${roomId}`);
                        s.join('lobby'); 
                        s.data.currentRoom = null;
                    } else if (idleTime > 50000 && !s.data.idleWarned) {
                        s.data.idleWarned = true;
                        s.emit('idle_warning');
                    } else if (idleTime <= 50000) {
                        s.data.idleWarned = false;
                    }
                }
            }

            for (const roomId of idleChangedRooms) {
                await syncRoom(roomId);
            }
            if (idleChangedRooms.size > 0) {
                await broadcastRooms();
            }

        } catch (e) { 
            console.error(`[Worker ${process.pid}] Game Loop Error:`, e); 
        } finally {
            isGameLoopRunning = false;
        }
    }, 10000); 

    server.listen(PORT, () => console.log(`[Worker ${process.pid}] Server running on port ${PORT}`));
}
