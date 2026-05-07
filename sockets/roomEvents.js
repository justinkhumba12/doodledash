const { db, redis } = require('../database');
const { getRoom, saveRoom, deleteRoomData, broadcastRooms, checkRoomReset, syncRoom } = require('../roomManager');
const { getUserState } = require('../userManager');
const crypto = require('crypto');

module.exports = (io, socket, shared) => {
    const { queuedAction, performJoinRoom, hashPassword } = shared;

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
            const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
            const roomLimits = roomLimitsRaw ? { ...defaultRoomLimits, ...JSON.parse(roomLimitsRaw) } : defaultRoomLimits;

            const isPriv = Boolean(data.is_private);
            const pwd = data.password ? data.password.toString() : '';

            if (isPriv && (!/^\d+$/.test(pwd) || pwd.length < 6 || pwd.length > 10)) {
                return socket.emit('create_error', 'Password must be a numeric value between 6 and 10 digits.');
            }

            let maxMem = roomLimits.publicMax;
            let expireMinutes = 30;
            let cost = 0;

            if (isPriv) {
                maxMem = roomLimits.privateMax;
                
                const timeOpts = roomLimits.timeOptions || defaultRoomLimits.timeOptions;
                let requestedMinutes = parseInt(data.expire_minutes) || timeOpts[0].minutes;
                
                const timeOption = timeOpts.find(opt => opt.minutes === requestedMinutes) || timeOpts[0];
                expireMinutes = timeOption.minutes;

                const baseCost = Number(roomLimits.privateBaseCost) || 0;
                cost = baseCost + Number(timeOption.cost);
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
            const expiryTime = Date.now() + (expireMinutes * 60000);
            
            const roomObj = {
                id: newRoomIdNum,
                creator_id: currentUser,
                is_private: isPriv ? 1 : 0,
                password: isPriv ? hashPassword(pwd) : '',
                invite_token: isPriv ? crypto.randomBytes(3).toString('hex') : null,
                max_members: maxMem,
                status: 'WAITING',
                created_at: Date.now(),
                expire_at: expiryTime,
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
    
    socket.on('extend_room', async (data) => {
        queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.is_private && room.creator_id === currentUser) {
                const roomLimitsRaw = await redis.get('config_room_limits');
                const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
                const roomLimits = roomLimitsRaw ? { ...defaultRoomLimits, ...JSON.parse(roomLimitsRaw) } : defaultRoomLimits;
                const timeOpts = roomLimits.timeOptions || defaultRoomLimits.timeOptions;

                let requestedMinutes = data && data.expire_minutes ? parseInt(data.expire_minutes) : timeOpts[0].minutes;
                const timeOption = timeOpts.find(opt => opt.minutes === requestedMinutes) || timeOpts[0];

                const baseCost = Number(roomLimits.privateBaseCost) || 0;
                const totalCost = baseCost + Number(timeOption.cost);

                if (totalCost > 0) {
                    const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                    if (!userRows.length || userRows[0].credits < totalCost) {
                        return socket.emit('create_error', `Not enough credits. Need ${totalCost} Credits.`);
                    }
                    await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [totalCost, currentUser]);
                    await redis.hincrbyfloat('user_credits', currentUser, -totalCost);
                }

                // Extend expiry time
                const currentExpiry = room.expire_at ? new Date(room.expire_at).getTime() : Date.now();
                room.expire_at = new Date(currentExpiry + (timeOption.minutes * 60000));
                room.has_been_extended = true;

                await saveRoom(room);
                socket.emit('reward_success', `Room extended by ${timeOption.minutes} minutes!`);
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);

                await syncRoom(currentRoom, io);
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

    socket.on('join_room_via_token', async (data) => {
        queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            if (!currentUser) return;
            const { room_id, token } = data;
            
            const room = await getRoom(room_id);
            if (!room || !room.is_private || room.invite_token !== token) {
                return socket.emit('join_error', 'Invalid or expired private room invite link.');
            }
            
            await performJoinRoom(currentUser, room_id, '', true);
        });
    });

    socket.on('join_random_public', async () => {
        queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            if (!currentUser) return;

            const activeRooms = await redis.smembers('active_rooms');
            let bestRoom = null;

            for (const id of activeRooms) {
                const room = await getRoom(id);
                if (room && !room.is_private && room.members.length < room.max_members) {
                    if (room.banned_members && room.banned_members.includes(currentUser)) continue;
                    
                    if (!bestRoom || room.members.length > bestRoom.members.length) {
                        bestRoom = room;
                    }
                }
            }

            if (bestRoom) {
                return await performJoinRoom(currentUser, bestRoom.id, '', true);
            }

            const maxRoomsRaw = await redis.get('config_max_rooms');
            const maxRooms = maxRoomsRaw ? parseInt(maxRoomsRaw) : 1250;
            if (activeRooms.length >= maxRooms) {
                return socket.emit('create_error', 'Server is at maximum room capacity. Please try again later.');
            }

            const roomLimitsRaw = await redis.get('config_room_limits');
            const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
            const roomLimits = roomLimitsRaw ? { ...defaultRoomLimits, ...JSON.parse(roomLimitsRaw) } : defaultRoomLimits;

            const newRoomIdNum = await redis.incr('next_room_id');
            const expireMinutes = 60; 
            const expiryTime = Date.now() + (expireMinutes * 60000);

            const roomObj = {
                id: newRoomIdNum,
                creator_id: currentUser,
                is_private: 0,
                password: '',
                invite_token: null,
                max_members: roomLimits.publicMax,
                status: 'WAITING',
                created_at: Date.now(),
                expire_at: expiryTime,
                round: 0,
                members: []
            };

            await saveRoom(roomObj);
            await redis.sadd('active_rooms', newRoomIdNum);

            await performJoinRoom(currentUser, newRoomIdNum, '', true);
        });
    });

    socket.on('change_password', async ({ password }) => {
        queuedAction(async () => {
            const currentUser = socket.data.currentUser;
            const currentRoom = socket.data.currentRoom;
            if (!currentUser || !currentRoom) return;

            const room = await getRoom(currentRoom);
            if (room && room.is_private && room.creator_id === currentUser) {
                const pwd = password ? password.toString() : '';
                if (!/^\d+$/.test(pwd) || pwd.length < 6 || pwd.length > 10) {
                    return socket.emit('create_error', 'Password must be a numeric value between 6 and 10 digits.');
                }
                room.password = hashPassword(pwd);
                room.invite_token = crypto.randomBytes(3).toString('hex');
                await saveRoom(room);
                socket.emit('reward_success', 'Room password and invite link updated successfully.');
                await syncRoom(currentRoom, io);
            }
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
                
                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: 'left the room.', is_system: true, action_type: 'left', created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
                io.to(`room_${currentRoom}`).emit('new_chat', sysChat);

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
            
            const cId = await redis.incr('global_chat_id');
            const sysChat = { id: cId, room_id: currentRoom, user_id: target_id, message: 'was kicked from the room.', is_system: true, action_type: 'kicked', created_at: new Date() };
            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
            await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
            io.to(`room_${currentRoom}`).emit('new_chat', sysChat);

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
};