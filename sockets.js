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
                                await db.query(`UPDATE users SET credits = credits + ?, ad_claims_today = ?, last_ad_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                            } else {
                                await db.query(`UPDATE users SET credits = credits + ?, ad2_claims_today = ?, last_ad2_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                            }
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit`;
                        } else {
                            msg = `Please wait before claiming again or you reached max claims.`;
                        }
                    }
                } else if (type === 'invite_3') {
                    const weekKey = getWeekKey();
                    const [stats] = await db.query(`SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?`, [currentUser, weekKey]);
                    const invites = stats.length > 0 ? stats[0].invites : 0;
                    const [u] = await db.query(`SELECT invite_claimed_this_week FROM users WHERE tg_id = ?`, [currentUser]);
                    
                    if (invites >= 3 && u.length > 0 && !u[0].invite_claimed_this_week) {
                        rewardAmount = 5;
                        await db.query(`UPDATE users SET credits = credits + ?, invite_claimed_this_week = TRUE WHERE tg_id = ?`, [rewardAmount, currentUser]);
                        success = true; msg = `Invite goal reached! +5 Credits`;
                    } else {
                        msg = `Goal not reached or already claimed.`;
                    }
                }
                
                if (success) {
                    await redis.hincrbyfloat('user_credits', currentUser, rewardAmount);
                    socket.emit('reward_success', msg);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    if(msg) socket.emit('create_error', msg);
                }
            } catch(e) { console.error('Claim Error', e); }
        });

        // --- Core Room Creation & Operations ---
        socket.on('create_room', async (data) => {
            queuedAction(async () => {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;
                
                if (!checkRateLimit()) return;

                const activeRoomsCount = await redis.scard('active_rooms');
                const maxRoomsStr = await redis.get('config_max_rooms');
                const maxRooms = maxRoomsStr ? parseInt(maxRoomsStr) : 1250;
                
                if (activeRoomsCount >= maxRooms) {
                    return socket.emit('room_limit_reached');
                }

                const maint = await redis.get('maintenance_mode');
                if (maint === '1') return socket.emit('create_error', 'Server is in Maintenance Mode. Room creation is disabled.');

                const isPriv = data.is_private || false;
                const pwd = data.password || '';
                const maxM = data.max_members || 6;
                const hours = data.expire_hours || 0.5;

                let cost = 0;
                if (isPriv) cost = maxM;

                if (cost > 0) {
                    const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                    if (u.length === 0 || u[0].credits < cost) return socket.emit('create_error', 'Not enough credits.');
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                    await redis.hincrbyfloat('user_credits', currentUser, -cost);
                }

                const roomIdNum = await redis.incr('global_room_id');
                const roomData = {
                    id: roomIdNum,
                    creator_id: currentUser,
                    is_private: isPriv ? 1 : 0,
                    password: pwd,
                    max_members: isPriv ? maxM : 6,
                    status: 'WAITING',
                    created_at: Date.now(),
                    expire_at: isPriv ? Date.now() + (hours * 3600000) : null,
                    has_been_extended: 0,
                    banned_members: [],
                    members: [],
                    round: 1,
                    current_drawer_id: null,
                    word_to_guess: null,
                    round_end_time: null,
                    phase_end_time: null
                };

                await saveRoom(roomData);
                await redis.sadd('active_rooms', roomIdNum.toString());

                // Auto-join the creator to the room they just made
                if (data.auto_join) {
                    await performJoinRoom(currentUser, roomIdNum, pwd, true);
                }
                
                socket.emit('room_created', { room_id: roomIdNum });
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                
                await broadcastRooms(io);
            });
        });

        socket.on('join_room', async (data) => {
            queuedAction(async () => {
                if (!socket.data.currentUser) return;
                if (!checkRateLimit()) return;
                await performJoinRoom(socket.data.currentUser, data.room_id, data.password, false);
            });
        });

        socket.on('search_room', async ({ room_id }) => {
            const room = await getRoom(room_id);
            if (room) {
                socket.emit('search_result', { id: room.id, is_private: room.is_private });
            } else {
                socket.emit('create_error', 'Room not found.');
            }
        });

        socket.on('leave_room', async () => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;

                socket.leave(`room_${roomId}`);
                socket.join('lobby');
                socket.data.currentRoom = null;

                const room = await getRoom(roomId);
                if (room) {
                    room.members = room.members.filter(m => m.user_id !== userId);
                    await saveRoom(room);
                    await checkRoomReset(roomId);
                    await syncRoom(roomId, io);
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('disconnect', async () => {
            const userId = socket.data.currentUser;
            const roomId = socket.data.currentRoom;
            
            if (userId) {
                await redis.hset('user_disconnects', userId, Date.now());
            }
            
            if (roomId && userId) {
                setTimeout(async () => {
                    const disconnectTime = await redis.hget('user_disconnects', userId);
                    if (disconnectTime) {
                        const room = await getRoom(roomId);
                        if (room) {
                            room.members = room.members.filter(m => m.user_id !== userId);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            await syncRoom(roomId, io);
                            await broadcastRooms(io);
                        }
                        await redis.hdel('user_disconnects', userId);
                    }
                }, 10000); 
            }
        });

        // --- Active Game Implementations ---
        socket.on('set_word', async ({ word }) => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (room && room.current_drawer_id === userId && room.status === 'PRE_DRAW') {
                    room.word_to_draw = word.toUpperCase();
                    room.status = 'DRAWING';
                    room.round_end_time = new Date(Date.now() + 90000); // 90 seconds to draw
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('chat', async ({ message }) => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const chatObj = {
                id: Date.now() + Math.random().toString(36).substr(2, 5),
                room_id: roomId,
                user_id: userId,
                message: message,
                created_at: new Date()
            };
            await redis.rpush(`room:${roomId}:chats`, JSON.stringify(chatObj));
            await redis.ltrim(`room:${roomId}:chats`, -50, -1);
            io.to(`room_${roomId}`).emit('new_chat', chatObj);
        });

        socket.on('guess', async ({ guess }) => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (!room || room.status !== 'DRAWING') return;

                if (room.current_drawer_id === userId) return;

                const isCorrect = guess.toUpperCase() === room.word_to_draw;

                const guessObj = {
                    id: Date.now() + Math.random().toString(36).substr(2, 5),
                    room_id: roomId,
                    user_id: userId,
                    guess_text: guess.toUpperCase(),
                    is_correct: isCorrect,
                    created_at: new Date()
                };

                await redis.rpush(`room:${roomId}:guesses`, JSON.stringify(guessObj));
                await redis.ltrim(`room:${roomId}:guesses`, -50, -1);
                
                io.to(`room_${roomId}`).emit('new_guess', guessObj);

                if (isCorrect) {
                    room.status = 'REVEAL';
                    room.last_winner_id = userId;
                    room.break_end_time = new Date(Date.now() + 5000);
                    room.members.forEach(m => { m.is_ready = 0; });
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                }
            });
        });

        socket.on('drawer_give_up', async () => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (room && room.current_drawer_id === userId && (room.status === 'DRAWING' || room.status === 'PRE_DRAW')) {
                    room.status = 'REVEAL';
                    room.end_reason = 'drawer_gave_up';
                    room.break_end_time = new Date(Date.now() + 5000);
                    room.members.forEach(m => { m.is_ready = 0; });
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                }
            });
        });

        socket.on('guesser_give_up', async () => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (!room || room.status !== 'DRAWING') return;

                const member = room.members.find(m => m.user_id === userId);
                if (member && !member.has_given_up) {
                    member.has_given_up = 1;
                    
                    const guessers = room.members.filter(m => m.user_id !== room.current_drawer_id);
                    const allGivenUp = guessers.length > 0 && guessers.every(m => m.has_given_up);
                    
                    if (allGivenUp) {
                        room.status = 'REVEAL';
                        room.end_reason = 'all_gave_up';
                        room.break_end_time = new Date(Date.now() + 5000);
                        room.members.forEach(m => { m.is_ready = 0; });
                    }
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                }
            });
        });

        socket.on('delete_chat_message', async ({ message_id }) => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;
                const room = await getRoom(roomId);
                if (room && room.is_private && room.creator_id === userId) {
                    const rawChats = await redis.lrange(`room:${roomId}:chats`, 0, -1);
                    const chats = rawChats.map(c => JSON.parse(c));
                    let modified = false;
                    const newChats = chats.map(c => {
                        if (c.id === message_id) {
                            modified = true;
                            return { ...c, message: '[Deleted by room creator]' };
                        }
                        return c;
                    });
                    if (modified) {
                        await redis.del(`room:${roomId}:chats`);
                        for (const c of newChats) {
                            await redis.rpush(`room:${roomId}:chats`, JSON.stringify(c));
                        }
                        await syncRoom(roomId, io);
                    }
                }
            });
        });

        socket.on('draw', async (data) => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const drawData = { lines: data.lines, color: data.color || 'black' };
            await redis.rpush(`room:${roomId}:drawings`, JSON.stringify(drawData));
            await redis.del(`room:${roomId}:redo`);
            
            const room = await getRoom(roomId);
            if (room) {
                room.undo_steps = (room.undo_steps || 0) + 1;
                room.redo_steps = 0;
                await saveRoom(room);
                io.to(`room_${roomId}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: 0 });
            }
            
            socket.to(`room_${roomId}`).emit('live_draw', drawData);
        });

        socket.on('clear_all', async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.current_drawer_id === userId) {
                await redis.del(`room:${roomId}:drawings`, `room:${roomId}:redo`);
                room.undo_steps = 0;
                room.redo_steps = 0;
                await saveRoom(room);
                io.to(`room_${roomId}`).emit('sync_initial_drawings', []);
                io.to(`room_${roomId}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            }
        });

        socket.on('undo', async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.current_drawer_id === userId) {
                const popped = await redis.rpop(`room:${roomId}:drawings`);
                if (popped) {
                    await redis.rpush(`room:${roomId}:redo`, popped);
                    room.undo_steps = Math.max(0, (room.undo_steps || 0) - 1);
                    room.redo_steps = (room.redo_steps || 0) + 1;
                    await saveRoom(room);
                    io.to(`room_${roomId}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                }
                const rawDrawings = await redis.lrange(`room:${roomId}:drawings`, 0, -1);
                io.to(`room_${roomId}`).emit('sync_initial_drawings', rawDrawings.map(d => JSON.parse(d)));
            }
        });

        socket.on('redo', async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.current_drawer_id === userId) {
                const popped = await redis.rpop(`room:${roomId}:redo`);
                if (popped) {
                    await redis.rpush(`room:${roomId}:drawings`, popped);
                    room.undo_steps = (room.undo_steps || 0) + 1;
                    room.redo_steps = Math.max(0, (room.redo_steps || 0) - 1);
                    await saveRoom(room);
                    io.to(`room_${roomId}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                }
                const rawDrawings = await redis.lrange(`room:${roomId}:drawings`, 0, -1);
                io.to(`room_${roomId}`).emit('sync_initial_drawings', rawDrawings.map(d => JSON.parse(d)));
            }
        });

        // --- Room Owner & Admin Controls ---
        socket.on('delete_room', async () => {
            queuedAction(async () => {
                const roomId = socket.data.currentRoom;
                const userId = socket.data.currentUser;
                if (!roomId || !userId) return;

                const room = await getRoom(roomId);
                if (room && room.creator_id === userId) {
                    io.to(`room_${roomId}`).emit('room_expired');
                    await deleteRoomData(roomId);
                    const sockets = await io.in(`room_${roomId}`).fetchSockets();
                    sockets.forEach(s => {
                        s.leave(`room_${roomId}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    });
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('change_password', async ({ password }) => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.creator_id === userId && password.length >= 6) {
                room.password = password;
                await saveRoom(room);
                socket.emit('reward_success', 'Password updated successfully.');
            }
        });

        socket.on('extend_room', async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.creator_id === userId && !room.has_been_extended) {
                const cost = 5;
                const [u] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [userId]);
                if (u.length > 0 && u[0].credits >= cost) {
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, userId]);
                    await redis.hincrbyfloat('user_credits', userId, -cost);
                    
                    room.expire_at = room.expire_at + (30 * 60000); // add 30 mins
                    room.has_been_extended = 1;
                    await saveRoom(room);
                    
                    socket.emit('reward_success', 'Room extended by 30 minutes.');
                    await syncRoom(roomId, io);
                    const userState = await getUserState(userId);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    socket.emit('create_error', 'Not enough credits.');
                }
            }
        });

        socket.on('kick_player', async ({ target_id }) => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId || !target_id) return;
            const room = await getRoom(roomId);
            if (room && room.creator_id === userId && room.is_private) {
                room.members = room.members.filter(m => m.user_id !== target_id);
                if (!room.banned_members) room.banned_members = [];
                room.banned_members.push(target_id);
                await saveRoom(room);
                
                io.to(`user_${target_id}`).emit('kicked_by_admin');
                
                const sockets = await io.in(`room_${roomId}`).fetchSockets();
                sockets.forEach(s => {
                    if (s.data.currentUser === target_id) {
                        s.leave(`room_${roomId}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    }
                });
                
                await checkRoomReset(roomId);
                await syncRoom(roomId, io);
                await broadcastRooms(io);
            }
        });

        socket.on('clear_chat_history', async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (room && room.creator_id === userId) {
                await redis.del(`room:${roomId}:chats`);
                await syncRoom(roomId, io);
                socket.emit('reward_success', 'Chat cleared.');
            }
        });

    });
};
