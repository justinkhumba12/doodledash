const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ==========================================
// IN-MEMORY DATABASE (TABLES)
// ==========================================
const db = {
    users: {}, // tg_id -> { tg_id, credits, last_daily_claim, ad_claims_today, last_ad_claim_time, last_ad_claim_date, ... }
    rooms: {}, // room_id -> { id, status, current_drawer_id, word_to_draw, round_end_time, break_end_time, last_winner_id, next_drawer_id }
    room_members: [], // [{ room_id, user_id, is_ready, consecutive_turns, total_turns }]
    drawings: [], // [{ id, room_id, line_data }]
    chat_messages: [], // [{ id, room_id, user_id, message, created_at }]
    guesses: [], // [{ id, room_id, user_id, guess_text, created_at }]
    calls: {}, // call_id -> { id, room_id, caller_id, receiver_id, status, started_at, last_billed_at }
    webrtc_signals: [] // [{ call_id, sender_id, receiver_id, type, payload }]
};

let drawingIdCounter = 1;
let chatMsgIdCounter = 1;
let guessIdCounter = 1;
let callIdCounter = 1;

// Helper to format Date matching PHP logic
function getNowStr() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function getTodayStr() {
    return new Date().toISOString().split('T')[0];
}

const gameWords = ["Apple", "Banana", "Car", "Dog", "House", "Sun", "Tree", "Computer", "Phone", "Pizza", "Ocean", "Mountain", "River", "Bird", "Cat", "Fish", "Elephant", "Tiger", "Lion", "Bear", "Guitar", "Rocket", "Robot", "Brain", "Castle"];

// ==========================================
// GAME ENGINE LOOP (Runs every 1s)
// ==========================================
setInterval(() => {
    const now = new Date();
    
    Object.values(db.rooms).forEach(room => {
        const roomId = room.id;
        const members = db.room_members.filter(rm => rm.room_id === roomId);
        const membersCount = members.length;

        // 1. Handle Not Enough Players
        if (membersCount < 2 && room.status !== 'WAITING') {
            room.status = 'WAITING';
            room.current_drawer_id = null;
            room.word_to_draw = null;
            db.room_members.forEach(rm => { if(rm.room_id === roomId) rm.is_ready = 0; });
            broadcastSync(roomId);
            return;
        }

        // 2. WAITING -> PRE_DRAW (If all ready)
        if (room.status === 'WAITING' && membersCount >= 2) {
            const allReady = members.every(m => m.is_ready === 1);
            if (allReady) {
                const nextDrawer = members.sort((a,b) => a.total_turns - b.total_turns || Math.random() - 0.5)[0].user_id;
                db.room_members.forEach(rm => { 
                    if(rm.room_id === roomId) {
                        rm.is_ready = 0;
                        if(rm.user_id === nextDrawer) {
                            rm.consecutive_turns = 1;
                            rm.total_turns += 1;
                        }
                    }
                });
                room.status = 'PRE_DRAW';
                room.current_drawer_id = nextDrawer;
                room.word_to_draw = null;
                db.guesses = db.guesses.filter(g => g.room_id !== roomId);
                broadcastSync(roomId);
            }
        }

        // 3. DRAWING Timer Ends
        if (room.status === 'DRAWING') {
            const end = new Date(room.round_end_time);
            if (now >= end) {
                endRound(roomId, room);
                broadcastSync(roomId);
            }
        }

        // 4. REVEAL Timer Ends
        if (room.status === 'REVEAL') {
            const end = new Date(room.break_end_time);
            if (now >= end) {
                room.status = 'BREAK';
                const nextBreak = new Date(now.getTime() + 600000); // 10 mins Break wait
                room.break_end_time = nextBreak.toISOString().replace('T', ' ').substring(0, 19);
                broadcastSync(roomId);
            }
        }

        // 5. BREAK/REVEAL -> PRE_DRAW (If all ready)
        if ((room.status === 'BREAK' || room.status === 'REVEAL') && membersCount >= 2) {
            const allReady = members.every(m => m.is_ready === 1);
            if (allReady) {
                const nextDrawer = room.next_drawer_id || room.current_drawer_id;
                db.room_members.forEach(rm => { 
                    if(rm.room_id === roomId) {
                        rm.is_ready = 0;
                        if(rm.user_id === nextDrawer) rm.total_turns += 1;
                    }
                });
                room.status = 'PRE_DRAW';
                room.current_drawer_id = nextDrawer;
                room.word_to_draw = null;
                room.last_winner_id = null;
                room.next_drawer_id = null;
                db.guesses = db.guesses.filter(g => g.room_id !== roomId);
                broadcastSync(roomId);
            }
        }

        // 6. CALL DAEMON: End active calls if over 2 mins and credits < 1
        Object.values(db.calls).filter(c => c.room_id === roomId && c.status === 'ACTIVE').forEach(call => {
            const caller = db.users[call.caller_id];
            const timeSinceBilled = (now.getTime() - new Date(call.last_billed_at).getTime()) / 1000;
            
            if (timeSinceBilled >= 120) {
                if (caller.credits < 1) {
                    call.status = 'ENDED';
                } else {
                    caller.credits -= 1;
                    call.last_billed_at = getNowStr();
                }
                broadcastSync(roomId); // Trigger update to show dropped call or credit change
            }
        });
    });
}, 1000);

