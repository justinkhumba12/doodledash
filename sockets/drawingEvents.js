const { redis } = require('../database');
const { getRoom, saveRoom } = require('../roomManager');

module.exports = (io, socket, shared) => {
    const { calculateStrokeLength } = shared;
    const ALLOWED_COLORS = ['gradient-mix', 'eraser'];

    socket.on('request_initial_drawings', async () => {
        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
            const drawings = rawDrawings.map(d => JSON.parse(d));
            socket.emit('sync_initial_drawings', drawings.map(d => ({ 
                lines: d.lines, 
                color: d.color, 
                glow: !!d.glow,
                glowColor: d.glowColor || '#00ffff'
            })));
        }
    });

    socket.on('draw', async (data) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom || !data.lines) return;

        // Strict Server-Side Validation logic
        const safeColor = ALLOWED_COLORS.includes(data.color) ? data.color : 'gradient-mix';
        const safeGlow = safeColor === 'eraser' ? false : Boolean(data.glow);
        
        // Validate glowColor (accepts standard hex codes or letters, defaults to cyan fallback)
        const validGlowColorRegex = /^(#[0-9A-Fa-f]{3,8}|[a-zA-Z]+)$/;
        const safeGlowColor = validGlowColorRegex.test(data.glowColor) ? data.glowColor : '#00ffff';

        const cleanData = { lines: data.lines, color: safeColor, glow: safeGlow, glowColor: safeGlowColor };

        // Server-Side Rate Limiter & Batching (Reduces Spam/Payload)
        if (!socket.drawQueue) socket.drawQueue = [];
        socket.drawQueue.push(cleanData);

        if (socket.drawThrottle) return; // Already throttling, wait for tick

        socket.drawThrottle = setTimeout(async () => {
            socket.drawThrottle = null;
            const batchedDraws = socket.drawQueue;
            socket.drawQueue = [];

            const room = await getRoom(currentRoom);
            if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
                let totalNormalStrokeLength = 0;
                let totalEraserStrokeLength = 0;
                const validDrawObjects = [];

                // Group batched lines by their characteristics to optimize Redis and networking
                const groupedDraws = {};
                for (const draw of batchedDraws) {
                    const key = `${draw.color}_${draw.glow}_${draw.glowColor}`;
                    if (!groupedDraws[key]) {
                        groupedDraws[key] = { lines: [], color: draw.color, glow: draw.glow, glowColor: draw.glowColor };
                    }
                    groupedDraws[key].lines.push(...draw.lines);
                    
                    const strokeLen = calculateStrokeLength(draw.lines);
                    if (draw.color === 'eraser') {
                        totalEraserStrokeLength += strokeLen;
                    } else {
                        totalNormalStrokeLength += strokeLen;
                    }
                }

                // Push unified drawing blocks
                for (const key in groupedDraws) {
                    const drawObj = groupedDraws[key];
                    validDrawObjects.push(drawObj);
                    await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawObj));
                }

                if (validDrawObjects.length > 0) {
                    await redis.del(`room:${currentRoom}:redo`);

                    // Manage Maximum Stack Limit (3)
                    room.redo_available = 0;
                    room.undo_available = Math.min(3, (room.undo_available || 0) + validDrawObjects.length);

                    const member = room.members.find(m => m.user_id === currentUser);
                    if (member) {
                        member.ink_used = member.ink_used || {};
                        const currentUsed = member.ink_used['total'] || member.ink_used['black'] || 0;
                        
                        // Strict Eraser Ink Refund Logic
                        const newTotal = Math.max(0, currentUsed + totalNormalStrokeLength - totalEraserStrokeLength);
                        member.ink_used['total'] = newTotal;
                        
                        await saveRoom(room);
                        io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                    }

                    // Broadcast all batched objects to subscribers
                    validDrawObjects.forEach(drawObj => {
                        socket.to(`room_${currentRoom}`).emit('live_draw', drawObj);
                    });
                    
                    io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_available, redo_steps: 0 });
                }
            }
        }, 150); // 150ms throttle delay to receive chunks and process
    });

    socket.on('clear_all', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
            await redis.del(`room:${currentRoom}:drawings`);
            await redis.del(`room:${currentRoom}:redo`);
            
            room.undo_available = 0;
            room.redo_available = 0;

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
            
            if ((room.undo_available || 0) <= 0) return; // Prevent exceeding stack limit of 3

            const lastDrawStr = await redis.rpop(`room:${currentRoom}:drawings`);
            if (lastDrawStr) {
                await redis.lpush(`room:${currentRoom}:redo`, lastDrawStr);
                
                room.undo_available -= 1;
                room.redo_available = Math.min(3, (room.redo_available || 0) + 1);

                const lastDraw = JSON.parse(lastDrawStr);
                const strokeLength = calculateStrokeLength(lastDraw.lines);

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    const currentUsed = member.ink_used['total'] || member.ink_used['black'] || 0;
                    
                    let newTotal;
                    if (lastDraw.color === 'eraser') {
                        newTotal = currentUsed + strokeLength; // Undoing an erase means adding ink usage back
                    } else {
                        newTotal = Math.max(0, currentUsed - strokeLength); // Undoing a draw means refunding ink usage
                    }
                    
                    member.ink_used['total'] = newTotal;
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                }

                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_available, redo_steps: room.redo_available });
            }
        }
    });

    socket.on('redo', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
            
            if ((room.redo_available || 0) <= 0) return; // Prevent exceeding stack limit of 3

            const nextDrawStr = await redis.lpop(`room:${currentRoom}:redo`);
            if (nextDrawStr) {
                await redis.rpush(`room:${currentRoom}:drawings`, nextDrawStr);
                
                room.redo_available -= 1;
                room.undo_available = Math.min(3, (room.undo_available || 0) + 1);

                const nextDraw = JSON.parse(nextDrawStr);
                const strokeLength = calculateStrokeLength(nextDraw.lines);

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    const currentUsed = member.ink_used['total'] || member.ink_used['black'] || 0;
                    
                    let newTotal;
                    if (nextDraw.color === 'eraser') {
                        newTotal = Math.max(0, currentUsed - strokeLength); // Redoing an erase means refunding ink
                    } else {
                        newTotal = currentUsed + strokeLength; // Redoing a draw means adding ink usage
                    }

                    member.ink_used['total'] = newTotal;
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                }

                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: room.undo_available, redo_steps: room.redo_available });
            }
        }
    });
};