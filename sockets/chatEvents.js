const { db, redis } = require('../database');
const { getRoom, syncRoom } = require('../roomManager');

module.exports = (io, socket, shared) => {
    const { checkRateLimit } = shared;

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

    socket.on('send_reaction', ({ emoji, action }) => {
        const currentRoom = socket.data.currentRoom;
        const currentUser = socket.data.currentUser;
        if (currentRoom && currentUser) {
            io.to(`room_${currentRoom}`).emit('new_reaction', { user_id: currentUser, emoji, action });
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
};