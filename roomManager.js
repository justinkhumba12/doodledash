const { db, redis } = require('./database');

async function getRoom(roomId) {
    const data = await redis.get(`room:${roomId}`);
    if (!data) return null;
    const room = JSON.parse(data);
    if (room.modified_at) room.modified_at = new Date(room.modified_at);
    if (room.expire_at) room.expire_at = new Date(room.expire_at);
    if (room.break_end_time) room.break_end_time = new Date(room.break_end_time);
    if (room.round_end_time) room.round_end_time = new Date(room.round_end_time);
    if (!room.banned_members) room.banned_members = [];
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

async function broadcastRooms(io) {
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
}

async function checkRoomReset(roomId) {
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;

    if (room.members.length === 0) {
        if (!room.is_private) {
            await deleteRoomData(roomId);
        } else {
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
}

async function syncRoom(roomId, io) {
    if (!roomId) return;
    const room = await getRoom(roomId);
    if (!room) return;

    const members = room.members;
    const rawChats = await redis.lrange(`room:${roomId}:chats`, 0, -1);
    const chats = rawChats.map(c => JSON.parse(c));
    
    const rawGuesses = await redis.lrange(`room:${roomId}:guesses`, 0, -1);
    const guesses = rawGuesses.map(g => JSON.parse(g));

    const userIds = new Set([...members.map(m => m.user_id), ...chats.map(c => c.user_id), ...guesses.map(g => g.user_id)]);
    const genders = {};
    const names = {};
    const photos = {};
    
    if (userIds.size > 0) {
        const idsArr = Array.from(userIds);
        try {
            const [genRows] = await db.query(`SELECT tg_id, gender, name FROM users WHERE tg_id IN (?)`, [idsArr]);
            genRows.forEach(r => {
                genders[r.tg_id] = r.gender;
                names[r.tg_id] = r.name;
            });

            const fetchedPhotos = await redis.hmget('user_photos', ...idsArr);
            idsArr.forEach((id, index) => {
                if (fetchedPhotos[index]) {
                    photos[id] = fetchedPhotos[index];
                }
            });
        } catch (e) {
            console.error('Data fetch error in syncRoom:', e);
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
                    round_end_time: room.round_end_time ? room.round_end_time.toISOString() : null,
                    has_been_extended: room.has_been_extended || false
                },
                members,
                chats, 
                guesses: sanitizedGuesses,
                genders,
                names,
                photos,
                masked_word: masked_word,
                server_time: new Date().toISOString()
            });
        }
    }
}

module.exports = { getRoom, saveRoom, releaseRoomMemory, deleteRoomData, broadcastRooms, checkRoomReset, syncRoom };
