const { db, redis } = require('./database');
const { toHex, getWeekKey, validateInitData } = require('./utils');
const { getRoom, saveRoom, releaseRoomMemory, deleteRoomData, broadcastRooms, checkRoomReset, syncRoom } = require('./roomManager');
const { getUserState } = require('./userManager');
const config = require('./config');

module.exports = (io) => {
    io.on('connection', (socket) => {
        socket.data.lastActiveEvent = Date.now();
        socket.data.idleWarned = false;
        socket.data.currentUser = null;
        socket.data.currentRoom = null;
        socket.data.lastMessageTime = 0; 
        
        const checkRateLimit = () => {
            const now = Date.now();
            if (now - socket.data.lastMessageTime < 1000) return false;
            socket.data.lastMessageTime = now;
            return true;
        };

        socket.actionLock = Promise.resolve();
        const queuedAction = async (fn) => {
            const prev = socket.actionLock;
            let resolveLock;
            socket.actionLock = new Promise(r => resolveLock = r);
            await prev;
            try { await fn(); } catch(e){ console.error(e) } finally { resolveLock(); }
        };

        const performJoinRoom = async (userId, roomIdNum, password, bypassCost = false) => {
            const room = await getRoom(roomIdNum);
            if (!room) return socket.emit('join_error', 'Room not found.');
            
            if (room.banned_members && room.banned_members.includes(userId)) {
                return socket.emit('join_error', 'You were kicked from this private room by the creator and cannot rejoin.');
            }

            if (room.members.length >= room.max_members) return socket.emit('join_error', 'Room is full.');

            const existingMember = room.members.find(m => m.user_id === userId);
            if (existingMember) {
                socket.data.currentRoom = roomIdNum;
                socket.join(`room_${roomIdNum}`);
                socket.leave('lobby'); 
                socket.emit('join_success', roomIdNum);
                return await syncRoom(roomIdNum, io);
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
            
            if (oldRoom) await syncRoom(oldRoom, io);
            await syncRoom(roomIdNum, io);
            await broadcastRooms(io);

            const userState = await getUserState(userId);
            if (userState) socket.emit('user_update', userState);
        };

        socket.on('auth', async ({ initData, photoUrl }) => {
            try {
                let currentUser;
                
                if (initData) {
                    const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
                    if (!isMock && config.BOT_TOKEN && !validateInitData(initData, config.BOT_TOKEN)) {
                        return socket.emit('auth_error', 'Invalid Telegram authentication payload.');
                    }
                    const urlParams = new URLSearchParams(initData);
                    const userObjStr = urlParams.get('user');
                    if (!userObjStr) return socket.emit('auth_error', 'Invalid user payload.');
                    const userObj = JSON.parse(userObjStr);
                    currentUser = userObj.id.toString(); 
                    if (userObj.username) {
                        await redis.hset('user_usernames', currentUser, userObj.username);
                    }
                } else {
                    return socket.emit('auth_error', 'Access Denied: Please open via Telegram.');
                }
                
                socket.data.currentUser = currentUser;
                await redis.hdel('user_disconnects', currentUser);
                
                if (photoUrl) {
                    await redis.hset('user_photos', currentUser, photoUrl);
                }

                socket.join(`user_${currentUser}`);

                const userState = await getUserState(currentUser);
                
                const activeRooms = await redis.smembers('active_rooms');
                let foundRoom = null;
                for (const id of activeRooms) {
                    const room = await getRoom(id);
                    if (room && room.members.some(m => String(m.user_id) === currentUser)) {
                        foundRoom = id;
                        socket.data.currentRoom = foundRoom;
                        socket.join(`room_${foundRoom}`);
                        await syncRoom(foundRoom, io);
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

                const maint = await redis.get('maintenance_mode');
                const maintEndTime = await redis.get('maintenance_end_time');
                const packagesRaw = await redis.get('config_gem_packages');
                const starPackagesRaw = await redis.get('config_star_packages');
                const inkConfigRaw = await redis.get('config_ink');
                const maxRoomsRaw = await redis.get('config_max_rooms');
                
                const systemConfig = {
                    maintenance: { active: maint === '1', end_time: maintEndTime },
                    gemPackages: packagesRaw ? JSON.parse(packagesRaw) : [
                        { id: 1, gems: 1, credits: 5 },
                        { id: 2, gems: 3, credits: 15 },
                        { id: 3, gems: 5, credits: 25 },
                        { id: 4, gems: 10, credits: 50 }
                    ],
                    starPackages: starPackagesRaw ? JSON.parse(starPackagesRaw) : [
                        { id: 1, stars: 20, gems: 20 },
                        { id: 2, stars: 50, gems: 50 },
                        { id: 3, stars: 100, gems: 100 },
                        { id: 4, stars: 500, gems: 500 }
                    ],
                    inkConfig: inkConfigRaw ? JSON.parse(inkConfigRaw) : { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 },
                    maxRooms: maxRoomsRaw ? parseInt(maxRoomsRaw) : 1250
                };

                socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom: socket.data.currentRoom, systemConfig });
            } catch (err) { 
                console.error('Auth Error', err); 
                socket.emit('auth_error', 'Authentication processing failed.');
            }
        });

        socket.on('set_ready', async () => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (!room) return;

                const member = room.members.find(m => m.user_id === userId);
                if (member) {
                    member.is_ready = 1;
                    const readyCount = room.members.filter(m => m.is_ready).length;
                    const allReady = room.members.length >= 2 && readyCount === room.members.length;

                    if (allReady && (room.status === 'WAITING' || room.status === 'BREAK' || room.status === 'REVEAL')) {
                        room.status = 'PRE_DRAW';
                        room.round = (room.round || 0) + 1;
                        
                        // Pick next drawer by iterating
                        const currentIndex = room.members.findIndex(m => m.user_id === room.current_drawer_id);
                        const nextIndex = currentIndex >= 0 && currentIndex + 1 < room.members.length ? currentIndex + 1 : 0;
                        room.current_drawer_id = room.members[nextIndex].user_id;

                        room.round_end_time = new Date(Date.now() + 30000);
                        room.break_end_time = null;
                        room.word_to_draw = null;
                        room.end_reason = null;
                        room.last_winner_id = null;
                        room.members.forEach(m => { m.has_given_up = 0; });
                        await redis.del(`room:${roomId}:drawings`, `room:${roomId}:redo`, `room:${roomId}:guesses`);
                    }
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('report_user', async ({ reported_id, context, reason, snapshot_data }) => {
            const currentUser = socket.data.currentUser;
            if (!currentUser || !reported_id || !context) return;
            try {
                await db.query(
                    'INSERT INTO reports (reporter_id, reported_id, context, reason, snapshot_data) VALUES (?, ?, ?, ?, ?)',
                    [currentUser, reported_id, context, reason, snapshot_data || 'No snapshot']
                );
                socket.emit('reward_success', 'Report submitted successfully. Thank you for keeping our community safe.');
            } catch (e) {
                console.error('Report Error:', e);
                socket.emit('create_error', 'Failed to submit report. Try again later.');
            }
        });
        
        socket.on('exchange_gems', async ({ package_id }) => {
            const packagesRaw = await redis.get('config_gem_packages');
            const packages = packagesRaw ? JSON.parse(packagesRaw) : [
                { id: 1, gems: 1, credits: 5 }, { id: 2, gems: 3, credits: 15 },
                { id: 3, gems: 5, credits: 25 }, { id: 4, gems: 10, credits: 50 }
            ];
            const pkg = packages.find(p => p.id === package_id);
            if (!pkg) return socket.emit('create_error', 'Invalid package.');
            
            const currentUser = socket.data.currentUser;
            const [userRows] = await db.query('SELECT gems, credits FROM users WHERE tg_id = ?', [currentUser]);
            if (userRows.length === 0) return;
            if (userRows[0].gems < pkg.gems) return socket.emit('create_error', 'Not enough gems.');
            
            await db.query('UPDATE users SET gems = gems - ?, credits = credits + ? WHERE tg_id = ?', [pkg.gems, pkg.credits, currentUser]);
            await redis.hincrbyfloat('user_credits', currentUser, pkg.credits);
            
            socket.emit('reward_success', `Exchanged ${pkg.gems} Gems for ${pkg.credits} Credits!`);
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        });

        socket.on('get_leaderboard', async () => {
            try {
                const weekKey = getWeekKey();
                
                const [inviterRows] = await db.query(`
                    SELECT s.tg_id, s.invites
                    FROM user_weekly_stats s
                    WHERE s.week_key = ? AND s.invites > 0 
                    ORDER BY s.invites DESC, s.invites_updated_at ASC LIMIT 50
                `, [weekKey]);
                
                const [guesserRows] = await db.query(`
                    SELECT s.tg_id, s.guesses
                    FROM user_weekly_stats s
                    WHERE s.week_key = ? AND s.guesses > 0 
                    ORDER BY s.guesses DESC, s.guesses_updated_at ASC LIMIT 50
                `, [weekKey]);

                const populateProfiles = async (rows, scoreField) => {
                    if (rows.length === 0) return [];
                    const result = [];
                    const ids = rows.map(r => r.tg_id);
                    
                    const [userRows] = await db.query(`SELECT tg_id, avatar_url, gender, name FROM users WHERE tg_id IN (?)`, [ids]);
                    const avatarMap = {};
                    const genderMap = {};
                    const nameMap = {};
                    userRows.forEach(u => {
                        avatarMap[u.tg_id] = u.avatar_url;
                        genderMap[u.tg_id] = u.gender;
                        nameMap[u.tg_id] = u.name;
                    });

                    for (const row of rows) {
                        const id = row.tg_id;
                        const username = await redis.hget('user_usernames', id) || 'unset';
                        result.push({ tg_id: id, score: row[scoreField], username, avatar_url: avatarMap[id], gender: genderMap[id], name: nameMap[id] });
                    }
                    return result;
                };

                const inviters = await populateProfiles(inviterRows, 'invites');
                const guessers = await populateProfiles(guesserRows, 'guesses');
                
                const prevInvitersRaw = await redis.get('previous_week_top_inviters');
                const prevGuessersRaw = await redis.get('previous_week_top_guessers');
                const prevInvitersData = prevInvitersRaw ? JSON.parse(prevInvitersRaw) : [];
                const prevGuessersData = prevGuessersRaw ? JSON.parse(prevGuessersRaw) : [];

                const prevInviters = await populateProfiles(prevInvitersData, 'invites');
                const prevGuessers = await populateProfiles(prevGuessersData, 'guesses');

                socket.emit('leaderboard_data', { inviters, guessers, prevInviters, prevGuessers });
            } catch (err) {
                console.error('Leaderboard error:', err);
            }
        });

        socket.on('get_donators_leaderboard', async () => {
            try {
                const cached = await redis.get('donators_leaderboard');
                if (cached) {
                    return socket.emit('donators_leaderboard_data', JSON.parse(cached));
                }
                
                const [rows] = await db.query(`
                    SELECT d.tg_id, d.total_donated, u.avatar_url, u.gender, u.name
                    FROM donations d
                    LEFT JOIN users u ON d.tg_id = u.tg_id
                    ORDER BY d.total_donated DESC LIMIT 50
                `);
                
                const leaderboard = [];
                for (const row of rows) {
                    const username = await redis.hget('user_usernames', row.tg_id) || 'unset';
                    leaderboard.push({ tg_id: row.tg_id, total_donated: row.total_donated, username, avatar_url: row.avatar_url, gender: row.gender, name: row.name });
                }
                await redis.set('donators_leaderboard', JSON.stringify(leaderboard), 'EX', 86400); 
                socket.emit('donators_leaderboard_data', leaderboard);
            } catch (err) { console.error('Donators leaderboard error:', err); }
        });

        socket.on('set_gender', async ({ gender }) => {
            const currentUser = socket.data.currentUser;
            if (!currentUser || !['Male', 'Female', 'Other'].includes(gender)) return;
            try {
                const [rows] = await db.query('SELECT gender, credits FROM users WHERE tg_id = ?', [currentUser]);
                if (rows.length === 0) return;
                
                let cost = 0;
                if (rows[0].gender !== null) {
                    cost = 5;
                    if (rows[0].credits < 5) return socket.emit('create_error', 'Not enough credits to change gender.');
                }
                
                if (cost > 0) {
                    await db.query('UPDATE users SET credits = credits - ?, gender = ? WHERE tg_id = ?', [cost, gender, currentUser]);
                    await redis.hset('user_credits', currentUser, rows[0].credits - cost);
                } else {
                    await db.query('UPDATE users SET gender = ? WHERE tg_id = ?', [gender, currentUser]);
                }
                socket.emit('reward_success', `Gender updated to ${gender}.`);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            } catch (err) { console.error('Set Gender Error:', err); }
        });

        socket.on('set_name', async ({ name }) => {
            const currentUser = socket.data.currentUser;
            if (!currentUser || typeof name !== 'string' || name.trim().length < 2) return;
            try {
                const [rows] = await db.query('SELECT name, credits FROM users WHERE tg_id = ?', [currentUser]);
                if (rows.length === 0) return;
                
                let cost = 0;
                if (rows[0].name !== null) {
                    cost = 5;
                    if (rows[0].credits < 5) return socket.emit('create_error', 'Not enough credits to change name.');
                }
                
                const finalName = name.trim();
                
                if (cost > 0) {
                    await db.query('UPDATE users SET credits = credits - ?, name = ? WHERE tg_id = ?', [cost, finalName, currentUser]);
                    await redis.hset('user_credits', currentUser, rows[0].credits - cost);
                } else {
                    await db.query('UPDATE users SET name = ? WHERE tg_id = ?', [finalName, currentUser]);
                }
                socket.emit('reward_success', `Name updated to ${finalName}.`);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            } catch (err) { console.error('Set Name Error:', err); }
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

        socket.on('send_reaction', ({ emoji, action }) => {
            const currentRoom = socket.data.currentRoom;
            const currentUser = socket.data.currentUser;
            if (currentRoom && currentUser) {
                io.to(`room_${currentRoom}`).emit('new_reaction', { user_id: currentUser, emoji, action });
            }
        });

        socket.on('claim_reward', async ({ type }) => {
            try {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;
                let success = false;
                let msg = '';
                let rewardAmount = 0;

                if (type === 'daily') {
                    const [userRows] = await db.query(`
                        SELECT streak_count,
                        (last_streak_claim IS NOT NULL AND DATE_FORMAT(last_streak_claim, '%Y-%m-%d') = DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL 1 DAY), '%Y-%m-%d')) as streak_maintained,
                        (last_streak_claim IS NULL OR DATE_FORMAT(last_streak_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as can_claim
                        FROM users WHERE tg_id = ?
                    `, [currentUser]);
                    
                    if (userRows.length > 0) {
                        const u = userRows[0];
                        if (u.can_claim) {
                            let newStreak = u.streak_maintained ? (u.streak_count || 0) + 1 : 1;
                            rewardAmount = Math.min(newStreak, 7); 
                            await db.query(`
                                UPDATE users SET credits = credits + ?, streak_count = ?, last_streak_claim = UTC_DATE(), last_daily_claim = UTC_DATE()
                                WHERE tg_id = ?
                            `, [rewardAmount, newStreak, currentUser]);
                            success = true;
                            msg = `Daily streak Day ${newStreak} claimed! +${rewardAmount} Credit${rewardAmount > 1 ? 's' : ''}`;
                        } else {
                            msg = 'Daily reward already claimed today.';
                        }
                    }
                } 
                else if (type === 'ad' || type === 'ad2') {
                    const prefix = type === 'ad' ? 'ad' : 'ad2';
                    const cooldown = prefix === 'ad' ? 60 : 10;
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
                            if (prefix === 'ad') {
                                await db.query(`UPDATE users SET credits = credits + ?, ad_claims_today = ?, last_ad_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?
