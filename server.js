const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Native WebSocket Server (No Socket.io)
const wss = new WebSocketServer({ server });

// In-memory stores (Redis removed)
const memCalls = new Map();
const memRedo = new Map();

const getActiveCalls = async () => Object.fromEntries(memCalls);
const setCall = async (id, val) => memCalls.set(id, val);
const getCall = async (id) => memCalls.get(id);
const delCall = async (id) => memCalls.delete(id);
const clearRedo = async (roomId) => memRedo.delete(roomId);
const pushRedo = async (roomId, val) => {
    if(!memRedo.has(roomId)) memRedo.set(roomId, []);
    memRedo.get(roomId).push(val);
};
const popRedo = async (roomId) => {
    const arr = memRedo.get(roomId);
    if (arr && arr.length > 0) return arr.pop();
    return null;
};

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

// Database Connection Pooling
let pool;
async function initDB() {
    const dbUrl = process.env.MYSQL_URL || 'mysql://root:dKIKDNsnObjDvJlZawBHjzaEsoetaATX@mysql.railway.internal:3306/railway';
    try {
        pool = mysql.createPool({ 
            uri: dbUrl, 
            timezone: 'Z',
            connectionLimit: 100, 
            queueLimit: 0,
            waitForConnections: true
        });
        console.log('Connected to MySQL Database via Pool.');

        await pool.query(`
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

        await pool.query(`
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
                base_hints VARCHAR(255) DEFAULT '[]',
                creator_id VARCHAR(50),
                expire_at DATETIME
            )
        `);

        const migrations = [
            "ALTER TABLE rooms ADD COLUMN is_private BOOLEAN DEFAULT FALSE",
            "ALTER TABLE rooms ADD COLUMN password VARCHAR(255)",
            "ALTER TABLE rooms ADD COLUMN max_members INT DEFAULT 4",
            "ALTER TABLE rooms ADD COLUMN base_hints VARCHAR(255) DEFAULT '[]'",
            "ALTER TABLE rooms ADD COLUMN creator_id VARCHAR(50)",
            "ALTER TABLE rooms ADD COLUMN expire_at DATETIME",
            "ALTER TABLE guesses ADD COLUMN is_correct BOOLEAN DEFAULT FALSE",
            "ALTER TABLE room_members ADD COLUMN has_given_up BOOLEAN DEFAULT FALSE",
            "ALTER TABLE room_members ADD COLUMN purchased_hints VARCHAR(255) DEFAULT '[]'",
            "ALTER TABLE users ADD COLUMN tg_username VARCHAR(100)"
        ];
        
        for (let query of migrations) {
            try { await pool.query(query); } catch (e) {}
        }

        await pool.query(`
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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS drawings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                line_data LONGTEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS guesses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                room_id INT,
                user_id VARCHAR(50),
                guess_text VARCHAR(50),
                is_correct BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const [rooms] = await pool.query('SELECT COUNT(*) as count FROM rooms');
        if (rooms[0].count === 0) {
            for (let i = 0; i < 5; i++) {
                await pool.query(`INSERT INTO rooms (status, modified_at, is_private, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, 4)`);
            }
        }
    } catch (err) {
        console.error('MySQL Init Error:', err);
    }
}
initDB();

// Native WS Emission Helpers
const emitToRoom = (roomId, event, data) => {
    wss.clients.forEach(client => {
        if (client.currentRoom === roomId && client.readyState === WebSocket.OPEN) {
            client.sendEvent(event, data);
        }
    });
};

const emitToUser = (tgId, event, data) => {
    wss.clients.forEach(client => {
        if (client.currentUser === tgId && client.readyState === WebSocket.OPEN) {
            client.sendEvent(event, data);
        }
    });
};

const emitToAll = (event, data) => {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.sendEvent(event, data);
        }
    });
};

