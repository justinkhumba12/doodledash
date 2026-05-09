const { db, redis } = require('../database');
const { getRoom, saveRoom, syncRoom, broadcastRooms } = require('../roomManager');
const { getUserState } = require('../userManager');
const { getWeekKey } = require('../utils');

module.exports = (io, socket, shared) => {
    const { queuedAction } = shared;

    socket.on('set_ready', async () => {
        queuedAction(async () => {
            const roomId = socket.data.currentRoom;
            const userId = socket.data.currentUser;
            if (!roomId || !userId) return;
            const room = await getRoom(roomId);
            if (!room) return;

            const member = room.members.find(m => m.user_id === userId);
            if (member) {
                member.is_ready = 1;
                const readyCount = room.members.filter(m => m.is_ready).length;
                const allReady = room.members.length >= 2 && readyCount === room.members.length;

                if (allReady && (room.status === 'WAITING' || room.status === 'BREAK' || room.status === 'REVEAL')) {
                    room.status = 'PRE_DRAW';
                    room.round = (room.round || 0) + 1;
                    
                    const currentIndex = room.members.findIndex(m => m.user_id === room.current_drawer_id);
                    const nextIndex = currentIndex >= 0 && currentIndex + 1 < room.members.length ? currentIndex + 1 : 0;
                    room.current_drawer_id = room.members[nextIndex].user_id;

                    room.round_end_time = new Date(Date.now() + 30000); 
                    room.break_end_time = null;
                    room.word_to_draw = null;
                    room.base_hints = '[]';
                    room.masked_word = null;
                    room.end_reason = null;
                    room.last_winner_id = null;
                    room.winner_style = null;
                    room.round_leaderboard = null;
                    room.correct_word = null;
                    
                    room.members.forEach(m => { 
                        m.purchased_hints = '[]';
                        m.purchased_guesses = 0;
                        m.ink_extra = {};
                        m.ink_buys = {};
                        m.ink_used = {};
                    });
                    await redis.del(`room:${roomId}:drawings`, `room:${roomId}:redo`, `room:${roomId}:guesses`, `room:${roomId}:round_scores`);
                }
                await saveRoom(room);
                await syncRoom(roomId, io);
                await broadcastRooms(io);
            }
        });
    });

    socket.on('set_word', async ({ word }) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom || !word) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'PRE_DRAW' && room.current_drawer_id === currentUser) {
            const actualWord = word.toUpperCase();
            room.word_to_draw = actualWord;
            room.status = 'DRAWING';
            room.round_end_time = new Date(Date.now() + 90000); 

            const lettersOnly = actualWord.replace(/ /g, '');
            const len = lettersOnly.length;
            let hintCount = 0;
            
            if (len >= 3 && len <= 4) hintCount = 1;
            else if (len >= 5 && len <= 6) hintCount = 2;
            else if (len >= 7 && len <= 8) hintCount = 3;
            else if (len >= 9 && len <= 10) hintCount = 4;
            else if (len >= 11 && len <= 12) hintCount = 5;
            else if (len >= 13 && len <= 16) hintCount = 6;

            const nonSpaceIndices = [];
            for (let i = 0; i < actualWord.length; i++) {
                if (actualWord[i] !== ' ') nonSpaceIndices.push(i);
            }

            for (let i = nonSpaceIndices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [nonSpaceIndices[i], nonSpaceIndices[j]] = [nonSpaceIndices[j], nonSpaceIndices[i]];
            }
            
            const selectedHints = nonSpaceIndices.slice(0, hintCount);
            room.base_hints = JSON.stringify(selectedHints);

            room.masked_word = actualWord.split('').map((c, i) => ({
                char: c,
                revealed: c === ' ' || selectedHints.includes(i),
                index: i
            }));
            
            await redis.del(`room:${currentRoom}:drawings`, `room:${currentRoom}:redo`, `room:${currentRoom}:guesses`);
            await saveRoom(room);
            await syncRoom(currentRoom, io);
        }
    });

    socket.on('guess', async (data) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom || !data.guess) return;

        const room = await getRoom(currentRoom);
        if (!room || room.status !== 'DRAWING' || room.current_drawer_id === currentUser) return;

        const member = room.members.find(m => m.user_id === currentUser);
        if (!member) return;

        const rawGuesses = await redis.lrange(`room:${currentRoom}:guesses`, 0, -1);
        const guesses = rawGuesses.map(g => JSON.parse(g));
        const myGuesses = guesses.filter(g => g.user_id === currentUser);

        if (myGuesses.some(g => g.is_correct)) {
            return socket.emit('create_error', 'You have already guessed the word correctly!');
        }

        const allowedGuesses = 4 + (member.purchased_guesses || 0);
        if (myGuesses.length >= allowedGuesses) return socket.emit('create_error', 'Out of guesses. Please buy more.');

        const isCorrect = data.guess.toUpperCase() === room.word_to_draw;
        
        const [uRows] = await db.query('SELECT equipped_style FROM users WHERE tg_id = ?', [currentUser]);
        const equippedStyle = uRows.length ? uRows[0].equipped_style : null;

        const guessObj = {
            id: Date.now(),
            user_id: currentUser,
            guess_text: data.guess.toUpperCase(),
            is_correct: isCorrect,
            equipped_style: equippedStyle
        };

        await redis.rpush(`room:${currentRoom}:guesses`, JSON.stringify(guessObj));
        
        const roomSockets = await io.in(`room_${currentRoom}`).fetchSockets();
        for (const s of roomSockets) {
            const sid = s.data.currentUser;
            const isDrawer = room.current_drawer_id === sid;
            const isSender = currentUser === sid;
            const emitGuess = { ...guessObj };
            
            if (!isDrawer && !isSender && room.status === 'DRAWING') {
                emitGuess.guess_text = '••••••••';
            }
            s.emit('new_guess', emitGuess);
        }

        if (isCorrect) {
            const cId = await redis.incr('global_chat_id');
            const sysChat = { 
                id: cId, 
                room_id: currentRoom, 
                user_id: currentUser, 
                message: 'has guessed the word!', 
                is_system: true, 
                action_type: 'correct_guess',
                created_at: new Date(),
                equipped_style: equippedStyle
            };
            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
            await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
            io.to(`room_${currentRoom}`).emit('new_chat', sysChat);

            if (!room.last_winner_id) {
                room.last_winner_id = currentUser;
                room.winner_style = equippedStyle;
            }

            // Calculate dynamic points based on remaining time
            const timeLeftMs = room.round_end_time ? Math.max(0, new Date(room.round_end_time).getTime() - Date.now()) : 0;
            const pointsEarned = Math.max(1, Math.ceil(timeLeftMs / 10000));
            const drawerPoints = 1;

            await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [pointsEarned, currentUser]);
            await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [drawerPoints, room.current_drawer_id]);
            await redis.hincrbyfloat('user_credits', currentUser, pointsEarned);
            await redis.hincrbyfloat('user_credits', room.current_drawer_id, drawerPoints);
            
            // Save individual round scores
            await redis.hincrby(`room:${currentRoom}:round_scores`, currentUser, pointsEarned);
            await redis.hincrby(`room:${currentRoom}:round_scores`, room.current_drawer_id, drawerPoints);
            
            await db.query(`UPDATE users SET daily_correct_guesses = IF(DATE_FORMAT(last_correct_guess_date, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d'), daily_correct_guesses + 1, 1), last_correct_guess_date = UTC_DATE() WHERE tg_id = ?`, [currentUser]);

            const weekKey = getWeekKey();
            await db.query(`INSERT INTO user_weekly_stats (tg_id, week_key, guesses, guesses_updated_at) VALUES (?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE guesses = guesses + 1, guesses_updated_at = NOW()`, [currentUser, weekKey]);

            const correctGuessers = new Set(guesses.filter(g => g.is_correct).map(g => g.user_id));
            correctGuessers.add(currentUser);
            const nonDrawers = room.members.filter(m => m.user_id !== room.current_drawer_id);

            // Strictly requiring total correct guessers to equal non-drawing members
            if (correctGuessers.size === nonDrawers.length) {
                room.status = 'REVEAL';
                room.end_reason = 'all_guessed';
                room.break_end_time = new Date(Date.now() + 5000);
                room.members.forEach(m => { m.is_ready = 0; });

                const scores = await redis.hgetall(`room:${currentRoom}:round_scores`);
                room.round_leaderboard = Object.keys(scores).map(uid => ({
                    user_id: uid,
                    points: parseInt(scores[uid], 10)
                })).sort((a, b) => b.points - a.points);
                room.correct_word = room.word_to_draw;
            }

            await saveRoom(room);
            await syncRoom(currentRoom, io);
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        }
    });

    socket.on('buy_ink', async (data) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
            const inkConfigRaw = await redis.get('config_ink');
            const inkConfig = inkConfigRaw ? JSON.parse(inkConfigRaw) : { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 };
            
            const member = room.members.find(m => m.user_id === currentUser);
            if (!member) return;
            
            const inkColor = data?.color || 'black';
            
            member.ink_buys = member.ink_buys || {};
            const buysMade = member.ink_buys[inkColor] || 0;
            
            if (buysMade >= inkConfig.max_buys) {
                return socket.emit('create_error', 'Maximum ink refills reached for this round.');
            }

            const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
            if (userRows.length && userRows[0].credits >= inkConfig.cost) {
                await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [inkConfig.cost, currentUser]);
                await redis.hincrbyfloat('user_credits', currentUser, -inkConfig.cost);
                
                member.ink_extra = member.ink_extra || {};
                member.ink_used = member.ink_used || {};
                
                const baseFreeInk = inkConfig.free;
                const currentInkExtra = member.ink_extra[inkColor] || 0;
                const currentInkUsed = member.ink_used[inkColor] || 0;
                const newlyPurchasedInk = inkConfig.extra;

                const currentRemaining = Math.max(0, baseFreeInk + currentInkExtra - currentInkUsed);
                const newRemaining = currentRemaining + newlyPurchasedInk;
                const newTotalCapacity = newRemaining + currentInkUsed;
                
                member.ink_extra[inkColor] = newTotalCapacity - baseFreeInk;
                member.ink_buys[inkColor] = buysMade + 1;

                await saveRoom(room);
                
                await syncRoom(currentRoom, io);
                
                io.to(`room_${currentRoom}`).emit('update_ink_capacity', { user_id: currentUser, extra: member.ink_extra });
                
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
                
                socket.emit('reward_success', 'Ink refilled successfully!');
            } else {
                socket.emit('create_error', 'Not enough credits to buy ink.');
            }
        }
    });

    socket.on('buy_hint_credit', async ({ index }) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id !== currentUser) {
            const actualWord = room.word_to_draw || '';
            if (index < 0 || index >= actualWord.length || actualWord[index] === ' ') return;

            const member = room.members.find(m => m.user_id === currentUser);
            if (!member) return;

            const purchased_hints = JSON.parse(member.purchased_hints || '[]');
            const base_hints = JSON.parse(room.base_hints || '[]');

            if (!purchased_hints.includes(index) && !base_hints.includes(index)) {
                const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
                if (userRows.length && userRows[0].credits >= 1) {
                    await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
                    await redis.hincrbyfloat('user_credits', currentUser, -1);
                    
                    purchased_hints.push(index);
                    member.purchased_hints = JSON.stringify(purchased_hints);

                    const cId = await redis.incr('global_chat_id');
                    const sysChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: 'used a hint.', is_system: true, action_type: 'hint', created_at: new Date() };
                    await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                    await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
                    io.to(`room_${currentRoom}`).emit('new_chat', sysChat);
                    
                    await saveRoom(room);
                    await syncRoom(currentRoom, io);
                    
                    const userState = await getUserState(currentUser);
                    if (userState) socket.emit('user_update', userState);
                } else {
                    socket.emit('create_error', 'Not enough credits.');
                }
            }
        }
    });

    socket.on('buy_hint_ad', async ({ index }) => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id !== currentUser) {
            const actualWord = room.word_to_draw || '';
            if (index < 0 || index >= actualWord.length || actualWord[index] === ' ') return;

            const member = room.members.find(m => m.user_id === currentUser);
            if (!member) return;

            const purchased_hints = JSON.parse(member.purchased_hints || '[]');
            const base_hints = JSON.parse(room.base_hints || '[]');

            if (!purchased_hints.includes(index) && !base_hints.includes(index)) {
                purchased_hints.push(index);
                member.purchased_hints = JSON.stringify(purchased_hints);

                const cId = await redis.incr('global_chat_id');
                const sysChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: 'used a hint.', is_system: true, action_type: 'hint', created_at: new Date() };
                await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
                await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
                io.to(`room_${currentRoom}`).emit('new_chat', sysChat);
                
                await saveRoom(room);
                await syncRoom(currentRoom, io);
            }
        }
    });

    socket.on('buy_guesses', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;
        
        const room = await getRoom(currentRoom);
        if (!room || room.status !== 'DRAWING' || room.current_drawer_id === currentUser) return;

        const member = room.members.find(m => m.user_id === currentUser);
        if (!member) return;

        const [userRows] = await db.query('SELECT credits FROM users WHERE tg_id = ?', [currentUser]);
        if (userRows.length && userRows[0].credits >= 1) {
            await db.query('UPDATE users SET credits = credits - 1 WHERE tg_id = ?', [currentUser]);
            await redis.hincrbyfloat('user_credits', currentUser, -1);
            
            member.purchased_guesses = (member.purchased_guesses || 0) + 2;
            
            await saveRoom(room);
            await syncRoom(currentRoom, io);
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
            
            socket.emit('reward_success', 'Extra guesses unlocked!');
        } else {
            socket.emit('create_error', 'Not enough credits.');
        }
    });

    socket.on('drawer_give_up', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (!currentUser || !currentRoom) return;

        const room = await getRoom(currentRoom);
        if (room && room.status === 'DRAWING' && room.current_drawer_id === currentUser) {
            const cId = await redis.incr('global_chat_id');
            const sysChat = { id: cId, room_id: currentRoom, user_id: currentUser, message: 'gave up their turn.', is_system: true, action_type: 'give_up', created_at: new Date() };
            await redis.rpush(`room:${currentRoom}:chats`, JSON.stringify(sysChat));
            await redis.ltrim(`room:${currentRoom}:chats`, -50, -1);
            io.to(`room_${currentRoom}`).emit('new_chat', sysChat);

            room.status = 'REVEAL';
            room.end_reason = 'drawer_gave_up';
            room.break_end_time = new Date(Date.now() + 5000);
            room.members.forEach(m => { m.is_ready = 0; });
            
            const scores = await redis.hgetall(`room:${currentRoom}:round_scores`);
            room.round_leaderboard = Object.keys(scores).map(uid => ({
                user_id: uid,
                points: parseInt(scores[uid], 10)
            })).sort((a, b) => b.points - a.points);
            room.correct_word = room.word_to_draw;

            await saveRoom(room);
            await syncRoom(currentRoom, io);
        }
    });
};