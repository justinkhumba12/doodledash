const { db, redis } = require('./database');
const { getWeekKey, sendMsg, toHex } = require('./utils');
const { getRoom, saveRoom, checkRoomReset, syncRoom, broadcastRooms, deleteRoomData } = require('./roomManager');

module.exports = (io) => {
    let isGameLoopRunning = false;

    setInterval(async () => {
        const lock = await redis.set('game_loop_lock', '1', 'EX', 9, 'NX');
        if (!lock) return; 

        if (isGameLoopRunning) return;
        isGameLoopRunning = true;

        try {
            const now = Date.now();

            const currentWeekKey = getWeekKey();
            const storedWeekKey = await redis.get('current_week_key');
            if (storedWeekKey && storedWeekKey !== currentWeekKey) {
                const [top5Inviters] = await db.query(`
                    SELECT tg_id, invites FROM user_weekly_stats 
                    WHERE week_key = ? AND invites > 0 
                    ORDER BY invites DESC, invites_updated_at ASC LIMIT 5
                `, [storedWeekKey]);
                
                const [top5Guessers] = await db.query(`
                    SELECT tg_id, guesses FROM user_weekly_stats 
                    WHERE week_key = ? AND guesses > 0 
                    ORDER BY guesses DESC, guesses_updated_at ASC LIMIT 5
                `, [storedWeekKey]);
                
                await redis.set('previous_week_top_inviters', JSON.stringify(top5Inviters), 'EX', 7 * 86400); 
                await redis.set('previous_week_top_guessers', JSON.stringify(top5Guessers), 'EX', 7 * 86400);

                await db.query(`DELETE FROM user_weekly_stats WHERE week_key != ?`, [currentWeekKey]);

                for (const u of top5Inviters) {
                    const uId = u.tg_id;
                    const invites = u.invites;
                    if (invites > 0) {
                        sendMsg(uId, `🏆 The weekly invite challenge ended!\nYou ranked in the top 5 with ${invites} invites.\n\nClaim your reward of ${invites} credits!`, {
                            inline_keyboard: [[{ text: `🎁 Claim ${invites} Credits`, callback_data: `claim_weekly_${storedWeekKey}_${invites}` }]]
                        });
                    }
                }
                await redis.set('current_week_key', currentWeekKey);
            } else if (!storedWeekKey) {
                await redis.set('current_week_key', currentWeekKey);
            }

            const disconnects = await redis.hgetall('user_disconnects');
            for (const [userId, disconnectTimeStr] of Object.entries(disconnects)) {
                if (now - parseInt(disconnectTimeStr) >= 30000) {
                    
                    const activeRooms = await redis.smembers('active_rooms');
                    for (const roomId of activeRooms) {
                        const room = await getRoom(roomId);
                        if (room && room.members.some(m => String(m.user_id) === userId)) {
                            if (room.current_drawer_id === userId && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                                room.members.forEach(m => { m.is_ready = 0; });
                                
                                const cId = await redis.incr('global_chat_id');
                                const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer disconnected.', created_at: new Date() };
                                await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                                await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                            }
                            room.members = room.members.filter(m => m.user_id !== userId);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            await syncRoom(roomId, io);
                        }
                    }
                    await redis.hdel('user_disconnects', userId);
                    await broadcastRooms(io);
                }
            }
            
            const activeRooms = await redis.smembers('active_rooms');
            let roomsChanged = false;

            for (const roomId of activeRooms) {
                const room = await getRoom(roomId);
                if (!room) continue;

                let needsSync = false;

                if (room.status === 'PRE_DRAW' && room.round_end_time && now >= room.round_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.end_reason = 'timeout_predraw';
                    room.break_end_time = new Date(now + 5000); 
                    room.word_to_draw = null;
                    room.round_end_time = null;
                    room.members.forEach(m => { m.is_ready = 0; });
                    
                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: roomId, user_id: 'System', message: 'Drawer failed to choose a word in time. Turn skipped.', created_at: new Date() };
                    await redis.rpush(`room:${roomId}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${roomId}:chats`, -30, -1);
                    needsSync = true;
                }

                if (room.status === 'DRAWING' && room.round_end_time && now >= room.round_end_time.getTime()) {
                    room.status = 'REVEAL';
                    room.end_reason = 'nobody_guessed';
                    room.break_end_time = new Date(now + 5000); 
                    room.round_end_time = null;
                    room.members.forEach(m => { m.is_ready = 0; });
                    needsSync = true;
                }

                if (room.status === 'REVEAL' && room.break_end_time && now >= room.break_end_time.getTime()) {
                    room.status = 'BREAK';
                    room.break_end_time = new Date(now + 10000); 
                    room.members.forEach(m => m.has_given_up = 0);
                    needsSync = true;
                }

                if (room.status === 'BREAK' && room.break_end_time && now >= room.break_end_time.getTime()) {
                    room.status = 'WAITING';
                    room.break_end_time = null;
                    room.round_end_time = null;
                    room.members.forEach(m => { m.is_ready = 0; m.has_given_up = 0; });
                    needsSync = true;
                }

                if (room.is_private && room.expire_at && now >= room.expire_at.getTime()) {
                    io.to(`room_${roomId}`).emit('room_expired');
                    await deleteRoomData(roomId);
                    
                    const roomSockets = await io.in(`room_${roomId}`).fetchSockets();
                    for (const s of roomSockets) {
                        s.leave(`room_${roomId}`);
                        s.join('lobby');
                        s.data.currentRoom = null;
                    }
                    roomsChanged = true;
                    continue; 
                }

                if (needsSync) {
                    await saveRoom(room);
                    await syncRoom(roomId, io);
                }
            }

            if (roomsChanged) {
                await broadcastRooms(io);
            }
            
            const sockets = await io.fetchSockets();
            let idleChangedRooms = new Set();

            for (const s of sockets) {
                const idleTime = now - (s.data.lastActiveEvent || now);
                
                if (s.data.currentRoom) {
                    if (idleTime > 60000) {
                        s.emit('kick_idle');
                        const roomId = s.data.currentRoom;
                        const room = await getRoom(roomId);

                        if (room) {
                            if (room.current_drawer_id === s.data.currentUser && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
                                room.status = 'BREAK';
                                room.end_reason = 'drawer_disconnected';
                                room.break_end_time = new Date(now + 5000); 
                                room.word_to_draw = null;
                                room.round_end_time = null;
                                room.members.forEach(m => { m.is_ready = 0; });
                            }

                            room.members = room.members.filter(m => m.user_id !== s.data.currentUser);
                            await saveRoom(room);
                            await checkRoomReset(roomId);
                            idleChangedRooms.add(roomId);
                        }
                        s.leave(`room_${roomId}`);
                        s.join('lobby'); 
                        s.data.currentRoom = null;
                        s.data.idleWarned = false;
                    } else if (idleTime > 30000 && !s.data.idleWarned) {
                        s.data.idleWarned = true;
                        s.emit('idle_warning', { timeLeft: Math.ceil((60000 - idleTime) / 1000) });
                    } else if (idleTime <= 30000) {
                        s.data.idleWarned = false;
                    }
                } else {
                    if (idleTime > 60000) {
                        s.emit('disconnect_idle');
                        s.disconnect(true);
                    }
                }
            }

            for (const roomId of idleChangedRooms) {
                await syncRoom(roomId, io);
            }
            if (idleChangedRooms.size > 0) {
                await broadcastRooms(io);
            }

        } catch (e) { 
            console.error(`[Worker ${process.pid}] Game Loop Error:`, e); 
        } finally {
            isGameLoopRunning = false;
        }
    }, 10000);
};