app.post('/webhook', async (req, res) => {
    const update = req.body;
    res.sendStatus(200); 

    const token = process.env.BOT_TOKEN; 
    const webAppUrl = process.env.WEBAPP_URL; 
    if (!token || !webAppUrl) return;

    const sendMsg = (chatId, text, replyMarkup) => {
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
        }).catch(console.error);
    };

    if (update?.pre_checkout_query) {
        fetch(`https://api.telegram.org/bot${token}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        });
        return;
    }

    if (update?.message?.successful_payment) {
        try {
            const payload = JSON.parse(update.message.successful_payment.invoice_payload);
            const addedCredits = payload.amount;
            const buyerId = payload.tgId;
            
            await pool.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [addedCredits, buyerId]);
            sendMsg(update.message.chat.id, `✅ Successfully purchased ${addedCredits} Credits! Your balance has been updated.`);
            
            const userState = await getUserState(buyerId);
            if (userState) emitToUser(buyerId.toString(), 'user_update', userState);
        } catch(e) { console.error('Payment processing error:', e); }
        return;
    }

    if (update?.message?.text && update.message.text.startsWith('/start')) {
        const chatId = update.message.chat.id;
        const tgId = update.message.from.id;
        const username = update.message.from.username;
        
        try {
            await pool.query('INSERT IGNORE INTO users (tg_id, credits, last_active, tg_username) VALUES (?, 5, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE tg_username = ?', [tgId.toString(), username || null, username || null]);
        } catch (e) {
            console.error('Webhook DB Error:', e);
        }

        if (update.message.text === '/start load_balance') {
            sendMsg(chatId, "💎 Select a package to top up your credits:\n\n*Rate: 1000 Credits = 500 Telegram Stars*", {
                inline_keyboard: [
                    [{ text: '50 Credits (25 ⭐️)', callback_data: 'buy_50' }],
                    [{ text: '100 Credits (50 ⭐️)', callback_data: 'buy_100' }],
                    [{ text: '200 Credits (100 ⭐️)', callback_data: 'buy_200' }],
                    [{ text: '500 Credits (250 ⭐️)', callback_data: 'buy_500' }],
                    [{ text: '1000 Credits (500 ⭐️)', callback_data: 'buy_1000' }]
                ]
            });
            return;
        }

        if (!username) {
            sendMsg(chatId, "⚠️ You need a Telegram username to play and receive credits!\n\nPlease set a username in your Telegram profile Settings, then click 'Check' below.", {
                inline_keyboard: [[{ text: '🔄 Check', callback_data: 'check_username' }]]
            });
        } else {
            const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
            sendMsg(chatId, 'Welcome to DoodleDash! Click below to play.', {
                inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
            });
        }
    } else if (update?.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const tgId = query.from.id;
        const username = query.from.username;
        const messageId = query.message.message_id;

        if (query.data.startsWith('buy_')) {
            const amount = parseInt(query.data.split('_')[1]);
            const stars = amount / 2; 
            
            const payload = JSON.stringify({ tgId: tgId.toString(), amount: amount });
            const invoice = {
                chat_id: chatId,
                title: `${amount} DoodleDash Credits`,
                description: `Top up your account with ${amount} credits.`,
                payload: payload,
                provider_token: "", 
                currency: "XTR",
                prices: [{ label: `${amount} Credits`, amount: stars }]
            };
            
            fetch(`https://api.telegram.org/bot${token}/sendInvoice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invoice)
            }).catch(console.error);
            
            fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: query.id })
            });
        } else if (query.data === 'check_username') {
            if (!username) {
                fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: query.id, text: "Username not set yet! Please set it in Settings.", show_alert: true })
                });
            } else {
                try {
                    await pool.query('UPDATE users SET tg_username = ? WHERE tg_id = ?', [username, tgId.toString()]);
                } catch(e) {}
                
                const urlWithParams = `${webAppUrl}?user_id=${tgId}`;
                fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: messageId,
                        text: "Awesome! Your username is verified.\n\nWelcome to DoodleDash! Click below to play.",
                        reply_markup: {
                            inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
                        }
                    })
                });
            }
        }
    }
});