function endRound(roomId, room, forceNextDrawer = null) {
    const correctGuess = db.guesses.find(g => g.room_id === roomId && g.guess_text.toLowerCase() === room.word_to_draw.toLowerCase());
    const winner = correctGuess ? correctGuess.user_id : null;
    
    let nextDrawer = forceNextDrawer;
    if (!nextDrawer) {
        if (winner) nextDrawer = winner;
        else {
            const members = db.room_members.filter(rm => rm.room_id === roomId);
            nextDrawer = members.sort((a,b) => a.total_turns - b.total_turns || Math.random() - 0.5)[0]?.user_id;
        }
    }

    let drawerMember = db.room_members.find(rm => rm.room_id === roomId && rm.user_id === room.current_drawer_id);
    let consecutive = drawerMember ? drawerMember.consecutive_turns : 0;
    
    if (nextDrawer === room.current_drawer_id) consecutive++;
    else consecutive = 1;

    let sysMsg = null;
    if (consecutive > 3) {
        const members = db.room_members.filter(rm => rm.room_id === roomId);
        nextDrawer = members.sort((a,b) => a.total_turns - b.total_turns || Math.random() - 0.5)[0]?.user_id;
        consecutive = 1;
        sysMsg = `✏️ Player ${room.current_drawer_id} reached max 3 consecutive turns! Changing drawer.`;
    }

    db.room_members.forEach(rm => {
        if(rm.room_id === roomId) {
            rm.is_ready = 0;
            if(rm.user_id === nextDrawer) rm.consecutive_turns = consecutive;
        }
    });

    if (sysMsg) {
        db.chat_messages.push({ id: chatMsgIdCounter++, room_id: roomId, user_id: 'System', message: sysMsg, created_at: getNowStr() });
    }

    room.status = 'REVEAL';
    room.last_winner_id = winner;
    room.next_drawer_id = nextDrawer;
    
    const breakEnd = new Date(new Date().getTime() + 5000); // 5 sec reveal
    room.break_end_time = breakEnd.toISOString().replace('T', ' ').substring(0, 19);
}

