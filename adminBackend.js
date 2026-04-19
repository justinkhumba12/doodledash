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
    } catch (err) {
        console.error('[Admin DB Init Error]', err);
    }

    // Socket.io Interceptor for Maintenance Mode
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

    app.get('/api/public/dictionary', async (req, res) => {
        const dict = await redis.get('custom_dictionary');
        if (dict) return res.json(JSON.parse(dict));
        res.json(["apple", "banana", "car", "dog", "house", "sun", "moon", "tree"]);
    });

    const adminRouter = express.Router();

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
        const [rows] = await db.query(`
            SELECT r.*, u.status, u.ban_until, u.mute_until, u.name, u.avatar_url, u.gender 
            FROM reports r 
            LEFT JOIN users u ON r.reported_id = u.tg_id 
            ORDER BY r.created_at DESC LIMIT 100
        `);
        for (let r of rows) {
            r.username = await redis.hget('user_usernames', r.reported_id) || 'unset';
            r.status = r.status || 'active'; // fallback for filter logic
        }
        res.json(rows);
    });

    adminRouter.post('/reports/delete', async (req, res) => {
        const { id } = req.body;
        await db.query('DELETE FROM reports WHERE id = ?', [id]);
        res.json({ success: true });
    });

    adminRouter.post('/users/search', async (req, res) => {
        const { query } = req.body;
        const search = `%${query}%`;
        const [rows] = await db.query('SELECT tg_id, name, credits, gems, status, ban_until, mute_until, avatar_url, gender, ban_count FROM users WHERE tg_id = ? OR name LIKE ? LIMIT 20', [query, search]);
        
        for (let r of rows) {
            r.username = await redis.hget('user_usernames', r.tg_id) || 'unset';
            r.status = r.status || 'active';
        }
        res.json(rows);
    });

    adminRouter.post('/users/action', async (req, res) => {
        const { tgId, action, days, message, reporterId, reportId } = req.body;
        try {
            let untilDate = null;
            if (days && days !== 'perm') {
                const d = new Date();
                d.setDate(d.getDate() + parseInt(days));
                untilDate = d.toISOString().split('T')[0];
            }

            if (action === 'ban') {
                await db.query(`UPDATE users SET status = 'ban', ban_until = ?, ban_count = ban_count + 1 WHERE tg_id = ?`, [untilDate || '2099-12-31', tgId]);
                io.to(`user_${tgId}`).emit('create_error', 'Your account has been banned by an administrator.');
                if (message) {
                    const formattedMsg = `🛑 *ADMIN ACTION:* ${message}\n\n_If you think this action was made by mistake, please contact an admin._`;
                    sendMsg(tgId, formattedMsg, null, { parse_mode: 'Markdown' });
                }
                
                if (reporterId) {
                    await db.query('UPDATE users SET credits = credits + 5 WHERE tg_id = ?', [reporterId]);
                    await redis.hincrbyfloat('user_credits', reporterId, 5);
                    sendMsg(reporterId, "Thank you for your report! The user has been banned and you've been rewarded 5 Credits.");
                }
            } else if (action === 'mute') {
                await db.query(`UPDATE users SET status = 'mute', mute_until = ? WHERE tg_id = ?`, [untilDate || '2099-12-31', tgId]);
                if (message) {
                    const formattedMsg = `🔇 *ADMIN ACTION:* ${message}\n\n_If you think this action was made by mistake, please contact an admin._`;
                    sendMsg(tgId, formattedMsg, null, { parse_mode: 'Markdown' });
                }
                
                if (reporterId) {
                    await db.query('UPDATE users SET credits = credits + 3 WHERE tg_id = ?', [reporterId]);
                    await redis.hincrbyfloat('user_credits', reporterId, 3);
                    sendMsg(reporterId, "Thank you for your report! The user has been muted and you've been rewarded 3 Credits.");
                }
            } else if (action === 'unban' || action === 'unmute') {
                await db.query(`UPDATE users SET status = 'active', ban_until = NULL, mute_until = NULL WHERE tg_id = ?`, [tgId]);
                if (message) {
                    sendMsg(tgId, `✅ *ADMIN ACTION:* ${message}`, null, { parse_mode: 'Markdown' });
                }
            }
            
            // Delete report if action resolved it
            if (reportId) {
                await db.query('DELETE FROM reports WHERE id = ?', [reportId]);
            }
            
            await logAdminAction(req.adminId, `USER_${action.toUpperCase()}`, { tgId, days, untilDate });
            res.json({ success: true });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });

    // --- ECONOMY & CONFIG ---
    adminRouter.post('/economy/modify', async (req, res) => {
        const { tgId, credits, gems, message } = req.body;
        await db.query(`UPDATE users SET credits = credits + ?, gems = gems + ? WHERE tg_id = ?`, [credits || 0, gems || 0, tgId]);
        if (credits) await redis.hincrbyfloat('user_credits', tgId, credits);
        
        // If an HTML formatted message was provided, send it through the Telegram Bot
        if (message && message.trim() !== '') {
            sendMsg(tgId, message, null, { parse_mode: 'HTML' });
        }

        await logAdminAction(req.adminId, 'MODIFY_ECONOMY', { tgId, credits, gems, hasMessage: !!message });
        res.json({ success: true });
    });

    adminRouter.get('/config', async (req, res) => {
        const maintenance = await redis.get('maintenance_mode');
        const maintEndTime = await redis.get('maintenance_end_time');
        const dictionary = await redis.get('custom_dictionary');
        const maxRooms = await redis.get('config_max_rooms');
        
        const packagesRaw = await redis.get('config_gem_packages');
        const gemPackages = packagesRaw ? JSON.parse(packagesRaw) : [
            { id: 1, gems: 1, credits: 5 },
            { id: 2, gems: 3, credits: 15 },
            { id: 3, gems: 5, credits: 25 },
            { id: 4, gems: 10, credits: 50 }
        ];

        const starPackagesRaw = await redis.get('config_star_packages');
        const starPackages = starPackagesRaw ? JSON.parse(starPackagesRaw) : [
            { id: 1, stars: 20, gems: 20 },
            { id: 2, stars: 50, gems: 50 },
            { id: 3, stars: 100, gems: 100 },
            { id: 4, stars: 500, gems: 500 }
        ];

        const inkConfigRaw = await redis.get('config_ink');
        const inkConfig = inkConfigRaw ? JSON.parse(inkConfigRaw) : { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 };
        
        const unbanCost = await redis.get('config_unban_cost') || 50;
        const unmuteCost = await redis.get('config_unmute_cost') || 25;

        const roomLimitsRaw = await redis.get('config_room_limits');
        const roomLimits = roomLimitsRaw ? JSON.parse(roomLimitsRaw) : { publicMax: 8, privateMax: 10, privateFree: 4, privateExtraCost: 1 };

        res.json({
            maintenance: maintenance === '1',
            maintenanceEndTime: maintEndTime,
            gemPackages,
            starPackages,
            inkConfig,
            dictionary: dictionary ? JSON.parse(dictionary) : [],
            unbanCost: parseInt(unbanCost),
            unmuteCost: parseInt(unmuteCost),
            maxRooms: maxRooms ? parseInt(maxRooms) : 1250,
            roomLimits
        });
    });

    adminRouter.post('/config/economy', async (req, res) => {
        const { gemPackages, starPackages, inkConfig, unbanCost, unmuteCost } = req.body;
        if (gemPackages) await redis.set('config_gem_packages', JSON.stringify(gemPackages));
        if (starPackages) await redis.set('config_star_packages', JSON.stringify(starPackages));
        if (inkConfig) await redis.set('config_ink', JSON.stringify(inkConfig));
        if (unbanCost) await redis.set('config_unban_cost', unbanCost.toString());
        if (unmuteCost) await redis.set('config_unmute_cost', unmuteCost.toString());
        
        await logAdminAction(req.adminId, 'UPDATE_ECONOMY_CONFIG', { unbanCost, unmuteCost });
        res.json({ success: true });
    });

    // --- SERVER CONTROL & MAINTENANCE ---
    adminRouter.post('/config/maintenance', async (req, res) => {
        const { maintenance, duration_hours } = req.body;
        if (maintenance) {
            const duration = duration_hours ? parseFloat(duration_hours) : 1;
            const end_time = Date.now() + (duration * 3600000);
            await redis.set('maintenance_mode', '1');
            await redis.set('maintenance_end_time', end_time.toString());
            io.emit('maintenance_update', { active: true, end_time: end_time.toString() });
            io.emit('system_broadcast', { type: 'warning', message: `Server entering maintenance mode for ~${duration} hour(s). Lobbies frozen.` });
        } else {
            await redis.del('maintenance_mode');
            await redis.del('maintenance_end_time');
            io.emit('maintenance_update', { active: false });
        }
        await logAdminAction(req.adminId, 'TOGGLE_MAINTENANCE', { maintenance, duration_hours });
        res.json({ success: true });
    });

    adminRouter.post('/config/server_limits', async (req, res) => {
        const { maxRooms, roomLimits } = req.body;
        if (maxRooms) await redis.set('config_max_rooms', maxRooms.toString());
        if (roomLimits) await redis.set('config_room_limits', JSON.stringify(roomLimits));
        await logAdminAction(req.adminId, 'UPDATE_SERVER_LIMITS', { maxRooms, roomLimits });
        res.json({ success: true });
    });

    adminRouter.post('/broadcast', async (req, res) => {
        const { message } = req.body;
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
            return true; 
        }
    }
    return false;
}

module.exports = { setupAdminPanel, handleAdminWebhook };
