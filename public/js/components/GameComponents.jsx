const { useState, useEffect, useRef, useCallback } = React;

// --- Utility: Dynamic Style Loader Hook ---
// Implements Requirement 4: Extracts unique equipped styles, dynamically loads their Google Fonts,
// and injects their CSS into a single <style> tag in the document <head>.
const useDynamicStyles = (activeStyleIds, styleDatabase) => {
    useEffect(() => {
        if (!styleDatabase || !activeStyleIds || activeStyleIds.length === 0) return;
        
        const uniqueIds = [...new Set(activeStyleIds)].filter(Boolean);
        const requiredFonts = new Set();
        let combinedCSS = "";
        
        uniqueIds.forEach(id => {
            const styleData = styleDatabase.find(s => s.id === id);
            if (styleData) {
                requiredFonts.add(styleData.font_family);
                combinedCSS += `\n/* Loaded dynamically for ${id} */\n${styleData.css_content}`;
            }
        });
        
        // Inject Google Fonts dynamically
        if (requiredFonts.size > 0) {
            const fontFamilies = Array.from(requiredFonts).map(f => `family=${f.replace(/ /g, '+')}`).join('&');
            const fontUrl = `https://fonts.googleapis.com/css2?${fontFamilies}&display=swap`;
            
            let linkTag = document.getElementById('dynamic-google-fonts');
            if (!linkTag) {
                linkTag = document.createElement('link');
                linkTag.id = 'dynamic-google-fonts';
                linkTag.rel = 'stylesheet';
                document.head.appendChild(linkTag);
            }
            if (linkTag.href !== fontUrl) {
                linkTag.href = fontUrl;
            }
        }
        
        // Inject CSS rules dynamically
        if (combinedCSS) {
            let styleTag = document.getElementById('dynamic-room-styles');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'dynamic-room-styles';
                document.head.appendChild(styleTag);
            }
            if (styleTag.innerHTML !== combinedCSS) {
                styleTag.innerHTML = combinedCSS;
            }
        }
    }, [JSON.stringify(activeStyleIds), styleDatabase]);
};

// --- Custom Dictionary Fallback ---
let RANDOM_WORDS = ["apple", "banana", "car", "dog", "house", "sun", "moon", "tree", "bird", "cat", "fish", "boat", "train", "plane"];
fetch('/api/public/dictionary')
    .then(r => r.json())
    .then(words => { if (words && words.length > 0) RANDOM_WORDS = words; })
    .catch(e => console.error("Could not fetch custom dictionary"));