// ==========================================
// SOCKET.IO HANDLERS
// ==========================================
io.on('connection', (socket) => {
    
    socket.on('auth', (data) => {
        let tg_id = data.tg_id;
        if (!db.users[tg_id]) {
            // Auto register mock user
            db.users[tg_id] = {
                tg_id: tg_id, credits: 10, last_daily_claim: '', ad_claims_today: 0, 
                last_ad_claim_time: null, last_ad_claim_date: '', ad2_claims_today: 0,
                last_ad2_claim_time: null, last_ad2_claim_date: ''
            };
        }
        socket.tg_id = tg_id;
        socket.emit('auth_success', db.users[tg_id]);
        sendGlobalData(socket);
    });

    socket.on('disconnect', () => {
        if (socket.tg_id && socket.currentRoom) {
            // Disconnect logic handled by explicit leave or AFK on client side for now.
        }
    });

    socket.on('get_rooms', () => sendGlobalData(socket));

    // Economy
    socket.on('claim_daily', () => {
        const user = db.users[socket.tg_id];
        const today = getTodayStr();
        if (user.last_daily_claim === today) return socket.emit('alert', { type: 'error', message: 'Already claimed today!' });
        user.credits += 1;
        user.last_daily_claim = today;
        socket.emit('alert', { type: 'success', message: 'Claimed 1 Daily Credit!' });
        sendGlobalData(socket);
    });

    socket.on('claim_ad', (data) => {
        const type = data.type; // 'ad1' or 'ad2'
        const user = db.users[socket.tg_id];
        const today = getTodayStr();
        const now = getNowStr();
        
        const claimDateKey = type === 'ad2' ? 'last_ad2_claim_date' : 'last_ad_claim_date';
        const claimTimeKey = type === 'ad2' ? 'last_ad2_claim_time' : 'last_ad_claim_time';
        const claimsTodayKey = type === 'ad2' ? 'ad2_claims_today' : 'ad_claims_today';

        if (user[claimDateKey] !== today) user[claimsTodayKey] = 0;
        
        if (user[claimsTodayKey] >= 2) return socket.emit('alert', { type: 'error', message: 'Limit reached (Max 2/day)!' });
        
        if (user[claimsTodayKey] > 0 && user[claimTimeKey]) {
            const hoursSince = (new Date(now) - new Date(user[claimTimeKey])) / 3600000;
            if (hoursSince < 3) return socket.emit('alert', { type: 'error', message: 'Cooldown active! Wait 3 hours.' });
        }

        user.credits += 2;
        user[claimsTodayKey] += 1;
        user[claimDateKey] = today;
        user[claimTimeKey] = now;
        socket.emit('alert', { type: 'success', message: 'Claimed 2 Ad Credits!' });
        sendGlobalData(socket);
    });

    // Room Actions
    socket.on('create_room', () => {
        const user = db.users[socket.tg_id];
        if (Object.keys(db.rooms).length >= 10) return socket.emit('alert', { type: 'error', message: 'Max 10 rooms limit reached.' });
        if (user.credits < 1) return socket.emit('alert', { type: 'error', message: 'Creating a room costs 1 credit.' });
        
        user.credits -= 1;
        const newRoomId = Date.now();
        db.rooms[newRoomId] = { id: newRoomId, status: 'WAITING', current_drawer_id: null };
        socket.emit('room_created', { room_id: newRoomId });
        sendGlobalData(io); // Update all
    });

    socket.on('join_room', (data) => {
        const roomId = parseInt(data.room_id);
        const tg_id = socket.tg_id;
        if (!db.rooms[roomId]) return socket.emit('alert', { type: 'error', message: 'Room not found.' });

        const currentMembers = db.room_members.filter(rm => rm.room_id === roomId);
        const inRoom = currentMembers.find(rm => rm.user_id === tg_id);
        
        if (currentMembers.length >= 4 && !inRoom) return socket.emit('alert', { type: 'error', message: 'Room is full.' });

        // Remove from other rooms first
        db.room_members = db.room_members.filter(rm => rm.user_id !== tg_id);
        
        db.room_members.push({ room_id: roomId, user_id: tg_id, is_ready: 0, consecutive_turns: 0, total_turns: 0 });
        socket.join(roomId.toString());
        socket.currentRoom = roomId;
        
        socket.emit('join_success', { room_id: roomId });
        broadcastSync(roomId);
        sendGlobalData(io);
    });

    socket.on('leave_room', () => {
        if (!socket.currentRoom) return;
        const roomId = socket.currentRoom;
        
        db.room_members = db.room_members.filter(rm => rm.user_id !== socket.tg_id);
        
        // End calls
        Object.values(db.calls).forEach(c => {
            if (c.room_id === roomId && (c.caller_id === socket.tg_id || c.receiver_id === socket.tg_id)) {
                c.status = 'ENDED';
            }
        });

        // Handle drawer leaving
        const room = db.rooms[roomId];
        if (room && room.current_drawer_id === socket.tg_id && (room.status === 'PRE_DRAW' || room.status === 'DRAWING')) {
            room.status = 'WAITING';
            room.current_drawer_id = null;
            db.room_members.forEach(rm => { if(rm.room_id === roomId) rm.is_ready = 0; });
            db.chat_messages.push({ id: chatMsgIdCounter++, room_id: roomId, user_id: 'System', message: '⚠️ The drawer left the game! Resetting round.', created_at: getNowStr() });
            db.guesses = db.guesses.filter(g => g.room_id !== roomId);
        }

        socket.leave(roomId.toString());
        socket.currentRoom = null;
        broadcastSync(roomId);
        sendGlobalData(io);
    });

    socket.on('set_ready', (data) => {
        const rm = db.room_members.find(rm => rm.room_id === data.room_id && rm.user_id === socket.tg_id);
        if (rm) rm.is_ready = 1;
        broadcastSync(data.room_id);
    });

    socket.on('set_word', (data) => {
        const room = db.rooms[data.room_id];
        if (!room || room.current_drawer_id !== socket.tg_id) return;
        room.word_to_draw = data.word;
        room.status = 'DRAWING';
        
        const end = new Date(new Date().getTime() + 125000); // 120s + 5s prep
        room.round_end_time = end.toISOString().replace('T', ' ').substring(0, 19);
        
        db.drawings = db.drawings.filter(d => d.room_id !== room.id);
        db.guesses = db.guesses.filter(g => g.room_id !== room.id);
        broadcastSync(room.id);
    });

    socket.on('draw', (data) => {
        const room = db.rooms[data.room_id];
        if (!room || room.current_drawer_id !== socket.tg_id) return;
        db.drawings.push({ id: drawingIdCounter++, room_id: room.id, line_data: data.lines });
        
        // Fast broadcast to room for instant drawing
        socket.to(data.room_id.toString()).emit('draw_update', { lines: data.lines });
    });

    socket.on('undo_draw', (data) => {
        const room = db.rooms[data.room_id];
        if (!room || room.current_drawer_id !== socket.tg_id) return;
        
        const roomDrawings = db.drawings.filter(d => d.room_id === room.id);
        if (roomDrawings.length > 0) {
            const last = roomDrawings[roomDrawings.length - 1];
            db.drawings = db.drawings.filter(d => d.id !== last.id);
            socket.emit('undo_success', { line_data: last.line_data });
            broadcastSync(room.id);
        }
    });

    socket.on('chat', (data) => {
        db.chat_messages.push({ id: chatMsgIdCounter++, room_id: data.room_id, user_id: socket.tg_id, message: data.message, created_at: getNowStr() });
        broadcastSync(data.room_id);
    });

    socket.on('guess', (data) => {
        const room = db.rooms[data.room_id];
        if (!room) return;

        const myGuesses = db.guesses.filter(g => g.room_id === data.room_id && g.user_id === socket.tg_id);
        if (myGuesses.length >= 5) {
            const user = db.users[socket.tg_id];
            if (user.credits < 1) return socket.emit('alert', { type: 'error', message: 'Need 1 credit for extra guesses.' });
            user.credits -= 1;
        }

        db.guesses.push({ id: guessIdCounter++, room_id: data.room_id, user_id: socket.tg_id, guess_text: data.guess, created_at: getNowStr() });
        
        if (data.guess.toLowerCase() === (room.word_to_draw || '').toLowerCase()) {
            endRound(data.room_id, room);
        }
        broadcastSync(data.room_id);
    });

    // Calls / WebRTC Signaling
    socket.on('initiate_call', (data) => {
        const user = db.users[socket.tg_id];
        if (user.credits < 1) return socket.emit('alert', { type: 'error', message: 'Need 1 credit.'});
        
        const existing = Object.values(db.calls).find(c => c.status !== 'ENDED' && (c.caller_id === data.receiver_id || c.receiver_id === data.receiver_id));
        if (existing) return socket.emit('alert', { type: 'error', message: 'User is busy.' });

        const cid = callIdCounter++;
        db.calls[cid] = { id: cid, room_id: data.room_id, caller_id: socket.tg_id, receiver_id: data.receiver_id, status: 'RINGING' };
        broadcastSync(data.room_id);
    });

    socket.on('accept_call', (data) => {
        const call = db.calls[data.call_id];
        if (call && call.status === 'RINGING' && call.receiver_id === socket.tg_id) {
            const caller = db.users[call.caller_id];
            if (caller.credits < 1) {
                call.status = 'DECLINED';
                return socket.emit('alert', { type: 'error', message: 'Caller out of credits.' });
            }
            call.status = 'ACTIVE';
            call.started_at = getNowStr();
            call.last_billed_at = getNowStr();
            broadcastSync(call.room_id);
        }
    });

    socket.on('end_call', (data) => {
        const call = db.calls[data.call_id];
        if (call && (call.caller_id === socket.tg_id || call.receiver_id === socket.tg_id)) {
            call.status = data.action === 'decline' ? 'DECLINED' : 'ENDED';
            db.webrtc_signals = db.webrtc_signals.filter(s => s.call_id !== data.call_id);
            broadcastSync(call.room_id);
        }
    });

    socket.on('webrtc_signal', (data) => {
        db.webrtc_signals.push({ call_id: data.call_id, sender_id: socket.tg_id, receiver_id: data.receiver_id, type: data.type, payload: data.payload });
        broadcastSync(db.calls[data.call_id]?.room_id);
    });
});

