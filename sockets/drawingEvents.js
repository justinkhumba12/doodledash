const { redis } = require('../database');
const { getRoom, saveRoom } = require('../roomManager');

module.exports = (io, socket, shared) => {
    const { calculateStrokeLength } = shared;

    // Server-side validation helpers
    const isValidColor = (c) => typeof c === 'string' && (['black', 'red', 'green'].includes(c) || /^#[0-9A-Fa-f]{6}$/i.test(c));

    socket.on('request_initial_drawings', async () => {
        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
            const drawings = rawDrawings.map(d => JSON.parse(d));
            socket.emit('sync_initial_drawings', drawings.map(d => ({ 
                lines: d.lines, 
                color: d.color,
                isGlow: d.isGlow,
                glowColor: d.glowColor,
                isNeon: d.isNeon
            })));
        }
    });

    socket.on('draw', async (data) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom || !data.lines) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
            // Apply sanitization and strictly valid types to prevent abuse via custom payloads
            const sColor = isValidColor(data.color) ? data.color : 'black';
            const sGlow = !!data.isGlow;
            const sNeon = !!data.isNeon;
            const sGlowColor = isValidColor(data.glowColor) ? data.glowColor : '#ffff00';

            const drawObj = { 
                lines: data.lines, 
                color: sColor,
                isGlow: sGlow,
                glowColor: sGlowColor,
                isNeon: sNeon
            };
            
            await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawObj));
            await redis.del(`room:${currentRoom}:redo`);
            
            let strokeLength = calculateStrokeLength(data.lines);
            
            const member = room.members.find(m => m.user_id === currentUser);
            if (member) {
                member.ink_used = member.ink_used || {};
                
                // Track usage across a unified 'total' property, inheriting legacy 'black' value if present
                const newTotal = (member.ink_used['total'] || member.ink_used['black'] || 0) + strokeLength;
                member.ink_used['total'] = newTotal;
                
                await saveRoom(room);
                io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
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
                member.ink_used['total'] = 0;
                await saveRoom(room);
                io.to(`room_${currentRoom}`).emit('update_ink', { used: 0 });
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
                    const newTotal = Math.max(0, (member.ink_used['total'] || member.ink_used['black'] || 0) - strokeLength);
                    member.ink_used['total'] = newTotal;
                    
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
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
                    const newTotal = (member.ink_used['total'] || member.ink_used['black'] || 0) + strokeLength;
                    member.ink_used['total'] = newTotal;
                    
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
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