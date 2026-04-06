const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. DATABASE SETUP (SQLite)
// ==========================================
const db = new sqlite3.Database('./doodledash.db', (err) => {
    if (err) console.error("Database Error:", err.message);
    else console.log("Connected to SQLite Database.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        tg_id TEXT PRIMARY KEY,
        credits INTEGER DEFAULT 0,
        last_daily_claim TEXT,
        ad_claims_today INTEGER DEFAULT 0,
        last_ad_claim_time TEXT,
        last_ad_claim_date TEXT,
        ad2_claims_today INTEGER DEFAULT 0,
        last_ad2_claim_time TEXT,
        last_ad2_claim_date TEXT,
        profile_pic TEXT,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ==========================================
// 2. IN-MEMORY STATE (Rooms & Calls)
// ==========================================
const rooms = new Map(); // id -> { status, word_to_draw, current_drawer_id, members:[], drawings:[], chats:[], guesses:[], timer:0, next_drawer_id: null, last_winner_id: null }
const calls = new Map(); // id -> { caller_id, receiver_id, status, started_at, last_billed_at, room_id }
let nextRoomId = 1;
let nextCallId = 1;

const gameWords = ["Apple", "Banana", "Car", "Dog", "House", "Sun", "Tree", "Computer", "Phone", "Pizza", "Ocean", "Mountain", "River", "Bird", "Cat", "Fish"];

function getDbDate() {
    // Format YYYY-MM-DD
    return new Date().toISOString().split('T')[0];
}

function getDbTime() {
    // Format YYYY-MM-DD HH:MM:SS
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// ==========================================
// 3. SOCKET.IO HANDLERS
// ==========================================
io.on('connection', (socket) => {
    
    // Auth & Init
    socket.on('auth', ({ tg_id, photo_url }) => {
        if (!tg_id) return;
        socket.tg_id = tg_id;
        
        db.get(`SELECT * FROM users WHERE tg_id = ?`, [tg_id], (err, user) => {
            if (!user) {
                db.run(`INSERT INTO users (tg_id, profile_pic) VALUES (?, ?)`, [tg_id, photo_url]);
            } else {
                db.run(`UPDATE users SET last_active = CURRENT_TIMESTAMP, profile_pic = ? WHERE tg_id = ?`, [photo_url, tg_id]);
            }
            
            db.get(`SELECT * FROM users WHERE tg_id = ?`, [tg_id], (err, updatedUser) => {
                socket.emit('auth_success', { user: updatedUser, server_date: getDbDate(), server_time: getDbTime() });
                sendRoomsList();
            });
        });
    });

    // Claims
    socket.on('claim_daily', () => {
        const tg_id = socket.tg_id;
        const today = getDbDate();
        db.get(`SELECT last_daily_claim FROM users WHERE tg_id = ?`, [tg_id], (err, row) => {
            if (row && row.last_daily_claim === today) return socket.emit('alert', { type: 'error', msg: 'Already claimed today!' });
            db.run(`UPDATE users SET credits = credits + 1, last_daily_claim = ? WHERE tg_id = ?`, [today, tg_id], () => {
                socket.emit('alert', { type: 'success', msg: 'Claimed 1 Free Credit!' });
                refreshUser(socket);
            });
        });
    });

    socket.on('claim_ad', ({ type }) => {
        const tg_id = socket.tg_id;
        const today = getDbDate();
        const now = getDbTime();
        
        const claimField = type === 'ad1' ? 'ad_claims_today' : 'ad2_claims_today';
        const dateField = type === 'ad1' ? 'last_ad_claim_date' : 'last_ad2_claim_date';
        const timeField = type === 'ad1' ? 'last_ad_claim_time' : 'last_ad2_claim_time';

        db.get(`SELECT * FROM users WHERE tg_id = ?`, [tg_id], (err, row) => {
            let claims = row[dateField] === today ? row[claimField] : 0;
            if (claims >= 2) return socket.emit('alert', { type: 'error', msg: 'Daily ad limit reached (Max 2/day)!' });
            
            if (claims > 0 && row[timeField]) {
                const lastTime = new Date(row[timeField]).getTime();
                if ((Date.now() - lastTime) < 3 * 3600 * 1000) {
                    return socket.emit('alert', { type: 'error', msg: 'Cooldown active! Please wait 3 hours.' });
                }
            }

            db.run(`UPDATE users SET credits = credits + 2, ${claimField} = ?, ${timeField} = ?, ${dateField} = ? WHERE tg_id = ?`, 
                [claims + 1, now, today, tg_id], () => {
                socket.emit('alert', { type: 'success', msg: 'Claimed 2 Free Credits!' });
                refreshUser(socket);
            });
        });
    });

    // Room Management
    socket.on('create_room', () => {
        const tg_id = socket.tg_id;
        db.get(`SELECT credits FROM users WHERE tg_id = ?`, [tg_id], (err, row) => {
            if (row.credits < 1) return socket.emit('alert', { type: 'error', msg: 'Creating a room costs 1 credit.' });
            if (rooms.size >= 10) return socket.emit('alert', { type: 'error', msg: 'Max 10 active rooms globally reached.' });
            
            db.run(`UPDATE users SET credits = credits - 1 WHERE tg_id = ?`, [tg_id], () => {
                const roomId = nextRoomId++;
                rooms.set(roomId, {
                    id: roomId, status: 'WAITING', members: [], drawings: [], chats: [], guesses: [], timer: 0
                });
                refreshUser(socket);
                sendRoomsList();
                socket.emit('room_created', { room_id: roomId });
            });
        });
    });

    socket.on('join_room', ({ room_id }) => {
        const room = rooms.get(room_id);
        if (!room) return socket.emit('alert', { type: 'error', msg: 'Room not found' });
        if (room.members.length >= 4) return socket.emit('alert', { type: 'error', msg: 'Room is full' });

        // Leave existing rooms
        leaveCurrentRoom(socket);

        socket.join(`room_${room_id}`);
        socket.room_id = room_id;
        
        db.get(`SELECT profile_pic FROM users WHERE tg_id = ?`, [socket.tg_id], (err, row) => {
            room.members.push({ user_id: socket.tg_id, profile_pic: row?.profile_pic, is_ready: 0, consecutive_turns: 0, total_turns: 0 });
            sendRoomsList();
            broadcastRoomUpdate(room_id);
        });
    });

    socket.on('leave_room', () => { leaveCurrentRoom(socket); sendRoomsList(); });

    // Game Actions
    socket.on('set_ready', () => {
        const room = rooms.get(socket.room_id);
        if (!room) return;
        const member = room.members.find(m => m.user_id === socket.tg_id);
        if (member) member.is_ready = 1;
        broadcastRoomUpdate(room.id);
    });

    socket.on('set_word', ({ word }) => {
        const room = rooms.get(socket.room_id);
        if (room && room.current_drawer_id === socket.tg_id) {
            room.word_to_draw = word;
            room.status = 'DRAWING';
            room.timer = 120; // 120 seconds
            room.drawings = [];
            room.guesses = [];
            broadcastRoomUpdate(room.id);
        }
    });

    socket.on('draw', ({ lines }) => {
        const room = rooms.get(socket.room_id);
        if (room && room.current_drawer_id === socket.tg_id && room.status === 'DRAWING') {
            room.drawings.push(lines);
            socket.to(`room_${room.id}`).emit('draw_sync', { lines });
        }
    });

    socket.on('undo_draw', () => {
        const room = rooms.get(socket.room_id);
        if (room && room.current_drawer_id === socket.tg_id && room.drawings.length > 0) {
            const popped = room.drawings.pop();
            io.to(`room_${room.id}`).emit('undo_sync', { popped });
        }
    });

    socket.on('chat', ({ message }) => {
        const room = rooms.get(socket.room_id);
        if (room) {
            room.chats.push({ user_id: socket.tg_id, message, id: Date.now() });
            if (room.chats.length > 20) room.chats.shift();
            broadcastRoomUpdate(room.id);
        }
    });

    socket.on('guess', ({ guess }) => {
        const room = rooms.get(socket.room_id);
        const tg_id = socket.tg_id;
        if (!room || room.status !== 'DRAWING') return;

        let myGuesses = room.guesses.filter(g => g.user_id === tg_id);
        
        db.get(`SELECT credits FROM users WHERE tg_id = ?`, [tg_id], (err, row) => {
            if (myGuesses.length >= 5 && row.credits < 1) {
                return socket.emit('alert', { type: 'error', msg: 'Out of free guesses. Need 1 credit.' });
            }
            
            const processGuess = () => {
                room.guesses.push({ user_id: tg_id, guess_text: guess, id: Date.now() });
                if (guess.toLowerCase() === room.word_to_draw.toLowerCase()) {
                    endRound(room, tg_id);
                } else {
                    broadcastRoomUpdate(room.id);
                }
            };

            if (myGuesses.length >= 5) {
                db.run(`UPDATE users SET credits = credits - 1 WHERE tg_id = ?`, [tg_id], processGuess);
            } else {
                processGuess();
            }
        });
    });

    // WebRTC Calls
    socket.on('initiate_call', ({ receiver_id }) => {
        const room = rooms.get(socket.room_id);
        if (!room) return;
        
        db.get(`SELECT credits FROM users WHERE tg_id = ?`, [socket.tg_id], (err, row) => {
            if (row.credits < 1) return socket.emit('alert', { type: 'error', msg: 'Need 1 credit to start call.' });
            
            const callId = nextCallId++;
            calls.set(callId, { id: callId, room_id: room.id, caller_id: socket.tg_id, receiver_id, status: 'RINGING' });
            
            io.to(`room_${room.id}`).emit('call_update', getRoomCalls(room.id));
        });
    });

    socket.on('accept_call', ({ call_id }) => {
        const call = calls.get(call_id);
        if (call && call.receiver_id === socket.tg_id) {
            call.status = 'ACTIVE';
            call.started_at = Date.now();
            call.last_billed_at = Date.now();
            io.to(`room_${call.room_id}`).emit('call_update', getRoomCalls(call.room_id));
        }
    });

    socket.on('end_call', ({ call_id }) => {
        const call = calls.get(call_id);
        if (call && (call.caller_id === socket.tg_id || call.receiver_id === socket.tg_id)) {
            calls.delete(call_id);
            io.to(`room_${call.room_id}`).emit('call_update', getRoomCalls(call.room_id));
        }
    });

    socket.on('webrtc_signal', ({ call_id, receiver_id, type, payload }) => {
        // Direct routing to avoid DB overhead
        const clients = io.sockets.adapter.rooms.get(`room_${socket.room_id}`);
        if (clients) {
            for (const clientId of clients) {
                const clientSocket = io.sockets.sockets.get(clientId);
                if (clientSocket && clientSocket.tg_id === receiver_id) {
                    clientSocket.emit('webrtc_signal', { call_id, sender_id: socket.tg_id, type, payload });
                    break;
                }
            }
        }
    });

    socket.on('disconnect', () => { leaveCurrentRoom(socket); });
});

// ==========================================
// Helper Functions & Game Loop
// ==========================================
function refreshUser(socket) {
    db.get(`SELECT * FROM users WHERE tg_id = ?`, [socket.tg_id], (err, user) => {
        if (user) socket.emit('auth_success', { user, server_date: getDbDate(), server_time: getDbTime() });
    });
}

function sendRoomsList() {
    const rList = Array.from(rooms.values()).map(r => ({
        id: r.id, status: r.status, member_count: r.members.length
    }));
    io.emit('rooms_list', rList);
}

function broadcastRoomUpdate(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Mask word logic for hints
    let hint = room.word_to_draw;
    if (room.status === 'DRAWING' && room.word_to_draw) {
        hint = room.word_to_draw.replace(/[a-zA-Z]/g, '_ ');
    }

    io.to(`room_${roomId}`).emit('room_update', {
        room: { ...room, hint },
        calls: getRoomCalls(roomId)
    });
}

function getRoomCalls(roomId) {
    return Array.from(calls.values()).filter(c => c.room_id === roomId);
}

function leaveCurrentRoom(socket) {
    if (!socket.room_id) return;
    const room = rooms.get(socket.room_id);
    if (room) {
        room.members = room.members.filter(m => m.user_id !== socket.tg_id);
        socket.leave(`room_${room.id}`);
        
        // Clean up calls
        Array.from(calls.values()).forEach(c => {
            if (c.caller_id === socket.tg_id || c.receiver_id === socket.tg_id) calls.delete(c.id);
        });

        if (room.members.length === 0) {
            rooms.delete(room.id);
        } else if (room.current_drawer_id === socket.tg_id) {
            room.chats.push({ user_id: 'System', message: '⚠️ Drawer left! Resetting.', id: Date.now() });
            room.status = 'WAITING';
            room.current_drawer_id = null;
        }
        broadcastRoomUpdate(room?.id);
    }
    socket.room_id = null;
}

function endRound(room, winnerId) {
    room.last_winner_id = winnerId;
    room.status = 'REVEAL';
    room.timer = 5; // 5s reveal
    
    // Pick next drawer
    room.members.forEach(m => m.is_ready = 0);
    const validNexts = room.members.filter(m => m.user_id !== room.current_drawer_id);
    if (validNexts.length > 0) {
        room.next_drawer_id = validNexts.sort((a,b) => a.total_turns - b.total_turns)[0].user_id;
    } else {
        room.next_drawer_id = room.members[0]?.user_id;
    }
    broadcastRoomUpdate(room.id);
}

// 1-Second Master Tick Engine
setInterval(() => {
    rooms.forEach((room) => {
        // Handle Timers
        if (room.timer > 0) {
            room.timer--;
            
            if (room.timer === 0) {
                if (room.status === 'DRAWING') endRound(room, null);
                else if (room.status === 'REVEAL') { room.status = 'BREAK'; room.timer = 15; broadcastRoomUpdate(room.id); }
                else if (room.status === 'BREAK') {
                    room.status = 'PRE_DRAW';
                    room.current_drawer_id = room.next_drawer_id;
                    room.drawings = [];
                    room.guesses = [];
                    broadcastRoomUpdate(room.id);
                }
            } else {
                io.to(`room_${room.id}`).emit('timer_tick', room.timer);
            }
        }

        // Logic Auto-Advance
        if (room.status === 'WAITING' && room.members.length >= 2) {
            if (room.members.every(m => m.is_ready === 1)) {
                room.status = 'PRE_DRAW';
                room.current_drawer_id = room.members.sort((a,b)=> a.total_turns - b.total_turns)[0].user_id;
                room.members.forEach(m => m.is_ready = 0);
                broadcastRoomUpdate(room.id);
            }
        }

        if ((room.status === 'REVEAL' || room.status === 'BREAK') && room.members.length >= 2) {
            if (room.members.every(m => m.is_ready === 1)) {
                room.status = 'PRE_DRAW';
                room.current_drawer_id = room.next_drawer_id;
                room.members.forEach(m => m.is_ready = 0);
                room.drawings = [];
                room.guesses = [];
                room.timer = 0;
                broadcastRoomUpdate(room.id);
            }
        }
    });

    // Call Billing System (Bills 1 credit per 120s)
    calls.forEach(call => {
        if (call.status === 'ACTIVE') {
            const elapsed = Date.now() - call.last_billed_at;
            if (elapsed >= 120000) {
                db.get(`SELECT credits FROM users WHERE tg_id = ?`, [call.caller_id], (err, row) => {
                    if (row.credits >= 1) {
                        db.run(`UPDATE users SET credits = credits - 1 WHERE tg_id = ?`, [call.caller_id]);
                        call.last_billed_at = Date.now();
                        
                        // Send credit updates to clients directly
                        const clients = io.sockets.adapter.rooms.get(`room_${call.room_id}`);
                        if (clients) {
                            for (const clientId of clients) {
                                const s = io.sockets.sockets.get(clientId);
                                if (s && s.tg_id === call.caller_id) refreshUser(s);
                            }
                        }
                    } else {
                        calls.delete(call.id);
                        io.to(`room_${call.room_id}`).emit('call_update', getRoomCalls(call.room_id));
                    }
                });
            }
        }
    });

}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`DoodleDash Server listening on port ${PORT}`);
});
