const express = require('express');
const { db, redis } = require('./database');
const { validateInitData, sendMsg } = require('./utils');
const config = require('./config');
const { getRoom, deleteRoomData, syncRoom, broadcastRooms } = require('./roomManager');

// Helper for securely logging all admin actions
const logAdminAction = async (adminId, action, details) => {
    try {
        await db.query(
            `INSERT INTO admin_audit_logs (admin_id, action, details) VALUES (?, ?, ?)`,
            [adminId, action, JSON.stringify(details)]
        );
    } catch (e) {
        console.error('[Admin Log Error]', e);
    }
};

async function setupAdminPanel(app, io) {
    // 1. Initialize Required Admin Tables
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                admin_id VARCHAR(50),
                action VARCHAR(100),
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS shop_items (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100),
                type VARCHAR(50),
                price_credits INT DEFAULT 0,
                price_gems INT DEFAULT 0,
                is_active BOOLEAN DEFAULT TRUE,
                data JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    } catch (err) {
        console.error('[Admin DB Init Error]', err);
    }

    // 2. Load dynamic config overrides from Redis
    const overrideRate = await redis.get('config_credits_per_star');
    if (overrideRate) config.CREDITS_PER_STAR = parseInt(overrideRate);

    // 3. Socket.io Interceptor for Maintenance Mode
    io.on('connection', (socket) => {
        socket.use(async ([event, ...args], next) => {
            if (event === 'create_room') {
                const maint = await redis.get('maintenance_mode');
                if (maint === '1') {
                    return socket.emit('create_error', 'Server is in Maintenance Mode. Room creation is temporarily disabled.');
                }
            }
            next();
        });
    });

    // 4. Public API for dynamic dictionary (Requested by frontend GameComponents.jsx)
    app.get('/api/public/dictionary', async (req, res) => {
        const dict = await redis.get('custom_dictionary');
        if (dict) return res.json(JSON.parse(dict));
        // Fallback default
        res.json(["apple", "banana", "car", "dog", "house", "sun", "moon", "tree"]);
    });

    // 5. Secure Admin REST Router
    const adminRouter = express.Router();

    // STRICT AUTHENTICATION MIDDLEWARE
    adminRouter.use(async (req, res, next) => {
        const initData = req.headers['x-init-data'];
        if (!initData) return res.status(401).json({ error: 'Missing initData' });

        const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
        
        if (!isMock && config.BOT_TOKEN && !validateInitData(initData, config.BOT_TOKEN)) {
            return res.status(403).json({ error: 'Invalid authentication signature.' });
        }

        try {
            const urlParams = new URLSearchParams(initData);
            const userObj = JSON.parse(urlParams.get('user'));
            const tgId = userObj.id.toString();
            
            const adminIds = (process.env.ADMIN_IDS || '').split(',');
            if (!isMock && !adminIds.includes(tgId)) {
                return res.status(403).json({ error: 'Unauthorized: You are not listed in ADMIN_IDS.' });
            }
            
            req.adminId = tgId;
            next();
        } catch (e) {
            return res.status(400).json({ error: 'Malformed initData payload.' });
        }
    });

    // --- DASHBOARD ANALYTICS ---
    adminRouter.get('/stats', async (req, res) => {
        try {
            const [[{ c: totalUsers }]] = await db.query('SELECT COUNT(*) as c FROM users');
            const [[{ c: dau }]] = await db.query(`SELECT COUNT(*) as c FROM users WHERE DATE(last_active) = UTC_DATE()`);
            const [[{ s: totalCredits }]] = await db.query('SELECT SUM(credits) as s FROM users');
            const [[{ s: totalDonated }]] = await db.query('SELECT SUM(total_donated) as s FROM donations');
            
            const activeRooms = await redis.smembers('active_rooms');
            const activeSockets = io.engine.clientsCount;
            
            res.json({ totalUsers, dau, totalCredits: totalCredits || 0, totalDonated: totalDonated || 0, activeRooms: activeRooms.length, activeSockets });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    adminRouter.get('/audit', async (req, res) => {
        const [rows] = await db.query('SELECT * FROM admin_audit_logs ORDER BY created_at DESC LIMIT 50');
        res.json(rows);
    });

    // --- MODERATION ---
    adminRouter.get('/reports', async (req, res) => {
        const [rows] = await db.query('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100');
        res.json(rows);
    });

    adminRouter.post('/users/search', async (req, res) => {
        const { query } = req.body;
        const search = `%${query}%`;
        const [rows] = await db.query('SELECT tg_id, name, credits, gems, status, ban_until, mute_until FROM users WHERE tg_id = ? OR name LIKE ? LIMIT 20', [query, search]);
        
        for (let r of rows) {
            r.username = await redis.hget('user_usernames', r.tg_id) || 'unset';
        }
        res.json(rows);
    });

    adminRouter.post('/users/action', async (req, res) => {
        const { tgId, action, days } = req.body;
        try {
            let untilDate = null;
            if (days && days !== 'perm') {
                const d = new Date();
                d.setDate(d.getDate() + parseInt(days));
                untilDate = d.toISOString().split('T')[0];
            }

            if (action === 'ban') {
                await db.query(`UPDATE users SET status = 'ban', ban_until = ? WHERE tg_id = ?`, [untilDate || '2099-12-31', tgId]);
                io.to(`user_${tgId}`).emit('create_error', 'Your account has been banned by an administrator.');
            } else if (action === 'unban' || action === 'unmute') {
                await db.query(`UPDATE users SET status = 'active', ban_until = NULL, mute_until = NULL WHERE tg_id = ?`, [tgId]);
            } else if (action === 'mute') {
                await db.query(`UPDATE users SET status = 'mute', mute_until = ? WHERE tg_id = ?`, [untilDate || '2099-12-31', tgId]);
            }
            
            await logAdminAction(req.adminId, `USER_${action.toUpperCase()}`, { tgId, days, untilDate });
            res.json({ success: true });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });

    // --- ECONOMY & CONFIG ---
    adminRouter.post('/economy/modify', async (req, res) => {
        const { tgId, credits, gems } = req.body;
        await db.query(`UPDATE users SET credits = credits + ?, gems = gems + ? WHERE tg_id = ?`, [credits || 0, gems || 0, tgId]);
        if (credits) await redis.hincrbyfloat('user_credits', tgId, credits);
        await logAdminAction(req.adminId, 'MODIFY_ECONOMY', { tgId, credits, gems });
        res.json({ success: true });
    });

    adminRouter.get('/config', async (req, res) => {
        const maintenance = await redis.get('maintenance_mode');
        const dictionary = await redis.get('custom_dictionary');
        res.json({
            maintenance: maintenance === '1',
            creditsPerStar: config.CREDITS_PER_STAR,
            dictionary: dictionary ? JSON.parse(dictionary) : []
        });
    });

    adminRouter.post('/config/economy', async (req, res) => {
        const { creditsPerStar } = req.body;
        await redis.set('config_credits_per_star', creditsPerStar);
        config.CREDITS_PER_STAR = parseInt(creditsPerStar); // Modify running process directly
        await logAdminAction(req.adminId, 'UPDATE_EXCHANGE_RATE', { creditsPerStar });
        res.json({ success: true });
    });

    // --- SHOP MANAGEMENT ---
    adminRouter.get('/shop', async (req, res) => {
        const [rows] = await db.query('SELECT * FROM shop_items ORDER BY created_at DESC');
        res.json(rows);
    });

    adminRouter.post('/shop', async (req, res) => {
        const { name, type, price_credits, price_gems } = req.body;
        await db.query(`INSERT INTO shop_items (name, type, price_credits, price_gems) VALUES (?, ?, ?, ?)`, 
            [name, type, price_credits, price_gems]);
        await logAdminAction(req.adminId, 'ADD_SHOP_ITEM', { name, type });
        res.json({ success: true });
    });

    adminRouter.post('/shop/toggle', async (req, res) => {
        const { id, is_active } = req.body;
        await db.query(`UPDATE shop_items SET is_active = ? WHERE id = ?`, [is_active, id]);
        await logAdminAction(req.adminId, 'TOGGLE_SHOP_ITEM', { id, is_active });
        res.json({ success: true });
    });

    // --- SERVER CONTROL & MAINTENANCE ---
    adminRouter.post('/config/maintenance', async (req, res) => {
        const { maintenance } = req.body;
        if (maintenance) {
            await redis.set('maintenance_mode', '1');
            io.emit('system_broadcast', { type: 'warning', message: 'Server entering maintenance mode. Lobbies frozen.' });
        } else {
            await redis.del('maintenance_mode');
        }
        await logAdminAction(req.adminId, 'TOGGLE_MAINTENANCE', { maintenance });
        res.json({ success: true });
    });

    adminRouter.post('/broadcast', async (req, res) => {
        const { message } = req.body;
        // Broadcast as a system chat message directly into all active rooms!
        const activeIds = await redis.smembers('active_rooms');
        const cId = await redis.incr('global_chat_id');
        const sysChat = { id: cId, room_id: 'global', user_id: 'System', message: `📢 [ADMIN]: ${message}`, created_at: new Date() };
        
        for (const id of activeIds) {
            await redis.rpush(`room:${id}:chats`, JSON.stringify(sysChat));
            await redis.ltrim(`room:${id}:chats`, -30, -1);
            io.to(`room_${id}`).emit('new_chat', sysChat);
        }
        
        await logAdminAction(req.adminId, 'GLOBAL_BROADCAST', { message });
        res.json({ success: true });
    });

    adminRouter.get('/rooms', async (req, res) => {
        const activeIds = await redis.smembers('active_rooms');
        const rooms = [];
        for (const id of activeIds) {
             const r = await getRoom(id);
             if (r) rooms.push({ id: r.id, status: r.status, is_private: r.is_private, members: r.members.length });
        }
        res.json(rooms);
    });

    adminRouter.post('/rooms/action', async (req, res) => {
        const { roomId, action } = req.body;
        if (action === 'close') {
            io.to(`room_${roomId}`).emit('room_expired');
            await deleteRoomData(roomId);
            const sockets = await io.in(`room_${roomId}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${roomId}`);
                s.join('lobby');
                s.data.currentRoom = null;
            });
            await broadcastRooms(io);
        } else if (action === 'wipe_chat') {
            await redis.del(`room:${roomId}:chats`);
            await syncRoom(roomId, io);
        }
        await logAdminAction(req.adminId, `ROOM_FORCE_${action.toUpperCase()}`, { roomId });
        res.json({ success: true });
    });

    // --- DICTIONARY ---
    adminRouter.post('/dictionary/update', async (req, res) => {
        const { words } = req.body; 
        await redis.set('custom_dictionary', JSON.stringify(words));
        await logAdminAction(req.adminId, 'UPDATE_DICTIONARY', { count: words.length });
        res.json({ success: true });
    });

    app.use('/api/admin', adminRouter);
    console.log('[Admin Panel] Secure routes and interceptors mounted.');
}

async function handleAdminWebhook(update) {
    if (update?.message?.text === '/adminpanel') {
        const tgId = update.message.from.id.toString();
        const adminIds = (process.env.ADMIN_IDS || '').split(',');
        
        if (adminIds.includes(tgId)) {
            const webAppUrl = process.env.ADMIN_WEBAPP_URL || `${process.env.WEBAPP_URL}/admin.html`;
            sendMsg(update.message.chat.id, "🔐 Secure Admin Login Link generated.", {
                inline_keyboard: [[{ text: '🛡️ Open Admin Panel', web_app: { url: webAppUrl } }]]
            });
            return true; // Command handled
        }
    }
    return false; // Let normal bot commands proceed
}

module.exports = { setupAdminPanel, handleAdminWebhook };