async function getUserState(tg_id) {
    const [rows] = await pool.query(`
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

const broadcastRooms = async () => {
    const [rooms] = await pool.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            const userId = client.currentUser;
            const customizedRooms = rooms.map(r => {
                if (r.creator_id === userId) return r; 
                else { const { password, ...safeRoom } = r; return safeRoom; }
            });
            client.sendEvent('lobby_rooms_update', customizedRooms);
        }
    });
};

const deleteRoom = async (roomId) => {
    if (!roomId) return;
    try {
        await pool.query("DELETE FROM rooms WHERE id = ?", [roomId]);
        await pool.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
        await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
        await clearRedo(roomId);
    } catch (e) {
        console.error("Error completely deleting room:", roomId, e);
    }
};

const checkRoomReset = async (roomId) => {
    if (!roomId) return;
    try {
        const [members] = await pool.query('SELECT COUNT(*) as c FROM room_members WHERE room_id = ?', [roomId]);
        if (members[0].c === 0) {
            const [roomInfo] = await pool.query('SELECT is_private FROM rooms WHERE id = ?', [roomId]);
            const isPrivate = roomInfo.length > 0 && roomInfo[0].is_private;

            if (roomId !== 1 && roomId !== 2 && !isPrivate) {
                await deleteRoom(roomId);
            } else {
                await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
                await pool.query("DELETE FROM room_members WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM chats WHERE room_id = ?", [roomId]);
                await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
                await clearRedo(roomId);
            }
        } else if (members[0].c < 2) {
            await pool.query("UPDATE rooms SET status = 'WAITING', current_drawer_id = NULL, word_to_draw = NULL WHERE id = ?", [roomId]);
            await pool.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [roomId]);
        }
    } catch(err) {
        console.error("Auto delete room error:", err);
    }
};

const syncRoom = async (roomId) => {
    if (!roomId) return;
    try {
        const [roomData] = await pool.query('SELECT * FROM rooms WHERE id = ?', [roomId]);
        if (roomData.length === 0) return; 

        const [members] = await pool.query('SELECT * FROM room_members WHERE room_id = ?', [roomId]);
        const [chats] = await pool.query('SELECT * FROM chats WHERE room_id = ? ORDER BY id ASC', [roomId]); 
        const [guesses] = await pool.query('SELECT * FROM guesses WHERE room_id = ? ORDER BY id ASC', [roomId]);
        const [drawings] = await pool.query('SELECT line_data FROM drawings WHERE room_id = ? ORDER BY id ASC', [roomId]);
        
        const userIds = [...new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)])];
        let profiles = {};
        if (userIds.length > 0) {
            const [users] = await pool.query(`SELECT tg_id, profile_pic FROM users WHERE tg_id IN (?)`, [userIds]);
            users.forEach(u => profiles[u.tg_id] = u.profile_pic);
        }

        const allCallsMap = await getActiveCalls();
        const activeCallsList = Object.values(allCallsMap)
            .map(c => JSON.parse(c))
            .filter(c => c.room_id === roomId)
            .map(c => ({
                id: c.id, caller: c.caller, receiver: c.receiver, status: c.status, room_id: c.room_id
            }));

        wss.clients.forEach(s => {
            if (s.currentRoom === roomId && s.readyState === WebSocket.OPEN) {
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

                s.sendEvent('room_sync', {
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
        });
    } catch (error) {
        console.error("syncRoom error:", error);
    }
};

const terminateCallsForUser = async (userId) => {
    const allCallsMap = await getActiveCalls();
    for (const [callId, callStr] of Object.entries(allCallsMap)) {
        const call = JSON.parse(callStr);
        if (call.caller === userId || call.receiver === userId) {
            await delCall(callId);
            emitToRoom(call.room_id, 'call_ended', callId);
            syncRoom(call.room_id);
        }
    }
};

const checkRoomReadiness = async (roomId) => {
    try {
        const [room] = await pool.query("SELECT status FROM rooms WHERE id = ?", [roomId]);
        if (room.length === 0 || !['WAITING', 'BREAK'].includes(room[0].status)) return;

        const [members] = await pool.query("SELECT user_id, is_ready FROM room_members WHERE room_id = ?", [roomId]);
        if (members.length >= 2 && members.every(m => m.is_ready)) {
            const nextDrawer = members[Math.floor(Math.random() * members.length)].user_id;
            await pool.query("UPDATE rooms SET status = 'PRE_DRAW', current_drawer_id = ?, word_to_draw = NULL WHERE id = ?", [nextDrawer, roomId]);
            await pool.query("UPDATE room_members SET is_ready = 0 WHERE room_id = ?", [roomId]);
            
            await pool.query("DELETE FROM guesses WHERE room_id = ?", [roomId]);
            await pool.query("DELETE FROM drawings WHERE room_id = ?", [roomId]);
            await clearRedo(roomId);
            syncRoom(roomId);
        }
    } catch(e) { console.error('Room Readiness Error:', e); }
};

const scheduleBreakTransition = (roomId) => {
    setTimeout(async () => {
        const [room] = await pool.query("SELECT status, break_end_time FROM rooms WHERE id = ?", [roomId]);
        if (room.length > 0 && room[0].status === 'REVEAL' && new Date(room[0].break_end_time) <= new Date()) {
            await pool.query("UPDATE rooms SET status = 'BREAK', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 600 SECOND) WHERE id = ?", [roomId]);
            await pool.query("UPDATE room_members SET has_given_up = 0 WHERE room_id = ?", [roomId]);
            syncRoom(roomId);
            checkRoomReadiness(roomId); 
        }
    }, 5500); 
};

const scheduleRoomExpiration = (roomId, expireMs) => {
    setTimeout(async () => {
        const [r] = await pool.query("SELECT is_private, expire_at FROM rooms WHERE id = ?", [roomId]);
        if (r.length > 0 && r[0].is_private) {
            if (new Date(r[0].expire_at) <= new Date()) {
                emitToRoom(roomId, 'room_expired');
                await deleteRoom(roomId); 
                wss.clients.forEach(s => {
                    if (s.currentRoom === roomId) s.currentRoom = null;
                });
                broadcastRooms();
            }
        }
    }, expireMs);
};

wss.on('connection', (ws) => {
    ws.currentUser = null;
    ws.currentRoom = null;
    ws.activeBillingIntervals = {};

    ws.sendEvent = (event, data) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event, data }));
        }
    };

    const startIdleTimer = () => {
        if (ws.idleTimeout) clearTimeout(ws.idleTimeout);
        if (ws.warnTimeout) clearTimeout(ws.warnTimeout);
        ws.idleWarned = false;

        ws.warnTimeout = setTimeout(() => {
            if (ws.currentRoom) {
                ws.idleWarned = true;
                ws.sendEvent('idle_warning');
            }
        }, 50000); 

        ws.idleTimeout = setTimeout(async () => {
            if (ws.currentRoom) {
                ws.sendEvent('kick_idle');
                await pool.query('DELETE FROM room_members WHERE user_id = ?', [ws.currentUser]);
                const oldRoom = ws.currentRoom;
                ws.currentRoom = null;
                await checkRoomReset(oldRoom);
                syncRoom(oldRoom);
                broadcastRooms();
            }
        }, 60000); 
    };

    const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
        const [roomData] = await pool.query('SELECT * FROM rooms WHERE id = ?', [roomIdNum]);
        if (roomData.length === 0) return ws.sendEvent('join_error', 'Room not found.');
        const room = roomData[0];

        const [members] = await pool.query('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?', [roomIdNum]);
        if (members[0].count >= room.max_members) return ws.sendEvent('join_error', 'Room is full.');

        const [existing] = await pool.query('SELECT room_id FROM room_members WHERE user_id = ?', [userId]);
        if (existing.length > 0 && existing[0].room_id === roomIdNum) {
            ws.currentRoom = roomIdNum;
            ws.sendEvent('join_success', roomIdNum);
            return syncRoom(roomIdNum);
        }

        if (!bypassCost) {
            if (room.is_private) {
                if (room.password !== password) return ws.sendEvent('join_error', 'Incorrect password.');
            } else if (roomIdNum !== 1 && roomIdNum !== 2) {
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [userId]);
                if (u[0].credits < 1) return ws.sendEvent('join_error', 'Not enough credits. Public rooms cost 1 credit.');
                await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [userId]);
            }
        }

        const oldRoom = ws.currentRoom;
        if (oldRoom) {
            await terminateCallsForUser(userId); 
            await pool.query('DELETE FROM room_members WHERE user_id = ?', [oldRoom]); 
            ws.currentRoom = null;
            await checkRoomReset(oldRoom);
        }

        await pool.query('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)', [roomIdNum, userId]);
        ws.currentRoom = roomIdNum;
        
        ws.sendEvent('join_success', roomIdNum);
        
        if (oldRoom) {
            syncRoom(oldRoom);
            checkRoomReadiness(oldRoom);
        }
        syncRoom(roomIdNum);
        checkRoomReadiness(roomIdNum);
        broadcastRooms();

        const userState = await getUserState(userId);
        if (userState) ws.sendEvent('user_update', userState);
    };

    ws.on('message', async (raw) => {
        try {
            const parsed = JSON.parse(raw);
            const event = parsed.event;
            const data = parsed.data || {};

            if (event === 'auth') {
                const { tg_id, profile_pic } = data;
                if (!tg_id) return;
                ws.currentUser = tg_id;
                startIdleTimer();
                
                await pool.query(`INSERT IGNORE INTO users (tg_id, credits, last_active) VALUES (?, 5, UTC_TIMESTAMP())`, [tg_id]);
                if (profile_pic) {
                    await pool.query(`UPDATE users SET profile_pic = ?, last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [profile_pic, tg_id]);
                } else {
                    await pool.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tg_id]);
                }

                const userState = await getUserState(tg_id);
                const [rooms] = await pool.query('SELECT r.id, r.status, r.is_private, r.max_members, r.creator_id, r.password, COUNT(rm.user_id) as member_count FROM rooms r LEFT JOIN room_members rm ON r.id = rm.room_id GROUP BY r.id');
                const customizedRooms = rooms.map(r => r.creator_id === tg_id ? r : { ...r, password: null });
                
                const [existing] = await pool.query('SELECT room_id FROM room_members WHERE user_id = ?', [tg_id]);
                if (existing.length > 0) {
                    ws.currentRoom = existing[0].room_id;
                    syncRoom(ws.currentRoom);
                }

                ws.sendEvent('lobby_data', { user: userState, rooms: customizedRooms, currentRoom: ws.currentRoom });
            } 
            else if (event === 'active_event') {
                startIdleTimer();
            }
            else if (event === 'claim_reward') {
                if (!ws.currentUser) return;
                startIdleTimer();
                let success = false;
                let msg = '';
                const { type } = data;

                if (type === 'daily') {
                    const [res] = await pool.query(`
                        UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                        WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
                    `, [ws.currentUser]);
                    if (res.affectedRows > 0) { success = true; msg = 'Daily reward claimed! +1 Credit'; }
                    else { msg = 'Daily reward already claimed today.'; }
                } 
                else if (type === 'ad' || type === 'ad2') {
                    const prefix = type === 'ad' ? 'ad' : 'ad2';
                    const [u] = await pool.query(`SELECT
                        ${prefix}_claims_today as claims,
                        DATE_FORMAT(last_${prefix}_claim_time, '%Y-%m-%d') as last_date,
                        DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                        TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                        FROM users WHERE tg_id = ?`, [ws.currentUser]);

                    if (u.length > 0) {
                        const user = u[0];
                        const isToday = user.last_date === user.today;

                        if (!user.last_date || !isToday) {
                            await pool.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [ws.currentUser]);
                            success = true; msg = 'Reward claimed! +2 Credits';
                        } else if (user.claims < 3 && (user.mins_passed === null || user.mins_passed >= 180)) {
                            await pool.query(`UPDATE users SET credits = credits + 2, ${prefix}_claims_today = ${prefix}_claims_today + 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [ws.currentUser]);
                            success = true; msg = 'Reward claimed! +2 Credits';
                        } else {
                            msg = 'Ad reward not available yet. Max 3 per day, 3 hours apart.';
                        }
                    }
                }

                if (success) {
                    ws.sendEvent('reward_success', msg);
                    const userState = await getUserState(ws.currentUser);
                    if (userState) ws.sendEvent('user_update', userState);
                } else {
                    ws.sendEvent('create_error', msg);
                }
            }
            else if (event === 'transfer_credits') {
                const { target_id, amount } = data;
                if (!ws.currentUser || ws.currentUser === target_id) return;
                startIdleTimer();
                const amt = Number(amount);
                if (![50, 100, 200, 500, 1000].includes(amt)) return ws.sendEvent('create_error', 'Invalid transfer amount.');

                const totalCost = amt + 2; 
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [ws.currentUser]);
                
                if (u[0].credits < totalCost) {
                    return ws.sendEvent('create_error', `Not enough credits! You need ${totalCost} credits (includes 2 credit fee).`);
                }

                await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [totalCost, ws.currentUser]);
                await pool.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [amt, target_id]);

                ws.sendEvent('reward_success', `Successfully sent ${amt} credits to ${toHex(target_id)}!`);
                
                const token = process.env.BOT_TOKEN;
                const sendMsg = (chatId, text, replyMarkup) => {
                    if (!token) return;
                    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
                    }).catch(console.error);
                };

                const [targetUser] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [target_id]);
                const [senderUser] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [ws.currentUser]);
                
                const targetUsername = targetUser.length > 0 ? targetUser[0].tg_username : null;
                const senderUsername = senderUser.length > 0 ? senderUser[0].tg_username : null;

                if (amt >= 200) {
                    let sMarkup = targetUsername ? { inline_keyboard: [[{ text: '💬 Start Chatting', url: `https://t.me/${targetUsername}` }]] } : {};
                    sendMsg(ws.currentUser, `You successfully sent ${amt} credits to ${targetUsername ? '@' + targetUsername : toHex(target_id)}.`, sMarkup);
                }

                if (targetUser.length > 0) {
                    let rMarkup = senderUsername ? { inline_keyboard: [[{ text: '💬 Start Chatting', url: `https://t.me/${senderUsername}` }]] } : {};
                    sendMsg(target_id, `🎁 You received a gift of ${amt} credits from ${senderUsername ? '@' + senderUsername : toHex(ws.currentUser)}!`, rMarkup);
                    
                    const targetState = await getUserState(target_id);
                    emitToUser(target_id, 'user_update', targetState);
                    emitToUser(target_id, 'reward_success', `🎁 You received a gift of ${amt} credits!`);
                }
                
                const myState = await getUserState(ws.currentUser);
                ws.sendEvent('user_update', myState);
            }
            else if (event === 'create_room') {
                const { is_private, password, max_members, expire_hours, auto_join } = data;
                if (!ws.currentUser) return;
                startIdleTimer();
                const limit = [2, 3, 4].includes(max_members) ? max_members : 4;
                let insertRes;
                
                let cost = (auto_join && !is_private) ? 1 : 0;
                const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
                
                if (is_private) {
                    if (!password || password.length < 6 || password.length > 10) {
                        return ws.sendEvent('create_error', 'Password must be exactly 6 to 10 characters.');
                    }
                    let timeCost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
                    cost += limit + timeCost;
                }

                if (cost > 0) {
                    const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [ws.currentUser]);
                    if (u[0].credits < cost) return ws.sendEvent('create_error', `Not enough credits. Costs ${cost} credits.`);
                    await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, ws.currentUser]);
                }

                if (is_private) {
                    [insertRes] = await pool.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members, creator_id, expire_at) VALUES ('WAITING', UTC_TIMESTAMP(), 1, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))`, [password, limit, ws.currentUser, hours]);
                } else {
                    [insertRes] = await pool.query(`INSERT INTO rooms (status, modified_at, is_private, password, max_members) VALUES ('WAITING', UTC_TIMESTAMP(), 0, NULL, ?)`, [limit]);
                }

                const newRoomId = insertRes.insertId;
                
                if (is_private) scheduleRoomExpiration(newRoomId, hours * 3600 * 1000);

                if (auto_join) {
                    await performJoinRoom(ws.currentUser, newRoomId, password, true);
                } else {
                    ws.sendEvent('room_created', { room_id: newRoomId });
                }
                
                const userState = await getUserState(ws.currentUser);
                if (userState) ws.sendEvent('user_update', userState);
                broadcastRooms();
            }
            else if (event === 'search_room') {
                const { room_id } = data;
                startIdleTimer();
                const [rows] = await pool.query('SELECT id, is_private FROM rooms WHERE id = ?', [Number(room_id)]);
                if (rows.length === 0) return ws.sendEvent('join_error', 'Room not found.');
                ws.sendEvent('search_result', rows[0]);
            }
            else if (event === 'join_room') {
                const { room_id, password } = data;
                if (!ws.currentUser) return;
                startIdleTimer();
                await performJoinRoom(ws.currentUser, Number(room_id), password, false);
            }
            else if (event === 'leave_room') {
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                await terminateCallsForUser(ws.currentUser); 
                await pool.query('DELETE FROM room_members WHERE user_id = ?', [ws.currentUser]);
                const leftRoom = ws.currentRoom;
                ws.currentRoom = null;
                await checkRoomReset(leftRoom);
                
                syncRoom(leftRoom);
                checkRoomReadiness(leftRoom);
                broadcastRooms();
            }
            else if (event === 'extend_room') {
                const { expire_hours } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                const hours = [2, 4, 12].includes(expire_hours) ? expire_hours : 2;
                let cost = hours === 12 ? 10 : (hours === 4 ? 4 : 2);
                
                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [ws.currentUser]);
                if (u[0].credits < cost) return ws.sendEvent('create_error', 'Not enough credits to extend room.');
                
                await pool.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, ws.currentUser]);
                await pool.query('UPDATE rooms SET expire_at = DATE_ADD(expire_at, INTERVAL ? HOUR) WHERE id = ?', [hours, ws.currentRoom]);
                
                scheduleRoomExpiration(ws.currentRoom, hours * 3600 * 1000); 
                
                const userState = await getUserState(ws.currentUser);
                if (userState) ws.sendEvent('user_update', userState);
                syncRoom(ws.currentRoom);
            }
            else if (event === 'change_password') {
                const { password } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                if (!password || password.length < 6 || password.length > 10) return ws.sendEvent('create_error', 'Password must be 6-10 characters.');
                
                const [room] = await pool.query('SELECT creator_id FROM rooms WHERE id = ? AND is_private = 1', [ws.currentRoom]);
                if (room.length === 0 || room[0].creator_id !== ws.currentUser) return ws.sendEvent('create_error', 'Unauthorized.');

                await pool.query('UPDATE rooms SET password = ? WHERE id = ?', [ws.currentRoom]);
                ws.sendEvent('reward_success', 'Room password updated successfully!');
                broadcastRooms();
                syncRoom(ws.currentRoom);
            }
            else if (event === 'kick_player') {
                const { target_id } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                const [roomRows] = await pool.query('SELECT is_private, creator_id FROM rooms WHERE id = ?', [ws.currentRoom]);
                if (roomRows.length === 0 || !roomRows[0].is_private || roomRows[0].creator_id !== ws.currentUser) return;

                await pool.query('DELETE FROM room_members WHERE user_id = ? AND room_id = ?', [target_id, ws.currentRoom]);
                
                emitToUser(target_id, 'kicked_by_admin');
                
                wss.clients.forEach(s => {
                    if (s.currentUser === target_id && s.currentRoom === ws.currentRoom) {
                        s.currentRoom = null;
                    }
                });

                syncRoom(ws.currentRoom);
                checkRoomReadiness(ws.currentRoom);
                broadcastRooms();
            }
            else if (event === 'chat') {
                const { message } = data;
                if (!ws.currentUser || !ws.currentRoom || !message.trim()) return;
                startIdleTimer();
                await pool.query('INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)', [ws.currentRoom, ws.currentUser, message]);
                
                const [countRes] = await pool.query('SELECT COUNT(*) as c FROM chats WHERE room_id = ?', [ws.currentRoom]);
                if (countRes[0].c >= 40) {
                    await pool.query(`DELETE FROM chats WHERE room_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM chats WHERE room_id = ? ORDER BY id DESC LIMIT 20) t)`, [ws.currentRoom, ws.currentRoom]);
                }
                syncRoom(ws.currentRoom);
            }
            else if (event === 'give_up') {
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                const [room] = await pool.query('SELECT current_drawer_id, status FROM rooms WHERE id = ?', [ws.currentRoom]);
                if (room.length === 0 || room[0].status !== 'DRAWING') return;

                const isDrawer = room[0].current_drawer_id === ws.currentUser;

                if (isDrawer) {
                    await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [ws.currentRoom]);
                    await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [ws.currentRoom, 'System', 'The drawer gave up.']);
                    scheduleBreakTransition(ws.currentRoom);
                } else {
                    await pool.query('UPDATE room_members SET has_given_up = 1 WHERE room_id = ? AND user_id = ?', [ws.currentRoom, ws.currentUser]);
                    await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [ws.currentRoom, 'System', `${toHex(ws.currentUser)} voted to give up.`]);

                    const [members] = await pool.query('SELECT user_id, has_given_up FROM room_members WHERE room_id = ?', [ws.currentRoom]);
                    const guessers = members.filter(m => m.user_id !== room[0].current_drawer_id);
                    const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);

                    if (allGivenUp) {
                        await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [ws.currentRoom]);
                        await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [ws.currentRoom, 'System', 'All guessers gave up.']);
                        scheduleBreakTransition(ws.currentRoom);
                    }
                }
                syncRoom(ws.currentRoom);
            }
            else if (event === 'guess') {
                const { guess } = data;
                if (!ws.currentUser || !ws.currentRoom) return ws.sendEvent('create_error', 'Not logged in or in room.');
                if (!guess || !guess.trim()) return;
                startIdleTimer();
                
                const [room] = await pool.query('SELECT word_to_draw, current_drawer_id, status FROM rooms WHERE id = ?', [ws.currentRoom]);
                if (room.length === 0) return;
                if (room[0].status !== 'DRAWING') return ws.sendEvent('create_error', 'You can only guess during the drawing phase.');
                if (room[0].current_drawer_id === ws.currentUser) return ws.sendEvent('create_error', 'The drawer cannot guess.');
                
                const [guessCount] = await pool.query('SELECT COUNT(*) as count FROM guesses WHERE room_id = ? AND user_id = ?', [ws.currentRoom, ws.currentUser]);
                
                if (guessCount[0].count >= 5) {
                    const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [ws.currentUser]);
                    if (u[0].credits < 1) {
                        return ws.sendEvent('create_error', 'Not enough credits for extra guesses! (Cost: 1 Credit)');
                    }
                    await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [ws.currentUser]);
                }
                
                const isCorrect = room[0].word_to_draw && room[0].word_to_draw.toLowerCase() === guess.trim().toLowerCase();
                
                await pool.query('INSERT INTO guesses (room_id, user_id, guess_text, is_correct) VALUES (?, ?, ?, ?)', [ws.currentRoom, ws.currentUser, guess.trim(), isCorrect]);
                if (isCorrect) {
                    await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = ? WHERE id = ?", [ws.currentUser, ws.currentRoom]);
                    scheduleBreakTransition(ws.currentRoom);
                }
                
                const userState = await getUserState(ws.currentUser);
                if (userState) ws.sendEvent('user_update', userState);

                syncRoom(ws.currentRoom);
            }
            else if (event === 'buy_hint') {
                const { index } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();

                const [u] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [ws.currentUser]);
                if (u[0].credits < 2) return ws.sendEvent('create_error', 'Not enough credits to buy a hint.');

                const [member] = await pool.query('SELECT purchased_hints FROM room_members WHERE room_id = ? AND user_id = ?', [ws.currentRoom, ws.currentUser]);
                if(member.length === 0) return;

                let purchased = JSON.parse(member[0].purchased_hints || '[]');
                if (!purchased.includes(index)) {
                    purchased.push(index);
                    await pool.query('UPDATE users SET credits = credits - 2 WHERE tg_id = ?', [ws.currentUser]);
                    await pool.query('UPDATE room_members SET purchased_hints = ? WHERE room_id = ? AND user_id = ?', [JSON.stringify(purchased), ws.currentRoom, ws.currentUser]);
                    
                    await pool.query("INSERT INTO chats (room_id, user_id, message) VALUES (?, ?, ?)", [ws.currentRoom, 'System', `${toHex(ws.currentUser)} used a hint for 2 Credits!`]);
                    
                    const userState = await getUserState(ws.currentUser);
                    if (userState) ws.sendEvent('user_update', userState);
                    syncRoom(ws.currentRoom);
                }
            }
            else if (event === 'set_word') {
                const { word } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                const wordClean = word.trim().toUpperCase();
                if (wordClean.length < 3 || wordClean.length > 10) return ws.sendEvent('create_error', 'Word must be between 3 and 10 characters.');

                let hints = [], validIndices = [];
                for (let i = 0; i < wordClean.length; i++) if (wordClean[i] !== ' ') validIndices.push(i);
                
                const len = wordClean.length;
                if (len >= 3 && len <= 4) hints.push(Math.floor(len / 2));
                else {
                    let count = len === 10 ? 4 : (len >= 7 ? 3 : 2);
                    while (hints.length < count && validIndices.length > 0) {
                        let randIdx = Math.floor(Math.random() * validIndices.length);
                        hints.push(validIndices[randIdx]);
                        validIndices.splice(randIdx, 1); 
                    }
                }

                const activeRoomId = ws.currentRoom;
                await pool.query("UPDATE rooms SET word_to_draw = ?, base_hints = ?, status = 'DRAWING', round_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 120 SECOND) WHERE id = ? AND current_drawer_id = ?", [wordClean, JSON.stringify(hints), ws.currentRoom, ws.currentUser]);
                await pool.query("UPDATE room_members SET purchased_hints = '[]', has_given_up = 0 WHERE room_id = ?", [ws.currentRoom]);
                
                await pool.query("DELETE FROM drawings WHERE room_id = ?", [ws.currentRoom]);
                await pool.query("DELETE FROM guesses WHERE room_id = ?", [ws.currentRoom]);
                await clearRedo(ws.currentRoom);
                syncRoom(ws.currentRoom);

                setTimeout(async () => {
                    const [r] = await pool.query("SELECT status, round_end_time FROM rooms WHERE id = ?", [activeRoomId]);
                    if (r.length > 0 && r[0].status === 'DRAWING' && new Date(r[0].round_end_time) <= new Date()) {
                        await pool.query("UPDATE rooms SET status = 'REVEAL', break_end_time = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 SECOND), last_winner_id = NULL WHERE id = ?", [activeRoomId]);
                        syncRoom(activeRoomId);
                        scheduleBreakTransition(activeRoomId);
                    }
                }, 120000);
            }
            else if (event === 'set_ready') {
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                await pool.query('UPDATE room_members SET is_ready = 1 WHERE room_id = ? AND user_id = ?', [ws.currentRoom, ws.currentUser]);
                syncRoom(ws.currentRoom);
                checkRoomReadiness(ws.currentRoom);
            }
            else if (event === 'draw') {
                const { lines } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                await clearRedo(ws.currentRoom);
                await pool.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [ws.currentRoom, JSON.stringify(lines)]);
                
                wss.clients.forEach(c => {
                    if (c.currentRoom === ws.currentRoom && c !== ws && c.readyState === WebSocket.OPEN) {
                        c.sendEvent('live_draw', lines);
                    }
                });
            }
            else if (event === 'undo') {
                if (!ws.currentUser || !ws.currentRoom) return;
                const [last] = await pool.query('SELECT * FROM drawings WHERE room_id = ? ORDER BY id DESC LIMIT 1', [ws.currentRoom]);
                if (last.length > 0) {
                    await pushRedo(ws.currentRoom, JSON.stringify(last[0]));
                    await pool.query('DELETE FROM drawings WHERE id = ?', [last[0].id]);
                    syncRoom(ws.currentRoom);
                }
            }
            else if (event === 'redo') {
                if (!ws.currentUser || !ws.currentRoom) return;
                const toRestoreStr = await popRedo(ws.currentRoom);
                if (toRestoreStr) {
                    const toRestore = JSON.parse(toRestoreStr);
                    await pool.query('INSERT INTO drawings (room_id, line_data) VALUES (?, ?)', [ws.currentRoom, toRestore.line_data]);
                    syncRoom(ws.currentRoom);
                }
            }
            else if (event === 'initiate_call') {
                const { receiver_id } = data;
                if (!ws.currentUser || !ws.currentRoom) return;
                startIdleTimer();
                
                const allCallsMap = await getActiveCalls();
                const isInCall = Object.values(allCallsMap).map(c => JSON.parse(c)).some(
                    c => c.caller === ws.currentUser || c.receiver === ws.currentUser ||
                         c.caller === receiver_id || c.receiver === receiver_id
                );
                
                if (isInCall) return ws.sendEvent('create_error', 'Cannot initiate call: User is already busy.');

                const callId = `call_${Date.now()}_${Math.random()}`;
                const callObj = { id: callId, caller: ws.currentUser, receiver: receiver_id, status: 'RINGING', room_id: ws.currentRoom };
                
                await setCall(callId, JSON.stringify(callObj));
                emitToRoom(ws.currentRoom, 'call_update', callObj);
                syncRoom(ws.currentRoom);
            }
            else if (event === 'accept_call') {
                const { call_id } = data;
                const callData = await getCall(call_id);
                if(!callData) return;
                const call = JSON.parse(callData);

                if (call.receiver === ws.currentUser) {
                    call.status = 'ACTIVE';
                    call.startTime = Date.now();
                    await setCall(call_id, JSON.stringify(call));
                    emitToRoom(call.room_id, 'call_update', call);
                    
                    ws.activeBillingIntervals = ws.activeBillingIntervals || {};
                    ws.activeBillingIntervals[call_id] = setInterval(async () => {
                        const cData = await getCall(call_id);
                        if(!cData) return clearInterval(ws.activeBillingIntervals[call_id]);
                        const c = JSON.parse(cData);
                        
                        await pool.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ? AND credits > 0', [c.caller]);
                        const [u1] = await pool.query('SELECT credits FROM users WHERE tg_id = ?', [c.caller]);
                        
                        if (u1[0].credits <= 0) {
                            clearInterval(ws.activeBillingIntervals[call_id]);
                            await delCall(call_id);
                            emitToRoom(c.room_id, 'call_ended', call_id);
                            syncRoom(c.room_id);
                        } else {
                            const uState1 = await getUserState(c.caller);
                            if(uState1) emitToUser(c.caller, 'user_update', uState1);
                        }
                    }, 60000);

                    syncRoom(ws.currentRoom);
                }
            }
            else if (event === 'end_call') {
                const { call_id } = data;
                await delCall(call_id);
                if (ws.currentRoom) emitToRoom(ws.currentRoom, 'call_ended', call_id);
                else emitToAll('call_ended', call_id);
                
                syncRoom(ws.currentRoom);
                if (ws.activeBillingIntervals && ws.activeBillingIntervals[call_id]) {
                    clearInterval(ws.activeBillingIntervals[call_id]);
                    delete ws.activeBillingIntervals[call_id];
                }
            }
            else if (event === 'webrtc_signal') {
                const { call_id, target_id, signal } = data;
                emitToUser(target_id, 'webrtc_signal_receive', { call_id, sender_id: ws.currentUser, target_id, signal });
            }
        } catch (e) { console.error("WS Parsing/Handling Error:", e); }
    });

    ws.on('close', async () => {
        if (ws.idleTimeout) clearTimeout(ws.idleTimeout);
        if (ws.warnTimeout) clearTimeout(ws.warnTimeout);
        
        if (ws.activeBillingIntervals) {
            Object.values(ws.activeBillingIntervals).forEach(clearInterval);
        }

        if (ws.currentUser) {
            await terminateCallsForUser(ws.currentUser); 
            if (ws.currentRoom) {
                await pool.query('DELETE FROM room_members WHERE user_id = ?', [ws.currentUser]);
                await checkRoomReset(ws.currentRoom);
                syncRoom(ws.currentRoom);
                checkRoomReadiness(ws.currentRoom);
                broadcastRooms();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DoodleDash instance listening on port ${PORT}`));
