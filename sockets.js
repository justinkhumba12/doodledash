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

                socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom: socket.data.currentRoom });
            } catch (err) { 
                console.error('Auth Error', err); 
                socket.emit('auth_error', 'Authentication processing failed.');
            }
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
                    const [res] = await db.query(`
                        UPDATE users SET credits = credits + 1, last_daily_claim = UTC_DATE()
                        WHERE tg_id = ? AND (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'))
                    `, [currentUser]);
                    if (res.affectedRows > 0) { success = true; rewardAmount = 1; msg = 'Daily reward claimed! +1 Credit'; }
                    else { msg = 'Daily reward already claimed today.'; }
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
                            if (prefix === 'ad' && newClaimCount === 3) rewardAmount = 2;
                            if (prefix === 'ad2' && (newClaimCount === 4 || newClaimCount === 5)) rewardAmount = 2;

                            await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = ?, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                            success = true; msg = `Reward claimed! +${rewardAmount} Credit${rewardAmount > 1 ? 's' : ''}`;
                        } else {
                            msg = `Ad reward not available yet. Max ${maxClaims} per day, ${cooldown} mins apart.`;
                        }
                    }
                } else if (type === 'invite_3') {
                    const weekKey = getWeekKey();
                    const [statsRows] = await db.query('SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?', [currentUser, weekKey]);
                    const weeklyInvites = statsRows.length > 0 ? statsRows[0].invites : 0;
                    const [u] = await db.query(`SELECT last_invite_claim_week FROM users WHERE tg_id = ?`, [currentUser]);

                    if (u.length > 0) {
                        const user = u[0];
                        const claimedThisWeek = user.last_invite_claim_week === weekKey;

                        if (weeklyInvites >= 3 && !claimedThisWeek) {
                            rewardAmount = 5;
                            await db.query(`UPDATE users SET credits = credits + ?, last_invite_claim_week = ? WHERE tg_id = ?`, [rewardAmount, weekKey, currentUser]);
                            success = true;
                            msg = 'Weekly task completed! +5 Credits claimed.';
                        } else if (claimedThisWeek) {
                            msg = 'You have already claimed this weekly reward. Keep inviting to top the leaderboard!';
                        } else {
                            msg = `Not enough invites yet. Progress: ${weeklyInvites}/3`;
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

                const limit = [2, 3, 4, 5, 6].includes(max_members) ? max_members : 6;
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
                    
                    cost = limit; // 1 credit per maximum user capacity
                    
                    const hours = [0.5, 1].includes(expire_hours) ? expire_hours : 0.5;
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
                    has_been_extended: false,
                    undo_steps: 0, redo_steps: 0,
                    members: [], banned_members: []
                });

                if (auto_join) {
                    await performJoinRoom(currentUser, newRoomId, password, true);
                } else {
                    socket.emit('room_created', { room_id: newRoomId });
                }
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await broadcastRooms(io);
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
            await syncRoom(currentRoom, io);
            socket.data.currentRoom = null;
            await broadcastRooms(io);
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
            
            await broadcastRooms(io);
        });

        socket.on('extend_room', async ({ expire_hours }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                
                const room = await getRoom(currentRoom);
                if (!room || !room.is_private || room.creator_id !== currentUser) return;
                if (room.has_been_extended) return socket.emit('create_error', 'Room duration can only be extended once.');

                const hours = [0.5, 1].includes(expire_hours) ? expire_hours : 0.5;
                let cost = hours === 1 ? 2 : 1;
                
                const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                if (currentCredits < cost) return socket.emit('create_error', 'Not enough credits to extend room.');

                await redis.hset('user_credits', currentUser, currentCredits - cost);
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);
                
                room.expire_at = new Date(room.expire_at.getTime() + hours * 3600000);
                room.has_been_extended = true;
                await saveRoom(room);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                await syncRoom(currentRoom, io);
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
            await broadcastRooms(io);
            await syncRoom(currentRoom, io);
        });

        socket.on('kick_player', async ({ target_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;
            const room = await getRoom(currentRoom);
            if (!room || !room.is_private || room.creator_id !== currentUser) return;

            if (!room.banned_members) room.banned_members = [];
            room.banned_members.push(target_id);

            room.members = room.members.filter(m => m.user_id !== target_id);
            await saveRoom(room);
            
            io.to(`user_${target_id}`).emit('kicked_by_admin');
            const sockets = await io.in(`user_${target_id}`).fetchSockets();
            sockets.forEach(s => {
                s.leave(`room_${currentRoom}`);
                s.join('lobby'); 
                if (s.data.currentRoom === currentRoom) s.data.currentRoom = null;
            });

            await syncRoom(currentRoom, io);
            await broadcastRooms(io);
        });

        socket.on('delete_message', async ({ message_id }) => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || room.creator_id !== currentUser) return;

            const rawChats = await redis.lrange(`room:${currentRoom}:chats`, 0, -1);
            const updatedChats = [];
            for (const raw of rawChats) {
                const chat = JSON.parse(raw);
                if (chat.id === message_id) {
                    chat.message = '[Deleted by admin]';
                }
                updatedChats.push(JSON.stringify(chat));
            }
            
            await redis.del(`room:${currentRoom}:chats`);
            if (updatedChats.length > 0) {
                await redis.rpush(`room:${currentRoom}:chats`, ...updatedChats);
            }
            await syncRoom(currentRoom, io);
        });

        socket.on('clear_chat', async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || room.creator_id !== currentUser) return;

            await redis.del(`room:${currentRoom}:chats`);
            await syncRoom(currentRoom, io);
        });

        socket.on('chat', async ({ message }) => {
            if (!message || typeof message !== 'string') return;
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const msgStr = message.trim();
            if (!msgStr) return;
            if (msgStr.length > 200) return socket.emit('create_error', 'Message exceeds 200 character limit.');
            if (!checkRateLimit()) return socket.emit('create_error', 'Rate limit active: Please wait 1 second between messages.');

            const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [currentUser]);
            if (rows.length > 0) {
                const user = rows[0];
                if (user.status === 'mute' && user.mute_until_str) {
                    const todayStr = new Date().toISOString().split('T')[0];
                    if (user.mute_until_str >= todayStr) {
                        return socket.emit('create_error', `You are muted until ${user.mute_until_str}. Open the bot and use /start unmute to lift this restriction.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [currentUser]);
                    }
                }
            }

            const cId = await redis.incr('global_chat_id');
            const newChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: msgStr, created_at: new Date() };
            
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
            const uState = await getUserState(currentUser);
            const dName = uState?.name || toHex(currentUser);

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
                const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${dName} voted to give up.`, created_at: new Date() };
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
            await syncRoom(currentRoom, io);
        });

        socket.on('guess', async ({ guess }) => {
            try {
                if (!guess || typeof guess !== 'string') return;
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return socket.emit('create_error', 'Not logged in or in room.');
                
                const guessStr = guess.trim().toUpperCase();
                if (!guessStr) return;
                if (!checkRateLimit()) return socket.emit('create_error', 'Rate limit active: Please wait 1 second between guesses.');
                
                const room = await getRoom(currentRoom);
                if (!room) return;
                if (room.status !== 'DRAWING') return socket.emit('create_error', 'You can only guess during the drawing phase.');
                if (room.current_drawer_id === currentUser) return socket.emit('create_error', 'The drawer cannot guess.');

                if (guessStr.length !== room.word_to_draw.length) {
                    return socket.emit('create_error', `Guess must be exactly ${room.word_to_draw.length} characters long.`);
                }
                
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

                const isCorrect = room.word_to_draw && room.word_to_draw.toUpperCase() === guessStr;
                const gId = await redis.incr('global_guess_id');
                const newGuess = { id: gId, room_id: currentRoom, user_id: currentUser, guess_text: guessStr, is_correct: isCorrect ? 1 : 0, created_at: new Date() };
                
                await redis.rpush(`room:${currentRoom}:guesses`, JSON.stringify(newGuess));
                io.to(`room_${currentRoom}`).emit('new_guess', newGuess);

                if (isCorrect) {
                    const weekKey = getWeekKey();
                    await db.query(`
                        INSERT INTO user_weekly_stats (tg_id, week_key, guesses, guesses_updated_at)
                        VALUES (?, ?, 1, UTC_TIMESTAMP())
                        ON DUPLICATE KEY UPDATE guesses = guesses + 1, guesses_updated_at = UTC_TIMESTAMP()
                    `, [currentUser, weekKey]);

                    room.status = 'REVEAL';
                    room.end_reason = 'guessed';
                    room.break_end_time = new Date(Date.now() + 5000); 
                    room.round_end_time = null;
                    room.last_winner_id = currentUser;
                    await saveRoom(room);
                    await syncRoom(currentRoom, io); 
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
                if (purchased.length >= 1) return socket.emit('create_error', 'You can only reveal 1 hint per round.');

                if (!purchased.includes(index)) {
                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < 1) return socket.emit('create_error', 'Not enough credits to buy a hint.');

                    await redis.hset('user_credits', currentUser, currentCredits - 1);
                    await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                    
                    purchased.push(index);
                    member.purchased_hints = JSON.stringify(purchased);
                    await saveRoom(room);
                    
                    const uState = await getUserState(currentUser);
                    const dName = uState?.name || toHex(currentUser);
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${dName} used a hint for 1 Credit!`, created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                    
                    if (uState) socket.emit('user_update', uState);
                    await syncRoom(currentRoom, io);
                }
            } catch (err) { console.error('Buy Hint Error:', err); }
        });

        socket.on('buy_hint_ad', async ({ index }) => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;

                const room = await getRoom(currentRoom);
                if (!room) return;
                const member = room.members.find(m => m.user_id === currentUser);
                if (!member) return;

                let purchased = JSON.parse(member.purchased_hints || '[]');
                if (purchased.length >= 1) return socket.emit('create_error', 'You can only reveal 1 hint per round.');

                if (!purchased.includes(index)) {
                    purchased.push(index);
                    member.purchased_hints = JSON.stringify(purchased);
                    await saveRoom(room);
                    
                    const uState = await getUserState(currentUser);
                    const dName = uState?.name || toHex(currentUser);
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: 'System', message: `${dName} used a hint by watching an ad!`, created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -30, -1);
                    
                    await syncRoom(currentRoom, io);
                }
            } catch (err) { console.error('Buy Hint Ad Error:', err); }
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
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            await syncRoom(currentRoom, io);
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
                await syncRoom(currentRoom, io);
            }
        });

        socket.on('draw', ({ lines }) => queuedAction(async () => {
            if (!Array.isArray(lines) || lines.length > 2000) {
                return socket.emit('create_error', 'Drawing payload rejected: invalid or exceeded maximum points limit.');
            }

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
            
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
        }));

        socket.on('undo', () => queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (!room || (room.undo_steps || 0) <= 0 || room.current_drawer_id !== currentUser) return;
            
            const lastRaw = await redis.rpop(`room:${currentRoom}:drawings`);
            if (lastRaw) {
                await redis.rpush(`room:${currentRoom}:redo`, lastRaw);
                await redis.ltrim(`room:${currentRoom}:redo`, -3, -1);
                
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
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                
                if (member) {
                    io.to(`user_${toRestore.user_id}`).emit('update_ink', { color: toRestore.color, used: member.ink_used[toRestore.color] || 0 });
                }
            }
        }));

        socket.on('redo', () => queuedAction(async () => {
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
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_steps, redo_steps: room.redo_steps });
                
                if (member) {
                    io.to(`user_${toRestore.user_id}`).emit('update_ink', { color: toRestore.color, used: member.ink_used[toRestore.color] || 0 });
                }
            }
        }));

        socket.on('clear_all', () => queuedAction(async () => {
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
            io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: 0, redo_steps: 0 });
            io.to(`user_${currentUser}`).emit('update_ink', { color: 'black', used: 0 });
        }));

        socket.on('buy_ink', async () => {
            try {
                const currentUser = socket.data.currentUser;
                const currentRoom = socket.data.currentRoom;
                if (!currentUser || !currentRoom) return;
                const room = await getRoom(currentRoom);
                if (!room || room.status !== 'DRAWING') return;
                
                const targetColor = 'black'; 
                const cost = config.INK_CONFIG[targetColor].cost;
                const extraInkAmount = config.INK_CONFIG[targetColor].extra; 

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    if (!member.ink_extra) member.ink_extra = {};
                    
                    const currentExtra = member.ink_extra[targetColor] || 0;
                    
                    if (currentExtra >= 2500) {
                        return socket.emit('create_error', 'Maximum ink refill limit reached for this round.');
                    }

                    const currentCredits = parseFloat(await redis.hget('user_credits', currentUser)) || 0;
                    if (currentCredits < cost) {
                        return socket.emit('create_error', `Not enough credits to buy ink.`);
                    }

                    await redis.hset('user_credits', currentUser, currentCredits - cost);
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [cost, currentUser]);

                    member.ink_extra[targetColor] = Math.min(currentExtra + extraInkAmount, 2500); 
                    await saveRoom(room);

                    socket.emit('reward_success', `+${extraInkAmount} Ink added!`);
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                    
                    await syncRoom(currentRoom, io); 
                }
            } catch (err) { console.error('Buy Ink Error:', err); }
        });

        socket.on('disconnect', async () => {
            const currentUser = socket.data.currentUser;
            if (currentUser) {
                const activeSockets = await io.in(`user_${currentUser}`).fetchSockets();
                if (activeSockets.length === 0) {
                    await redis.hset('user_disconnects', currentUser, Date.now());
                }
            }
        });
    });
};
