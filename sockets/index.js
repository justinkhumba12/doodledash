const { redis } = require('../database');
const { getRoom, saveRoom, broadcastRooms, checkRoomReset, syncRoom } = require('../roomManager');
const { getUserState } = require('../userManager');
const crypto = require('crypto');

const connectionEvents = require('./connectionEvents');
const roomEvents = require('./roomEvents');
const gameEvents = require('./gameEvents');
const drawingEvents = require('./drawingEvents');
const chatEvents = require('./chatEvents');

const hashPassword = (pwd) => {
    return crypto.createHash('sha256').update(pwd.toString()).digest('hex');
};

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
                    const pwdStr = password ? password.toString() : '';
                    if (room.creator_id !== userId) {
                        if (!/^\d+$/.test(pwdStr) || room.password !== hashPassword(pwdStr)) {
                            return socket.emit('join_error', 'Incorrect password.');
                        }
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
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: oldRoom, user_id: userId, message: 'left the room.', is_system: true, action_type: 'left', created_at: new Date() };
                    await redis.rpush(`room:${oldRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${oldRoom}:chats`, -50, -1);
                    io.to(`room_${oldRoom}`).emit('new_chat', sysChat);

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
                purchased_guesses: 0,
                ink_used: {},      
                ink_extra: {},     
                ink_buys: {},      
                joined_at: Date.now() 
            });

            await saveRoom(room);
            socket.data.currentRoom = roomIdNum;
            socket.join(`room_${roomIdNum}`);
            socket.leave('lobby');
            socket.emit('join_success', roomIdNum);
            
            const cId = await redis.incr('global_chat_id');
            const sysChat = { id: cId, room_id: roomIdNum, user_id: userId, message: 'joined the room.', is_system: true, action_type: 'join', created_at: new Date() };
            await redis.rpush(`room:${roomIdNum}:chats`, JSON.stringify(sysChat));
            await redis.ltrim(`room:${roomIdNum}:chats`, -50, -1);
            io.to(`room_${roomIdNum}`).emit('new_chat', sysChat);

            if (oldRoom) await syncRoom(oldRoom, io);
            await syncRoom(roomIdNum, io);
            await broadcastRooms(io);

            const userState = await getUserState(userId);
            if (userState) socket.emit('user_update', userState);
        };

        const shared = {
            hashPassword,
            calculateStrokeLength,
            checkRateLimit,
            queuedAction,
            performJoinRoom
        };

        connectionEvents(io, socket, shared);
        roomEvents(io, socket, shared);
        gameEvents(io, socket, shared);
        drawingEvents(io, socket, shared);
        chatEvents(io, socket, shared);
    });
};