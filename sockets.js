const { db, redis } = require('./database');
const { toHex, getWeekKey, validateInitData } = require('./utils');
const { getRoom, saveRoom, releaseRoomMemory, deleteRoomData, broadcastRooms, checkRoomReset, syncRoom } = require('./roomManager');
const { getUserState } = require('./userManager');
const config = require('./config');

const calculateStrokeLength = (lines) => {
    let strokeLength = 0;
    for (let i = 0; i < lines.length; i += 4) {
        strokeLength += Math.hypot(lines[i+2] - lines[i], lines[i+3] - lines[i+1]);
    }
    return strokeLength;
};

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
                const roomLimitsRaw = await redis.get('config_room_limits');
                
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
                    maxRooms: maxRoomsRaw ? parseInt(maxRoomsRaw) : 1250,
                    roomLimits: roomLimitsRaw ? JSON.parse(roomLimitsRaw) : { publicMax: 8, privateMax: 10, privateFree: 4, privateExtraCost: 1 }
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
                            msg = 'Ad reward not ready yet or max claims reached.';
                        }
                    }
                } else if (type === 'invite_3') {
                    const [userRows] = await db.query(`SELECT weekly_invites, invite_claimed_this_week FROM users WHERE tg_id = ?`, [currentUser]);
                    if (userRows.length > 0) {
                        if (userRows[0].weekly_invites >= 3 && !userRows[0].invite_claimed_this_week) {
                            rewardAmount = 5;
                            await db.query(`UPDATE users SET credits = credits + ?, invite_claimed_this_week = 1 WHERE tg_id = ?`, [rewardAmount, currentUser]);
                            success = true; msg = 'Invite reward claimed! +5 Credits';
                        } else {
                            msg = 'Invite requirement not met or already claimed.';
                        }
                    }
                }

                if (success) {
                    await redis.hincrbyfloat('user_credits', currentUser, rewardAmount);
                    socket.emit('reward_success', msg);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    socket.emit('create_error', msg || 'Could not claim reward.');
                }
            } catch (err) {
                console.error('Claim Error:', err);
            }
        });

        socket.on('create_room', async (data) => {
            queuedAction(async () => {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;

                const maxRoomsRaw = await redis.get('config_max_rooms');
                const maxRooms = maxRoomsRaw ? parseInt(maxRoomsRaw) : 1250;
                const activeRooms = await redis.smembers('active_rooms');
                if (activeRooms.length >= maxRooms) {
                    return socket.emit('create_error', 'Server is at maximum room capacity. Please join an existing room or try again later.');
                }

                const roomLimitsRaw = await redis.get('config_room_limits');
                const roomLimits = roomLimitsRaw ? JSON.parse(roomLimitsRaw) : { publicMax: 8, privateMax: 10, privateFree: 4, privateExtraCost: 1 };

                const isPriv = Boolean(data.is_private);
                const pwd = data.password || '';
                let maxMem = parseInt(data.max_members) || 6;
                const expireHours = parseFloat(data.expire_hours) || 0.5;

                // Adjust based on limits
                if (!isPriv) {
                    maxMem = roomLimits.publicMax; // Force fixed size for public
                } else {
                    maxMem = Math.min(maxMem, roomLimits.privateMax); // Cap private
                }

                let cost = 0;
                if (isPriv) {
                    const extraUsers = Math.max(0, maxMem - roomLimits.privateFree);
                    cost = (extraUsers * roomLimits.privateExtraCost) + (expireHours === 1 ? 2 : 1);
                }

                if (cost > 0) {
                    const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                    if (!userRows.length || userRows[0].credits < cost) {
                        return socket.emit('create_error', `Not enough credits. Need ${cost} Credits.`);
                    }
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                    await redis.hincrbyfloat('user_credits', currentUser, -cost);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                }

                const newRoomIdNum = await redis.incr('next_room_id');
                const expiryTime = Date.now() + (expireHours * 3600000);
                
                const roomObj = {
                    id: newRoomIdNum,
                    creator_id: currentUser,
                    is_private: isPriv ? 1 : 0,
                    password: pwd,
                    max_members: maxMem,
                    status: 'WAITING',
                    created_at: Date.now(),
                    expires_at: expiryTime,
                    round: 0,
                    members: []
                };
                
                await saveRoom(roomObj);
                await redis.sadd('active_rooms', newRoomIdNum);
                
                if (data.auto_join) {
                    await performJoinRoom(currentUser, newRoomIdNum, pwd, true);
                } else {
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('join_room', async (data) => {
            queuedAction(async () => {
                const currentUser = socket.data.currentUser;
                if (!currentUser) return;
                await performJoinRoom(currentUser, data.room_id, data.password || '');
            });
        });

        socket.on('leave_room', async () => {
            queuedAction(async () => {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                socket.leave(`room_${currentRoom}`);
                socket.join('lobby');
                socket.data.currentRoom = null;

                const room = await getRoom(currentRoom);
                if (room) {
                    room.members = room.members.filter(m => m.user_id !== currentUser);
                    await saveRoom(room);
                    await checkRoomReset(currentRoom);
                    await syncRoom(currentRoom, io);
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('delete_room', async () => {
            queuedAction(async () => {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                const room = await getRoom(currentRoom);
                if (room && room.creator_id === currentUser) {
                    io.to(`room_${currentRoom}`).emit('room_expired');
                    await deleteRoomData(currentRoom);
                    const sockets = await io.in(`room_${currentRoom}`).fetchSockets();
                    for (const s of sockets) {
                        s.leave(`room_${currentRoom}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    }
                    await broadcastRooms(io);
                }
            });
        });

        socket.on('chat', async (data) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !data.message) return;
            
            if (!checkRateLimit()) return;

            const [userRows] = await db.query('SELECT status FROM users WHERE tg_id = ?', [currentUser]);
            if (userRows.length && userRows[0].status === 'mute') {
                return socket.emit('create_error', 'You are currently muted and cannot send messages.');
            }

            const msgId = await redis.incr('global_chat_id');
            const chatObj = {
                id: msgId,
                room_id: currentRoom,
                user_id: currentUser,
                message: data.message.substring(0, 200),
                created_at: new Date()
            };

            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(chatObj));
            await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);

            io.to(`room_${currentRoom}`).emit('new_chat', chatObj);
        });

        socket.on('set_word', async ({ word }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !word) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'PRE_DRAW' && room.current_drawer_id === currentUser) {
                room.word_to_draw = word.toUpperCase();
                room.status = 'DRAWING';
                room.round_end_time = new Date(Date.now() + 90000);
                room.masked_word = word.split('').map((c, i) => ({ char: c, revealed: c === ' ', index: i }));
                
                await redis.del(`room:${currentRoom}:drawings`, `room:${currentRoom}:redo`, `room:${currentRoom}:guesses`);
                await saveRoom(room);
                await syncRoom(currentRoom, io);
            }
        });

        socket.on('draw', async (data) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !data.lines) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                const drawObj = { lines: data.lines, color: 'black' };
                await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawObj));
                // Clear redo queue since new drawing action invalidates future redos
                await redis.del(`room:${currentRoom}:redo`);
                
                let strokeLength = calculateStrokeLength(data.lines);
                
                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    member.ink_used['black'] = (member.ink_used['black'] || 0) + strokeLength;
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { color: 'black', used: member.ink_used['black'] });
                }

                socket.to(`room_${currentRoom}`).emit('live_draw', drawObj);
                
                const drawingsLen = await redis.llen(`room:${currentRoom}:drawings`);
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: drawingsLen, redo_steps: 0 });
            }
        });

        socket.on('clear_all', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                await redis.del(`room:${currentRoom}:drawings`);
                await redis.del(`room:${currentRoom}:redo`);
                
                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    member.ink_used['black'] = 0;
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { color: 'black', used: 0 });
                }

                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', []);
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            }
        });

        socket.on('undo', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                const lastDrawStr = await redis.rpop(`room:${currentRoom}:drawings`);
                if (lastDrawStr) {
                    await redis.lpush(`room:${currentRoom}:redo`, lastDrawStr);
                    
                    const lastDraw = JSON.parse(lastDrawStr);
                    const strokeLength = calculateStrokeLength(lastDraw.lines);

                    const member = room.members.find(m => m.user_id === currentUser);
                    if (member) {
                        member.ink_used = member.ink_used || {};
                        member.ink_used['black'] = Math.max(0, (member.ink_used['black'] || 0) - strokeLength);
                        await saveRoom(room);
                        io.to(`room_${currentRoom}`).emit('update_ink', { color: 'black', used: member.ink_used['black'] });
                    }

                    const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                    const drawings = rawDrawings.map(d => JSON.parse(d));
                    io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                    const drawingsLen = await redis.llen(`room:${currentRoom}:drawings`);
                    const redoLen = await redis.llen(`room:${currentRoom}:redo`);
                    io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: drawingsLen, redo_steps: redoLen });
                }
            }
        });

        socket.on('redo', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                const nextDrawStr = await redis.lpop(`room:${currentRoom}:redo`);
                if (nextDrawStr) {
                    await redis.rpush(`room:${currentRoom}:drawings`, nextDrawStr);
                    
                    const nextDraw = JSON.parse(nextDrawStr);
                    const strokeLength = calculateStrokeLength(nextDraw.lines);

                    const member = room.members.find(m => m.user_id === currentUser);
                    if (member) {
                        member.ink_used = member.ink_used || {};
                        member.ink_used['black'] = (member.ink_used['black'] || 0) + strokeLength;
                        await saveRoom(room);
                        io.to(`room_${currentRoom}`).emit('update_ink', { color: 'black', used: member.ink_used['black'] });
                    }

                    const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                    const drawings = rawDrawings.map(d => JSON.parse(d));
                    io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                    const drawingsLen = await redis.llen(`room:${currentRoom}:drawings`);
                    const redoLen = await redis.llen(`room:${currentRoom}:redo`);
                    io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: drawingsLen, redo_steps: redoLen });
                }
            }
        });

        socket.on('guess', async (data) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !data.guess) return;

            const room = await getRoom(currentRoom);
            if (!room || room.status !== 'DRAWING' || room.current_drawer_id === currentUser) return;

            const member = room.members.find(m => m.user_id === currentUser);
            if (!member || member.has_given_up) return;

            const rawGuesses = await redis.lrange(`room:${currentRoom}:guesses`, 0, -1);
            const guesses = rawGuesses.map(g => JSON.parse(g));
            const myGuesses = guesses.filter(g => g.user_id === currentUser);

            if (myGuesses.length >= 6) return socket.emit('create_error', 'Max guesses reached.');

            const isCorrect = data.guess.toUpperCase() === room.word_to_draw;
            const guessObj = {
                id: Date.now(),
                user_id: currentUser,
                guess_text: isCorrect ? 'Correct guess!' : data.guess.toUpperCase(),
                is_correct: isCorrect
            };

            await redis.rpush(`room:${currentRoom}:guesses`, JSON.stringify(guessObj));
            io.to(`room_${currentRoom}`).emit('new_guess', guessObj);

            if (isCorrect) {
                room.status = 'REVEAL';
                room.last_winner_id = currentUser;
                room.break_end_time = new Date(Date.now() + 5000);
                room.members.forEach(m => { m.is_ready = 0; });
                await saveRoom(room);

                await db.query('UPDATE users SET credits = credits + 2 WHERE tg_id = ?', [currentUser]);
                await db.query('UPDATE users SET credits = credits + 1 WHERE tg_id = ?', [room.current_drawer_id]);
                await redis.hincrbyfloat('user_credits', currentUser, 2);
                await redis.hincrbyfloat('user_credits', room.current_drawer_id, 1);

                const weekKey = getWeekKey();
                await db.query(`INSERT INTO user_weekly_stats (tg_id, week_key, guesses, guesses_updated_at) VALUES (?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE guesses = guesses + 1, guesses_updated_at = NOW()`, [currentUser, weekKey]);

                await syncRoom(currentRoom, io);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            }
        });

        socket.on('buy_ink', async ({ color }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                const inkConfigRaw = await redis.get('config_ink');
                const inkConfig = inkConfigRaw ? JSON.parse(inkConfigRaw) : { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 };
                
                const member = room.members.find(m => m.user_id === currentUser);
                if (!member) return;
                
                member.ink_extra = member.ink_extra || {};
                const buysMade = (member.ink_extra[color] || 0) / inkConfig.extra;
                
                if (buysMade >= inkConfig.max_buys) {
                    return socket.emit('create_error', 'Maximum ink refills reached for this round.');
                }

                const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (userRows.length && userRows[0].credits >= inkConfig.cost) {
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [inkConfig.cost, currentUser]);
                    await redis.hincrbyfloat('user_credits', currentUser, -inkConfig.cost);
                    
                    member.ink_extra[color] = (member.ink_extra[color] || 0) + inkConfig.extra;
                    await saveRoom(room);
                    
                    io.to(`room_${currentRoom}`).emit('update_ink_capacity', { user_id: currentUser, extra: member.ink_extra });
                    
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    socket.emit('create_error', 'Not enough credits to buy ink.');
                }
            }
        });

        socket.on('buy_hint_credit', async ({ index }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id !== currentUser) {
                const item = room.masked_word[index];
                if (item && !item.revealed) {
                    const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                    if (userRows.length && userRows[0].credits >= 1) {
                        await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                        await redis.hincrbyfloat('user_credits', currentUser, -1);
                        
                        item.revealed = true;
                        await saveRoom(room);
                        await syncRoom(currentRoom, io);
                        
                        const userState = await getUserState(currentUser);
                        if (userState) socket.emit('user_update', userState);
                    } else {
                        socket.emit('create_error', 'Not enough credits.');
                    }
                }
            }
        });

        socket.on('buy_hint_ad', async ({ index }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id !== currentUser) {
                const item = room.masked_word[index];
                if (item && !item.revealed) {
                    item.revealed = true;
                    await saveRoom(room);
                    await syncRoom(currentRoom, io);
                }
            }
        });

        socket.on('buy_guess', async ({ guess }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            
            const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (userRows.length && userRows[0].credits >= 1) {
                await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                await redis.hincrbyfloat('user_credits', currentUser, -1);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                
                socket.emit('reward_success', 'Extra guesses unlocked!');
            } else {
                socket.emit('create_error', 'Not enough credits.');
            }
        });

        socket.on('drawer_give_up', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                room.status = 'REVEAL';
                room.end_reason = 'drawer_gave_up';
                room.break_end_time = new Date(Date.now() + 5000);
                room.members.forEach(m => { m.is_ready = 0; });
                await saveRoom(room);
                await syncRoom(currentRoom, io);
            }
        });

        socket.on('guesser_give_up', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && (room.status === 'DRAWING' || room.status === 'PRE_DRAW') && room.current_drawer_id !== currentUser) {
                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.has_given_up = 1;
                    await saveRoom(room);
                    
                    const activeGuessers = room.members.filter(m => m.user_id !== room.current_drawer_id);
                    const allGivenUp = activeGuessers.length > 0 && activeGuessers.every(m => m.has_given_up);
                    
                    if (allGivenUp && room.status === 'DRAWING') {
                        room.status = 'REVEAL';
                        room.end_reason = 'all_gave_up';
                        room.break_end_time = new Date(Date.now() + 5000);
                        room.members.forEach(m => { m.is_ready = 0; });
                        await saveRoom(room);
                    }
                    await syncRoom(currentRoom, io);
                }
            }
        });

        socket.on('kick_player', async ({ target_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !target_id) return;

            const room = await getRoom(currentRoom);
            if (room && room.is_private && room.creator_id === currentUser) {
                room.members = room.members.filter(m => m.user_id !== target_id);
                room.banned_members = room.banned_members || [];
                if (!room.banned_members.includes(target_id)) {
                    room.banned_members.push(target_id);
                }
                await saveRoom(room);
                
                const targetSocket = await io.in(`room_${currentRoom}`).fetchSockets().then(sockets => sockets.find(s => s.data.currentUser === target_id));
                if (targetSocket) {
                    targetSocket.leave(`room_${currentRoom}`);
                    targetSocket.join('lobby');
                    targetSocket.data.currentRoom = null;
                    targetSocket.emit('join_error', 'You have been kicked from the room by the creator.');
                }
                
                await checkRoomReset(currentRoom);
                await syncRoom(currentRoom, io);
                await broadcastRooms(io);
            }
        });

        socket.on('delete_chat_message', async ({ message_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom || !message_id) return;

            const room = await getRoom(currentRoom);
            if (room && room.creator_id === currentUser) {
                const rawChats = await redis.lrange(`room:${currentRoom}:chats`, 0, -1);
                let chats = rawChats.map(c => JSON.parse(c));
                let updated = false;
                chats = chats.map(c => {
                    if (c.id === message_id) {
                        c.message = '[Deleted by room creator]';
                        updated = true;
                    }
                    return c;
                });
                
                if (updated) {
                    await redis.del(`room:${currentRoom}:chats`);
                    for (const c of chats) {
                        await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(c));
                    }
                    await syncRoom(currentRoom, io);
                }
            }
        });

        socket.on('clear_chat_history', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.creator_id === currentUser) {
                await redis.del(`room:${currentRoom}:chats`);
                await syncRoom(currentRoom, io);
            }
        });

        socket.on('disconnect', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (currentUser) {
                await redis.hset('user_disconnects', currentUser, Date.now());
                
                setTimeout(async () => {
                    const isDisconnected = await redis.hget('user_disconnects', currentUser);
                    if (isDisconnected && currentRoom) {
                        const room = await getRoom(currentRoom);
                        if (room) {
                            room.members = room.members.filter(m => m.user_id !== currentUser);
                            await saveRoom(room);
                            await checkRoomReset(currentRoom);
                            await syncRoom(currentRoom, io);
                            await broadcastRooms(io);
                        }
                        await redis.hdel('user_disconnects', currentUser);
                    }
                }, 10000);
            }
        });

    });
};