function sendGlobalData(target) {
    const roomsFormatted = Object.values(db.rooms).map(r => ({
        id: r.id, status: r.status, member_count: db.room_members.filter(rm => rm.room_id === r.id).length
    }));
    
    // For specific socket
    if (target.emit) {
        const userData = db.users[target.tg_id];
        const currentRoomId = db.room_members.find(rm => rm.user_id === target.tg_id)?.room_id;
        target.emit('global_update', {
            rooms: roomsFormatted,
            user_data: userData,
            current_room: currentRoomId,
            server_date: getTodayStr(),
            server_time: getNowStr()
        });
    } else {
        // Broadcast to all
        target.emit('rooms_update', { rooms: roomsFormatted });
    }
}

function broadcastSync(roomId) {
    if (!roomId) return;
    const room = db.rooms[roomId];
    if (!room) return;

    const members = db.room_members.filter(rm => rm.room_id === roomId);
    const chats = db.chat_messages.filter(c => c.room_id === roomId).slice(-20);
    const roomDrawings = db.drawings.filter(d => d.room_id === roomId).map(d => d.line_data);
    const calls = Object.values(db.calls).filter(c => c.room_id === roomId && c.status !== 'ENDED' && c.status !== 'DECLINED');
    const signals = db.webrtc_signals.filter(s => calls.find(c => c.id === s.call_id));

    // Dynamic hint generation logic matching PHP
    if (room.word_to_draw) {
        if (['REVEAL', 'BREAK'].includes(room.status)) {
            room.hint = room.word_to_draw;
        } else {
            const word = room.word_to_draw;
            let len = word.length;
            let revealCount = 1;
            if (len >= 10) revealCount = 4;
            else if (len >= 7) revealCount = 3;
            else if (len >= 4) revealCount = 2;

            // Simple stable scramble based on string (mocking PHP srand)
            let hintArr = word.split('').map(c => /[a-zA-Z]/.test(c) ? '_' : c);
            for(let i=0; i<revealCount; i++) {
                let idx = (room.id + i * 3) % word.length; // Pseudo random deterministic
                if(/[a-zA-Z]/.test(word[idx])) hintArr[idx] = word[idx];
            }
            room.hint = hintArr.join(' ');
        }
    }

    io.to(roomId.toString()).fetchSockets().then(sockets => {
        sockets.forEach(s => {
            const isDrawer = room.current_drawer_id === s.tg_id;
            const revealState = ['REVEAL', 'BREAK'].includes(room.status) || isDrawer;
            
            const guesses = db.guesses.filter(g => g.room_id === roomId).map(g => {
                if (revealState || g.user_id === s.tg_id) return { ...g, is_blurred: false };
                return { ...g, guess_text: '••••••••', is_blurred: true };
            });

            const mySignals = signals.filter(sig => sig.receiver_id === s.tg_id);
            // Delete signals once delivered
            db.webrtc_signals = db.webrtc_signals.filter(sig => sig.receiver_id !== s.tg_id);

            s.emit('sync', {
                room, members, chats, guesses, calls,
                drawings: roomDrawings,
                webrtc_signals: mySignals,
                server_time: getNowStr(),
                dynamic_cooldown: 10
            });
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DoodleDash Server running on port ${PORT}`));