// ==========================================
// 1. WHITEBOARD COMPONENT
// ==========================================
const Whiteboard = ({ roomData, tgId, socket, setModal, systemConfig }) => {
    const canvasRef = useRef(null);
    const [localTimeLeft, setLocalTimeLeft] = useState(0);
    const [preDrawTimeLeft, setPreDrawTimeLeft] = useState(30);
    
    const drawingRef = useRef(false);
    const currentLineRef = useRef([]);
    const lastPosRef = useRef({x: 0, y: 0});
    const inkUsedRef = useRef(0);
    const localInkRef = useRef({});
    
    const initialDrawingsRef = useRef([]);
    const emitTimeoutRef = useRef(null);

    const { room, members } = roomData;
    const isDrawer = room.current_drawer_id === tgId;
    const isDrawingPhase = room.status === 'DRAWING';
    
    const isMeReady = members.find(m => m.user_id === tgId)?.is_ready;
    const readyCount = members.filter(m => m.is_ready).length;
    
    const [wordInput, setWordInput] = useState('');
    
    const drawerMember = members.find(m => m.user_id === room.current_drawer_id) || {};
    const drawerInkExtraObj = drawerMember.ink_extra || {};
    
    const inkConfig = systemConfig?.inkConfig || { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 };
    const currentMaxInk = inkConfig.free + (drawerInkExtraObj['black'] || 0);

    const maintActive = systemConfig?.maintenance?.active;
    const maintEndTime = systemConfig?.maintenance?.end_time;

    useEffect(() => {
        if (maintActive && !isMeReady && (room.status === 'WAITING' || room.status === 'BREAK' || room.status === 'REVEAL')) {
            setModal({ type: 'maintenance', end_time: maintEndTime });
        }
    }, [maintActive, isMeReady, room.status, maintEndTime, setModal]);

    // --- Reaction System ---
    const [userReactions, setUserReactions] = useState({});
    const emojis = ['😂', '😍', '😋', '💦', '🍑', '🍆', '🔥', '💀', '💯', '🤔', '😡', '👀', '🎉', '💩', '🤡', '😭'];

    useEffect(() => {
        if (room.status === 'PRE_DRAW' || room.status === 'WAITING') setUserReactions({});
    }, [room.status, room.turn_index]);

    useEffect(() => {
        if (!socket) return;
        const handleReaction = ({ user_id, emoji, action }) => {
            setUserReactions(prev => {
                const next = { ...prev };
                if (action === 'remove') delete next[user_id];
                else next[user_id] = emoji;
                return next;
            });
        };
        socket.on('new_reaction', handleReaction);
        return () => socket.off('new_reaction', handleReaction);
    }, [socket]);

    const sendReaction = (emoji) => {
        if (isDrawer) return;
        if (socket) {
            const action = userReactions[tgId] === emoji ? 'remove' : 'add';
            socket.emit('send_reaction', { emoji, action });
            setUserReactions(prev => {
                const next = { ...prev };
                if (action === 'remove') delete next[tgId];
                else next[tgId] = emoji;
                return next;
            });
        }
    };

    // --- Timers ---
    useEffect(() => {
        if ((room.status === 'WAITING' || room.status === 'BREAK' || room.status === 'REVEAL') && room.break_end_time) {
            const offset = Date.now() - new Date(roomData.server_time).getTime();
            const targetTime = new Date(room.break_end_time).getTime() + offset;
            
            const updateTime = () => setLocalTimeLeft(Math.max(0, Math.ceil((targetTime - Date.now()) / 1000)));
            updateTime();
            const intv = setInterval(updateTime, 1000);
            return () => clearInterval(intv);
        }
    }, [room.status, room.break_end_time, roomData.server_time]);

    useEffect(() => {
        if (room.status === 'PRE_DRAW' && room.round_end_time) {
            const offset = Date.now() - new Date(roomData.server_time).getTime();
            const targetTime = new Date(room.round_end_time).getTime() + offset;
            
            const updateTime = () => setPreDrawTimeLeft(Math.max(0, Math.ceil((targetTime - Date.now()) / 1000)));
            updateTime();
            const intv = setInterval(updateTime, 1000);
            return () => clearInterval(intv);
        }
    }, [room.status, room.round_end_time, roomData.server_time]);

    // --- Drawing Engine ---
    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        if(!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0, canvas.width, canvas.height);
        ctx.lineCap = 'round';
        ctx.lineWidth = 5;
        
        initialDrawingsRef.current.forEach(data => {
            ctx.strokeStyle = data.color === 'black' ? '#000000' : (data.color || '#000000');
            const lines = data.lines;
            if (!lines) return;
            for (let i = 0; i < lines.length; i += 4) {
                ctx.beginPath();
                ctx.moveTo(lines[i], lines[i+1]);
                ctx.lineTo(lines[i+2], lines[i+3]);
                ctx.stroke();
            }
        });
    }, []);

    useEffect(() => { 
        redraw(); 
        if (socket) socket.emit('request_initial_drawings');
    }, [redraw, socket]);

    useEffect(() => {
        if (!socket) return;
        const handleInitialDrawings = (drawings) => {
            initialDrawingsRef.current = drawings;
            redraw();
        };
        const handleLiveDraw = (data) => {
            let lines = data.lines;
            let color = data.color || 'black';
            const canvas = canvasRef.current;
            if(!canvas || !lines) return;
            
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = color === 'black' ? '#000000' : color;
            ctx.lineCap = 'round';
            ctx.lineWidth = 5;
            for (let i = 0; i < lines.length; i += 4) {
                ctx.beginPath();
                ctx.moveTo(lines[i], lines[i+1]);
                ctx.lineTo(lines[i+2], lines[i+3]);
                ctx.stroke();
            }
            initialDrawingsRef.current.push({ lines, color });
        };

        socket.on('sync_initial_drawings', handleInitialDrawings);
        socket.on('live_draw', handleLiveDraw);
        
        return () => {
            socket.off('sync_initial_drawings', handleInitialDrawings);
            socket.off('live_draw', handleLiveDraw);
        }
    }, [socket, isDrawer, redraw]);

    const getMousePos = (e) => {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { 
            x: (clientX - rect.left) * scaleX, 
            y: (clientY - rect.top) * scaleY 
        };
    };

    const startDraw = (e) => {
        if (!isDrawer || !isDrawingPhase) return;
        try { e.target.setPointerCapture(e.pointerId); } catch(err) {}
        drawingRef.current = true;
        currentLineRef.current = [];
        lastPosRef.current = getMousePos(e);
    };

    const draw = (e) => {
        if (!drawingRef.current || !isDrawer || !isDrawingPhase) return;
        if (e.touches && e.touches.length > 1) return; // Ignore multi-touch
        e.preventDefault();

        const newPos = getMousePos(e);
        const lineSegment = [lastPosRef.current.x, lastPosRef.current.y, newPos.x, newPos.y];
        currentLineRef.current.push(...lineSegment);

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = '#000000';
        ctx.lineCap = 'round';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
        ctx.lineTo(newPos.x, newPos.y);
        ctx.stroke();

        lastPosRef.current = newPos;

        // Throttle emits to save bandwidth
        if (!emitTimeoutRef.current) {
            emitTimeoutRef.current = setTimeout(() => {
                if (currentLineRef.current.length > 0) {
                    socket.emit('draw', { lines: currentLineRef.current, color: 'black' });
                    currentLineRef.current = [];
                }
                emitTimeoutRef.current = null;
            }, 50);
        }
    };

    const endDraw = (e) => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        try { e.target.releasePointerCapture(e.pointerId); } catch(err) {}
        if (emitTimeoutRef.current) {
            clearTimeout(emitTimeoutRef.current);
            emitTimeoutRef.current = null;
        }
        if (currentLineRef.current.length > 0) {
            socket.emit('draw', { lines: currentLineRef.current, color: 'black' });
            currentLineRef.current = [];
        }
    };

    // --- Overlay UI Renderers ---
    const renderOverlay = () => {
        if (room.status === 'WAITING' || (room.status === 'REVEAL' && room.members.length < 2)) {
            return (
                <div className="whiteboard-overlay bg-light bg-opacity-75 d-flex flex-column justify-content-center align-items-center rounded-4">
                    <h4 className="fw-bold text-dark mb-3">Waiting for players...</h4>
                    <p className="text-muted">Requires at least 2 players to start.</p>
                    <div className="d-flex align-items-center gap-2 mb-3">
                        <i className="fas fa-users text-primary"></i>
                        <span className="fw-bold">{members.length} / {room.max_members}</span>
                    </div>
                    {members.length >= 2 && (
                        <button 
                            className={`btn ${isMeReady ? 'btn-success' : 'btn-primary'} rounded-pill fw-bold px-4 py-2 shadow`}
                            onClick={() => !isMeReady && socket.emit('set_ready')}
                            disabled={isMeReady || maintActive}
                        >
                            {isMeReady ? <><i className="fas fa-check-circle me-2"></i>Ready ({readyCount}/{members.length})</> : 'Ready Up'}
                        </button>
                    )}
                </div>
            );
        }

        if (room.status === 'PRE_DRAW') {
            if (isDrawer) {
                return (
                    <div className="whiteboard-overlay bg-white rounded-4 d-flex flex-column p-4">
                        <h4 className="fw-bold text-primary mb-2 text-center">It's your turn to draw!</h4>
                        <p className="text-muted text-center mb-4"><i className="fas fa-clock me-1"></i> {preDrawTimeLeft}s remaining</p>
                        <p className="fw-bold text-dark mb-2 text-center">Pick a word, or write your own:</p>
                        <div className="d-flex flex-wrap gap-2 justify-content-center mb-3">
                            {RANDOM_WORDS.sort(()=>0.5-Math.random()).slice(0,3).map(w => (
                                <button key={w} className="btn btn-outline-primary fw-bold" onClick={() => socket.emit('set_word', { word: w })}>{w}</button>
                            ))}
                        </div>
                        <div className="input-group mt-auto shadow-sm">
                            <input type="text" className="form-control text-center fw-bold" placeholder="Custom word..." value={wordInput} onChange={e=>setWordInput(e.target.value.replace(/[^A-Za-z ]/g, ''))} maxLength="15" />
                            <button className="btn btn-primary fw-bold" onClick={() => {if(wordInput.trim()) socket.emit('set_word', {word: wordInput.trim()})}}><i className="fas fa-pencil-alt"></i></button>
                        </div>
                    </div>
                );
            } else {
                return (
                    <div className="whiteboard-overlay bg-light bg-opacity-75 d-flex flex-column justify-content-center align-items-center rounded-4">
                        <div className="spinner-border text-primary mb-3" role="status"></div>
                        <h4 className="fw-bold text-dark">{window.getDisplayName(room.current_drawer_id, roomData.names)} is choosing a word...</h4>
                        <p className="text-muted"><i className="fas fa-clock"></i> {preDrawTimeLeft}s</p>
                        
                        {!isDrawer && (
                            <div className="mt-3 text-center w-100 px-3">
                                <p className="text-muted small fw-bold mb-2">Send a reaction:</p>
                                <div className="d-flex flex-wrap justify-content-center gap-2">
                                    {emojis.slice(0, 8).map(e => (
                                        <button key={e} className={`btn btn-sm ${userReactions[tgId]===e ? 'btn-primary' : 'btn-light border'} shadow-sm fs-5`} onClick={() => sendReaction(e)}>{e}</button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            }
        }

        if (room.status === 'REVEAL' || room.status === 'BREAK') {
            return (
                <div className="whiteboard-overlay bg-white bg-opacity-90 d-flex flex-column justify-content-center align-items-center rounded-4 p-4 text-center" style={{ backdropFilter: 'blur(5px)' }}>
                    {room.end_reason === 'all_gave_up' && <h3 className="text-danger fw-bold mb-2"><i className="fas fa-times-circle"></i> Everyone Gave Up</h3>}
                    {room.end_reason === 'drawer_gave_up' && <h3 className="text-danger fw-bold mb-2"><i className="fas fa-flag"></i> Drawer Gave Up</h3>}
                    {!room.end_reason && room.last_winner_id && <h3 className="text-success fw-bold mb-2"><i className="fas fa-crown"></i> Round Over!</h3>}
                    
                    <p className="text-dark fs-5 mb-1">The word was:</p>
                    <h2 className="display-4 fw-bold text-primary text-uppercase tracking-widest mb-4" style={{letterSpacing: '5px'}}>{room.word_to_draw}</h2>
                    
                    {room.last_winner_id && (
                        <div className="bg-success bg-opacity-10 text-success p-2 px-4 rounded-pill fw-bold border border-success mb-4 shadow-sm">
                            <i className="fas fa-trophy me-2"></i> {window.getDisplayName(room.last_winner_id, roomData.names)} guessed it!
                        </div>
                    )}

                    <div className="mt-2 w-100">
                        <div className="progress mb-2" style={{height: '6px'}}>
                            <div className="progress-bar bg-primary" style={{width: `${(localTimeLeft / 5) * 100}%`, transition: 'width 1s linear'}}></div>
                        </div>
                        <p className="text-muted small fw-bold">Next round in {localTimeLeft}s...</p>
                    </div>

                    <button 
                        className={`btn ${isMeReady ? 'btn-success' : 'btn-outline-primary'} rounded-pill fw-bold px-4 py-2 shadow mt-3`}
                        onClick={() => !isMeReady && socket.emit('set_ready')}
                        disabled={isMeReady || maintActive}
                    >
                        {isMeReady ? <><i className="fas fa-check-circle me-2"></i>Ready ({readyCount}/{members.length})</> : 'Ready Up Now'}
                    </button>
                </div>
            );
        }

        return null;
    };

    return (
        <div className="whiteboard-container position-relative bg-white rounded-4 shadow-sm border overflow-hidden">
            <canvas 
                ref={canvasRef} 
                width={500} 
                height={500} 
                className={`w-100 h-100 ${isDrawer && isDrawingPhase ? 'cursor-crosshair' : ''}`}
                onPointerDown={startDraw}
                onPointerMove={draw}
                onPointerUp={endDraw}
                onPointerOut={endDraw}
                onPointerCancel={endDraw}
                style={{ touchAction: 'none' }}
            />
            {renderOverlay()}

            {isDrawingPhase && !isDrawer && (
                <div className="position-absolute bottom-0 start-50 translate-middle-x mb-2 d-flex flex-wrap justify-content-center gap-1 w-100 px-3" style={{pointerEvents:'none'}}>
                    {emojis.slice(0, 6).map(e => (
                        <button key={e} className={`btn btn-sm ${userReactions[tgId]===e ? 'btn-primary' : 'btn-light border'} shadow-sm fs-5`} style={{pointerEvents:'auto', padding:'2px 8px'}} onClick={() => sendReaction(e)}>{e}</button>
                    ))}
                </div>
            )}
            
            {/* Renders reactions floating over the board */}
            {Object.entries(userReactions).map(([uid, emoji]) => {
                if (uid === tgId) return null; 
                return (
                    <div key={uid} className="position-absolute fs-1 reaction-float" style={{
                        left: `${10 + (parseInt(uid.slice(-2), 16) % 80)}%`,
                        bottom: '20px',
                        pointerEvents: 'none',
                        animation: 'floatUp 2s ease-out forwards'
                    }}>
                        {emoji}
                        <div className="text-center bg-dark text-white rounded px-1 small shadow" style={{fontSize:'0.6rem', opacity:0.8}}>{window.getDisplayName(uid, roomData.names)}</div>
                    </div>
                );
            })}
        </div>
    );
};


// ==========================================
// 2. CHAT BOX COMPONENT (With Dynamic Styles)
// ==========================================
// Implements Requirement 5: Applies the user's specific style CSS class to their name in Chat messages.
const ChatBox = ({ chats, socket, tgId, user, roomData, setModal }) => {
    const chatEndRef = useRef(null);
    const [msg, setMsg] = useState('');

    useEffect(() => {
        if(chatEndRef.current) {
            chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chats]);

    const sendChat = (e) => {
        e.preventDefault();
        if (!msg.trim()) return;
        socket.emit('chat', { message: msg.trim() });
        setMsg('');
    };

    return (
        <div className="panel-body d-flex flex-column h-100">
            <div className="flex-grow-1 overflow-y-auto p-3 d-flex flex-column gap-2" style={{ maxHeight: 'calc(100vh - 200px)' }}>
                {chats.length === 0 ? (
                    <div className="text-center text-muted my-auto p-4">
                        <i className="fas fa-comments fs-1 mb-2 opacity-25"></i>
                        <p className="small">No messages yet.<br/>Be the first to say hi!</p>
                    </div>
                ) : (
                    chats.map((c, i) => {
                        const isMe = c.user_id === tgId;
                        const isSystem = c.user_id === 'System';
                        // Get user's active style ID
                        const userStyleClass = roomData.styles[c.user_id] || '';
                        const displayName = window.getDisplayName(c.user_id, roomData.names);

                        if (isSystem) {
                            return (
                                <div key={i} className="text-center my-2">
                                    <span className="badge bg-danger text-white px-3 py-2 rounded-pill shadow-sm"><i className="fas fa-bullhorn me-2"></i>{c.message}</span>
                                </div>
                            );
                        }
                        
                        return (
                            <div key={i} className={`d-flex ${isMe ? 'justify-content-end' : 'justify-content-start'}`}>
                                <div className={`chat-bubble ${isMe ? 'bg-primary text-white ms-4' : 'bg-white border text-dark me-4'} shadow-sm`}>
                                    {!isMe && (
                                        // CRITICAL: Applied equipped_style and data-name to username span
                                        <div className={`fw-bold mb-1 ${userStyleClass}`} style={{fontSize: '0.8rem'}} data-name={displayName}>
                                            {displayName}
                                        </div>
                                    )}
                                    <div style={{wordBreak: 'break-word', fontSize: '0.95rem'}}>{c.message}</div>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={chatEndRef} />
            </div>
            
            <div className="p-3 bg-white border-top flex-shrink-0">
                <form onSubmit={sendChat} className="input-group">
                    <input 
                        type="text" 
                        className="form-control rounded-start-pill border-end-0 bg-light shadow-none px-4" 
                        placeholder={user?.status === 'mute' ? "You are muted..." : "Type a message..."}
                        value={msg} 
                        onChange={e => setMsg(e.target.value)} 
                        maxLength="150"
                        disabled={user?.status === 'mute'}
                    />
                    <button className="btn btn-primary rounded-end-pill px-4 shadow-sm" type="submit" disabled={!msg.trim() || user?.status === 'mute'}>
                        <i className="fas fa-paper-plane"></i>
                    </button>
                </form>
            </div>
        </div>
    );
};


// ==========================================
// 3. GUESS BOX COMPONENT (With Dynamic Styles)
// ==========================================
// Integrates dynamically styled names into the guessing area as well for consistency.
const GuessBox = ({ guesses, tgId, roomData, socket, setModal }) => {
    const guessEndRef = useRef(null);
    const [guessInput, setGuessInput] = useState('');
    
    const isDrawer = roomData.room.current_drawer_id === tgId;
    const isDrawingPhase = roomData.room.status === 'DRAWING';
    const myGuesses = guesses.filter(g => g.user_id === tgId);

    useEffect(() => {
        if(guessEndRef.current) {
            guessEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [guesses]);

    const sendGuess = (e) => {
        e.preventDefault();
        if (!guessInput.trim() || isDrawer || !isDrawingPhase) return;
        socket.emit('guess', { guess: guessInput.trim() });
        setGuessInput('');
    };

    return (
        <div className="panel-body d-flex flex-column h-100">
            <div className="p-3 bg-white border-bottom shadow-sm flex-shrink-0">
                <div className="d-flex justify-content-between align-items-center mb-2">
                    <span className="fw-bold text-dark"><i className="fas fa-lightbulb text-warning me-2"></i> Word Guesses</span>
                    <span className="badge bg-primary rounded-pill">{6 - myGuesses.length} left</span>
                </div>
                {myGuesses.length >= 6 && isDrawingPhase && !isDrawer && (
                    <button className="btn btn-sm btn-outline-warning w-100 fw-bold border-dashed mb-2" onClick={() => socket.emit('buy_guess')}>
                        <i className="fas fa-coins me-1"></i> Buy Extra Guesses (1 Credit)
                    </button>
                )}
            </div>
            
            <div className="flex-grow-1 overflow-y-auto p-3 d-flex flex-column gap-2" style={{ backgroundColor: '#f8fafc', maxHeight: 'calc(100vh - 250px)' }}>
                {guesses.length === 0 ? (
                    <div className="text-center text-muted my-auto p-4">
                        <i className="fas fa-question-circle fs-1 mb-2 opacity-25"></i>
                        <p className="small">No guesses yet.<br/>Watch the drawing and guess the word!</p>
                    </div>
                ) : (
                    guesses.map((g, i) => {
                        const isMe = g.user_id === tgId;
                        // Get user's active style ID
                        const userStyleClass = roomData.styles[g.user_id] || '';
                        const displayName = window.getDisplayName(g.user_id, roomData.names);
                        
                        return (
                            <div key={i} className={`d-flex ${isMe ? 'justify-content-end' : 'justify-content-start'}`}>
                                <div className={`chat-bubble ${g.is_correct ? 'bg-success text-white' : (isMe ? 'bg-primary bg-opacity-10 border border-primary text-dark' : 'bg-white border text-dark')} shadow-sm px-3 py-2`} style={{maxWidth: '85%'}}>
                                    {!isMe && (
                                        // CRITICAL: Applied equipped_style and data-name to username span
                                        <div className={`fw-bold mb-1 ${userStyleClass}`} style={{fontSize: '0.75rem', opacity: g.is_correct ? 0.9 : 0.7}} data-name={displayName}>
                                            {displayName}
                                        </div>
                                    )}
                                    <div className="d-flex align-items-center gap-2">
                                        <span className="fw-bold" style={{fontSize: '1.1rem', letterSpacing: '1px'}}>{g.guess_text}</span>
                                        {g.is_correct && <i className="fas fa-check-circle fs-5 text-white shadow-sm rounded-circle"></i>}
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={guessEndRef} />
            </div>

            <div className="p-3 bg-white border-top flex-shrink-0">
                <form onSubmit={sendGuess} className="input-group">
                    <input 
                        type="text" 
                        className="form-control rounded-start-pill border-end-0 bg-light shadow-none px-4 fw-bold text-uppercase" 
                        placeholder={isDrawer ? "You are drawing!" : (myGuesses.length >= 6 ? "Out of guesses" : "Guess the word...")}
                        value={guessInput} 
                        onChange={e => setGuessInput(e.target.value.replace(/[^A-Za-z ]/g, ''))} 
                        maxLength="15"
                        disabled={isDrawer || !isDrawingPhase || myGuesses.length >= 6}
                    />
                    <button 
                        className={`btn ${isDrawer || !isDrawingPhase || myGuesses.length >= 6 ? 'btn-secondary' : 'btn-primary'} rounded-end-pill px-4 shadow-sm`} 
                        type="submit" 
                        disabled={!guessInput.trim() || isDrawer || !isDrawingPhase || myGuesses.length >= 6}
                    >
                        <i className="fas fa-paper-plane"></i>
                    </button>
                </form>
            </div>
        </div>
    );
};


// ==========================================
// 4. MAIN GAME ROOM WRAPPER & QUEUE
// ==========================================
// Implements Requirement 4 & 5: Gathers styles for users in the room, loads them dynamically, 
// and renders the Drawing Queue using those styles.
window.GameRoom = ({ roomData, tgId, socket, setProfileModal, setModal, systemConfig }) => {
    const { room, members, styles, names, photos, genders } = roomData;
    
    // -------------------------------------------------------------
    // DYNAMIC STYLING IMPLEMENTATION (Requirements 4 & 5)
    // Extract unique styles used by members in this room
    // -------------------------------------------------------------
    const activeStyleIds = members.map(m => styles[m.user_id]).filter(Boolean);
    const styleDatabase = systemConfig?.nameStyles || [];
    
    // Call the custom hook to load Fonts & CSS ONLY for these styles
    useDynamicStyles(activeStyleIds, styleDatabase);
    // -------------------------------------------------------------

    const isDrawer = room.current_drawer_id === tgId;
    const isDrawingPhase = room.status === 'DRAWING';
    const myMemberData = members.find(m => m.user_id === tgId) || {};
    
    // Top Bar Logic: Unmasking the Word
    const renderMaskedWord = () => {
        if (!room.masked_word) return <span className="text-muted fst-italic">Waiting for word...</span>;
        
        return (
            <div className="d-flex gap-1 justify-content-center flex-wrap">
                {room.masked_word.map((item, idx) => {
                    if (item.char === ' ') return <span key={idx} style={{width: '15px'}}></span>;
                    
                    const isPurchased = !isDrawer && !item.revealed && isDrawingPhase;
                    return (
                        <div key={idx} 
                             className={`letter-box d-flex align-items-center justify-content-center fw-bold fs-4 shadow-sm ${item.revealed ? 'bg-success text-white border-success' : 'bg-light text-dark border'}`}
                             style={{width: '35px', height: '40px', borderRadius: '8px', cursor: isPurchased ? 'pointer' : 'default', transition: 'all 0.2s'}}
                             onClick={() => {
                                 if (isPurchased) {
                                     if(window.confirm('Buy this letter hint for 1 Credit?')) {
                                         socket.emit('buy_hint_credit', { index: idx });
                                     }
                                 }
                             }}
                             title={isPurchased ? 'Click to reveal for 1 Credit' : ''}
                        >
                            {item.revealed ? item.char : (isPurchased ? <i className="fas fa-search-dollar text-warning fs-6 opacity-50"></i> : '')}
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="game-room w-100 mx-auto px-2 px-md-3" style={{maxWidth: '1200px'}}>
            
            {/* --- TOP HUD --- */}
            <div className="card border-0 shadow-sm rounded-4 mb-3 overflow-hidden">
                <div className="card-header bg-dark text-white p-3 d-flex justify-content-between align-items-center">
                    <div className="d-flex align-items-center gap-3">
                        <div className="bg-white bg-opacity-25 rounded-circle d-flex align-items-center justify-content-center" style={{width: '40px', height: '40px'}}>
                            <i className="fas fa-paint-brush fs-5 text-white"></i>
                        </div>
                        <div>
                            <h5 className="mb-0 fw-bold tracking-wide">ROUND {room.round || 1}</h5>
                            <span className="small opacity-75">{room.status === 'DRAWING' ? 'Guess the word!' : 'Intermission'}</span>
                        </div>
                    </div>
                    
                    {room.status === 'DRAWING' && (
                        <div className="d-flex gap-2">
                            {isDrawer ? (
                                <button className="btn btn-outline-danger btn-sm rounded-pill fw-bold bg-white" onClick={() => {
                                    if(window.confirm('Are you sure you want to give up drawing? This skips your turn.')) socket.emit('drawer_give_up');
                                }}><i className="fas fa-flag me-1"></i> Give Up</button>
                            ) : (
                                !myMemberData.has_given_up && (
                                    <button className="btn btn-outline-warning btn-sm rounded-pill fw-bold bg-dark" onClick={() => {
                                        if(window.confirm('Are you sure you want to give up guessing?')) socket.emit('guesser_give_up');
                                    }}><i className="fas fa-flag-checkered me-1"></i> Give Up</button>
                                )
                            )}
                        </div>
                    )}
                </div>

                <div className="card-body bg-white p-3 p-md-4 d-flex flex-column align-items-center justify-content-center min-h-[100px]">
                    {room.status === 'DRAWING' || room.status === 'REVEAL' ? renderMaskedWord() : (
                        <div className="text-center text-muted">
                            <i className="fas fa-ellipsis-h fs-2 mb-2 opacity-50"></i>
                            <p className="mb-0 fw-bold">Waiting for round to start...</p>
                        </div>
                    )}
                </div>
            </div>

            <div className="row g-3">
                {/* --- LEFT SIDE: QUEUE & CONTROLS --- */}
                <div className="col-12 col-lg-3 order-2 order-lg-1">
                    <div className="card border-0 shadow-sm rounded-4 mb-3">
                        <div className="card-header bg-white border-bottom p-3 d-flex justify-content-between align-items-center">
                            <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-list-ol text-primary me-2"></i> Drawing Queue</h6>
                            <span className="badge bg-primary rounded-pill">{members.length} / {room.max_members}</span>
                        </div>
                        <div className="list-group list-group-flush rounded-bottom-4 overflow-hidden">
                            {members.map((m, idx) => {
                                const isMe = m.user_id === tgId;
                                const isCurrentDrawer = m.user_id === room.current_drawer_id;
                                const displayName = window.getDisplayName(m.user_id, names);
                                // Get user's active style ID for the Queue
                                const userStyleClass = styles[m.user_id] || '';

                                return (
                                    <div key={m.user_id} 
                                         className={`list-group-item d-flex align-items-center p-3 cursor-pointer transition-all hover-bg-light ${isCurrentDrawer ? 'bg-primary bg-opacity-10 border-start border-primary border-4' : ''}`}
                                         onClick={() => setProfileModal({ 
                                             user_id: m.user_id, 
                                             pic: photos[m.user_id], 
                                             gender: genders[m.user_id] 
                                         })}
                                    >
                                        <div className="position-relative me-3 flex-shrink-0">
                                            {photos[m.user_id] ? (
                                                <img src={photos[m.user_id]} className={`rounded-circle shadow-sm ${isCurrentDrawer ? 'border border-2 border-primary p-1' : ''}`} width="40" height="40" style={{objectFit: 'cover'}} alt=""/>
                                            ) : (
                                                <div className={`rounded-circle d-flex align-items-center justify-content-center text-white fw-bold shadow-sm ${isCurrentDrawer ? 'bg-primary' : 'bg-secondary'}`} style={{width: '40px', height: '40px', fontSize: '1.2rem'}}>
                                                    {displayName.substring(0,1).toUpperCase()}
                                                </div>
                                            )}
                                            {isCurrentDrawer && <span className="position-absolute bottom-0 start-100 translate-middle badge rounded-pill bg-primary shadow"><i className="fas fa-paint-brush"></i></span>}
                                        </div>
                                        
                                        <div className="flex-grow-1 overflow-hidden">
                                            <div className="d-flex align-items-center gap-1">
                                                {/* CRITICAL: Applied equipped_style and data-name to username span in Queue */}
                                                <span className={`fw-bold text-truncate d-block ${userStyleClass}`} style={{fontSize: '0.95rem', color: isMe ? 'var(--primary)' : 'var(--text-main)'}} data-name={displayName}>
                                                    {displayName} {isMe ? '(You)' : ''}
                                                </span>
                                            </div>
                                            <div className="d-flex align-items-center gap-2 mt-1">
                                                {m.has_given_up ? <span className="badge bg-danger bg-opacity-25 text-danger border border-danger small" style={{fontSize: '0.65rem'}}>Gave Up</span> : null}
                                                {m.is_ready ? <span className="badge bg-success bg-opacity-25 text-success border border-success small" style={{fontSize: '0.65rem'}}>Ready</span> : null}
                                            </div>
                                        </div>
                                        
                                        {room.is_private === 1 && room.creator_id === tgId && !isMe && (
                                            <button className="btn btn-sm btn-outline-danger rounded-circle p-1 ms-2 flex-shrink-0" title="Kick Player" onClick={(e) => {
                                                e.stopPropagation();
                                                if(window.confirm(`Kick ${displayName} from the room?`)) {
                                                    socket.emit('kick_player', { target_id: m.user_id });
                                                }
                                            }}>
                                                <i className="fas fa-times"></i>
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {isDrawer && isDrawingPhase && (
                        <div className="card border-0 shadow-sm rounded-4 mb-3">
                            <div className="card-header bg-white border-bottom p-3">
                                <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-tools text-primary me-2"></i> Drawing Tools</h6>
                            </div>
                            <div className="card-body p-3">
                                <div className="d-flex flex-wrap gap-2 justify-content-center mb-3">
                                    <button className="btn btn-outline-secondary rounded-pill px-3 shadow-sm fw-bold" onClick={() => socket.emit('undo')} title="Undo"><i className="fas fa-undo"></i></button>
                                    <button className="btn btn-outline-secondary rounded-pill px-3 shadow-sm fw-bold" onClick={() => socket.emit('redo')} title="Redo"><i className="fas fa-redo"></i></button>
                                    <button className="btn btn-outline-danger rounded-pill px-3 shadow-sm fw-bold" onClick={() => {
                                        if(window.confirm('Clear whiteboard?')) socket.emit('clear_all');
                                    }} title="Clear All"><i className="fas fa-trash"></i></button>
                                </div>
                                
                                <div className="border-top pt-3">
                                    <label className="form-label small fw-bold text-muted mb-1"><i className="fas fa-tint me-1"></i> Ink Supply</label>
                                    <div className="progress rounded-pill bg-light border shadow-inner mb-2" style={{height: '12px'}}>
                                        <div id="inkProgressBar" className="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style={{width: '100%'}}></div>
                                    </div>
                                    <div className="d-flex justify-content-between align-items-center">
                                        <span id="inkProgressText" className="small fw-bold text-muted">Calculating...</span>
                                        <button id="buyInkBtn" className="btn btn-sm btn-warning rounded-pill shadow-sm fw-bold py-1 px-3" style={{display: 'none', fontSize: '0.75rem'}} onClick={() => socket.emit('buy_ink', { color: 'black' })}>
                                            <i className="fas fa-coins me-1"></i> Refill
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* --- RIGHT SIDE: WHITEBOARD --- */}
                <div className="col-12 col-lg-9 order-1 order-lg-2">
                    <Whiteboard 
                        roomData={roomData} 
                        tgId={tgId} 
                        socket={socket} 
                        setModal={setModal}
                        systemConfig={systemConfig}
                    />
                </div>
            </div>
        </div>
    );
};
