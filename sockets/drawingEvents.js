const { redis } = require('../database');
const { getRoom, saveRoom } = require('../roomManager');

module.exports = (io, socket, shared) => {
    const { calculateStrokeLength } = shared;

    socket.on('request_initial_drawings', async () => {
        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
            const drawings = rawDrawings.map(d => JSON.parse(d));
            socket.emit('sync_initial_drawings', drawings.map(d => ({ lines: d.lines, color: d.color })));
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
};