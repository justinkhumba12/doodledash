const { redis } = require('../database');
const { getRoom, saveRoom } = require('../roomManager');

module.exports = (io, socket, shared) => {
    const { calculateStrokeLength } = shared;
    // Magic-mix and eraser added to ALLOWED_COLORS validator
    const ALLOWED_COLORS = ['black', 'red', 'green', 'magic-mix', 'eraser'];

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
        const safeColor = ALLOWED_COLORS.includes(data.color) ? data.color : 'black';
        const safeGlow = Boolean(data.glow);
        
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
                let inkChange = 0;
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
                    // Server-side Ink calculations: Refund ink if erasing, deduct if drawing
                    if (draw.color === 'eraser') {
                        inkChange -= strokeLen;
                    } else {
                        inkChange += strokeLen;
                    }
                }

                // Push unified drawing blocks
                for (const key in groupedDraws) {
                    const drawObj = groupedDraws[key];
                    validDrawObjects.push(drawObj);
                    await redis.rpush(`room:${currentRoom}:drawings`, JSON.stringify(drawObj));
                }

                if (validDrawObjects.length > 0) {
                    // Maximum of 3 actions tracker for undo/redo limit
                    await redis.incr(`room:${currentRoom}:undo_count`);
                    let currentUndoCount = parseInt(await redis.get(`room:${currentRoom}:undo_count`) || '0');
                    if (currentUndoCount > 3) {
                        currentUndoCount = 3;
                        await redis.set(`room:${currentRoom}:undo_count`, 3);
                    }

                    // Drawing clears redo history naturally
                    await redis.del(`room:${currentRoom}:redo`);

                    const member = room.members.find(m => m.user_id === currentUser);
                    if (member) {
                        member.ink_used = member.ink_used || {};
                        const newTotal = Math.max(0, (member.ink_used['total'] || member.ink_used['black'] || 0) + inkChange);
                        member.ink_used['total'] = newTotal;
                        
                        await saveRoom(room);
                        io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                    }

                    // Broadcast all batched objects to subscribers
                    validDrawObjects.forEach(drawObj => {
                        socket.to(`room_${currentRoom}`).emit('live_draw', drawObj);
                    });
                    
                    io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: currentUndoCount, redo_steps: 0 });
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
            await redis.del(`room:${currentRoom}:undo_count`);
            
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
        const currentUndoCount = parseInt(await redis.get(`room:${currentRoom}:undo_count`) || '0');
        
        // Capped to a maximum of 3 historical undo limits
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser && currentUndoCount > 0) {
            const lastDrawStr = await redis.rpop(`room:${currentRoom}:drawings`);
            if (lastDrawStr) {
                await redis.lpush(`room:${currentRoom}:redo`, lastDrawStr);
                await redis.decr(`room:${currentRoom}:undo_count`);
                
                const lastDraw = JSON.parse(lastDrawStr);
                const strokeLength = calculateStrokeLength(lastDraw.lines);

                // Reversing an eraser restores the ink; reversing a draw refunds ink.
                let inkChange = lastDraw.color === 'eraser' ? strokeLength : -strokeLength;

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    const newTotal = Math.max(0, (member.ink_used['total'] || member.ink_used['black'] || 0) + inkChange);
                    member.ink_used['total'] = newTotal;
                    
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                }

                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                const newUndoCount = parseInt(await redis.get(`room:${currentRoom}:undo_count`) || '0');
                const redoLen = await redis.llen(`room:${currentRoom}:redo`);
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: newUndoCount, redo_steps: redoLen });
            }
        }
    });

    socket.on('redo', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        const redoLenCheck = await redis.llen(`room:${currentRoom}:redo`);
        
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser && redoLenCheck > 0) {
            const nextDrawStr = await redis.lpop(`room:${currentRoom}:redo`);
            if (nextDrawStr) {
                await redis.rpush(`room:${currentRoom}:drawings`, nextDrawStr);
                await redis.incr(`room:${currentRoom}:undo_count`);
                
                const nextDraw = JSON.parse(nextDrawStr);
                const strokeLength = calculateStrokeLength(nextDraw.lines);

                // Redoing an eraser deducts the ink; redoing a draw adds ink.
                let inkChange = nextDraw.color === 'eraser' ? -strokeLength : strokeLength;

                const member = room.members.find(m => m.user_id === currentUser);
                if (member) {
                    member.ink_used = member.ink_used || {};
                    const newTotal = Math.max(0, (member.ink_used['total'] || member.ink_used['black'] || 0) + inkChange);
                    member.ink_used['total'] = newTotal;
                    
                    await saveRoom(room);
                    io.to(`room_${currentRoom}`).emit('update_ink', { used: newTotal });
                }

                const rawDrawings = await redis.lrange(`room:${currentRoom}:drawings`, 0, -1);
                const drawings = rawDrawings.map(d => JSON.parse(d));
                io.to(`room_${currentRoom}`).emit('sync_initial_drawings', drawings);

                const newUndoCount = parseInt(await redis.get(`room:${currentRoom}:undo_count`) || '0');
                const redoLen = await redis.llen(`room:${currentRoom}:redo`);
                io.to(`room_${currentRoom}`).emit('update_undo_redo', { undo_steps: newUndoCount, redo_steps: redoLen });
            }
        }
    });
};