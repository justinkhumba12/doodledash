const { useState, useEffect, useRef, useCallback } = React;

const RANDOM_WORDS = ["bell","belt","bench","berry","bib","bike","bin","bird","blanket","block","blue","board","boat","bolt","bomb","bone","book","boot","bottle","bow","bowl","box","branch","bread","brick","broom","brush","bubble","bucket","bud","bug","bulb","bun","bunny","bus","bush","button","cabin","cactus","cage","cake","camel","camera","camp","can","candy","cane","canoe","cap","cape","card","carrot","cart","castle","cat","cave","chain","chair","chalk","cheese","chest","chin","chip","circle","city","claw","clay","clip","clock","cloud","club","coat","coin","comb","cone","coral","cord","cork","corn","couch","cow","crab","crown","cube","cup","curtain","cushion","dart","deer","desk","dice","dish","dock","dog","doll","door","donut","dot","dove","dragon","mat","medal","melon","mic","milk","mint","mirror","mitt","mole","money","mop","motor","mug","nail","napkin","net","nose","nut","oar","onion","orange","owl","paint","pan","panda","pants","paper","park","parrot","pasta","paw","pea","peach","pear","pen","pencil","pepper","piano","pig","pillow","pin","pine","pipe","pizza","plane","plate","plum","pocket","pond","pony","popcorn","pot","potato","pumpkin","purse","puzzle","quill","rabbit","rake","rat","ribbon","rice","ring","river","robot","rock","rocket","roller","rope","rose","ruler","saddle","salt","sand","saw","scarf","scissors","screw","seed","sheep","shell","shield","ship","shirt","shoe","shovel","sink","skate","skirt","skull","sled","slide","slime","snail","snake","sock","sofa","soil","spear","spider","spoon","spring","square","squid","star","stick","stone","stool","straw","string","stump","sugar","sun","surf","swan","swing","sword","taco","tail","tape","teapot","teddy","tent","tie","tiger","tile","tire","toast","toe","tomato","tooth","top","torch","towel","tower","toy","train","tray","tree","truck","tube","tulip","turtle","tv","umbrella","vase","vest","vine","violin","wagon","wall","wand","watch","wave","web","whale","wheat","wheel","whip","whistle","wig","wind","window","wing","wire","wolf","worm","yarn","yoyo","zebra","zipper","zombie","acorn","airplane","almond","anchor","angel","ant","apron","arm","arrow","ash","axe","badge","bag","bait","ball","bamboo","band","bank","banner","barn","barrel","basket","bat","battery","beach","bean","beard","bee","bagel","bakery","balcony","balloon","bandana","bar","bark","bath","beanbag","beehive","bicycle","blender","bonnet","bracelet","bridge","buckle","buffalo","calendar","campfire","candle","capsule","carpet","catfish","cloth","cobra","collar","compass","cookie","crate","dome","drill","drum","duck","dust","eagle","ear","egg","elbow","elk","engine","envelope","eye","fan","fang","farm","feather","fence","fern","ferry","fig","fin","fire","fish","flag","flame","flute","fly","fog","fork","fox","frame","frog","fruit","gate","gear","gem","gift","glass","glove","glue","goat","goblet","goggles","gold","goose","grape","grass","grill","guitar","hair","hammer","hand","hanger","hat","heart","hive","hook","horn","horse","hose","house","ice","ink","iron","island","jacket","jam","jar","jaw","jeep","jelly","jet","jewel","key","kite","knee","knife","ladder","lake","lamp","land","leaf","leg","lemon","letter","lid","light","lily","lime","line","lock","log","lollipop","loop","magnet","mailbox","map","mask","match","mail","dune","food","foot","girl","gun","hill","lantern","leash","ankle","anvil","applepie","armor","astronaut","avocado","bandage","banjo","beaver","blueberry","broomstick","building","calculator","calf","cherry","chimney","cloak","clover","coconut","comet","cotton","cutlass","dagger","daisy","diamond","eraser","fountain","funnel","galaxy","gamepad","ginger","goldfish","golf","grid","gum","hamster","helmet","icecream","moon","table","bed","car","rain","snow","flower","apple","banana","mango","burger","phone","marker","radio","lion","mouse","shark","penguin","squirrel","mountain","road","garden","ghost","smile","baby","bear","beetle","dolphin","donkey","elephant","flamingo","giraffe","hawk","hippo","iguana","kitten","koala","lizard","llama","monkey","moose","otter","peacock","seal","slug","turkey", "yak","arch","chess","flash","glasses","ladle","needle","nest","ocean","paddle","poster","quilt","sail","scale","spark","tank","ticket","tractor","wallet"];

const Whiteboard = ({ roomData, tgId, socket, setModal }) => {
    const canvasRef = useRef(null);
    const [localTimeLeft, setLocalTimeLeft] = useState(0);
    const [preDrawTimeLeft, setPreDrawTimeLeft] = useState(30);
    
    const drawingRef = useRef(false);
    const currentLineRef = useRef([]);
    const lastPosRef = useRef({x: 0, y: 0});
    const inkUsedRef = useRef(0);
    const localInkRef = useRef({});
    
    const initialDrawingsRef = useRef([]);
    
    const drawQueueRef = useRef([]);
    const emitTimeoutRef = useRef(null);

    const { room, members } = roomData;
    const isDrawer = room.current_drawer_id === tgId;
    const isDrawingPhase = room.status === 'DRAWING';
    
    const isMeReady = members.find(m => m.user_id === tgId)?.is_ready;
    const readyCount = members.filter(m => m.is_ready).length;
    
    const [wordInput, setWordInput] = useState('');
    
    // Derived ink data based on drawer
    const drawerMember = members.find(m => m.user_id === room.current_drawer_id) || {};
    const drawerInkExtraObj = drawerMember.ink_extra || {};
    
    const currentMaxInk = window.INK_CONFIG.black.free + (drawerInkExtraObj['black'] || 0);

    const currentMaxInkRef = useRef(currentMaxInk);
    useEffect(() => { currentMaxInkRef.current = currentMaxInk; }, [currentMaxInk]);

    // Reactions State
    const [userReactions, setUserReactions] = useState({});
    const emojis = ['😂', '😍', '😋', '💦', '🍑', '🍆'];

    const updateInkUI = useCallback(() => {
        if (!isDrawingPhase) return;
        const max = currentMaxInkRef.current;
        const inkLeft = Math.max(0, max - inkUsedRef.current);
        const inkPercent = max > 0 ? (inkLeft / max) * 100 : 0;
        
        const bar = document.getElementById('inkProgressBar');
        const text = document.getElementById('inkProgressText');
        const buyBtn = document.getElementById('buyInkBtn');
        
        if (bar) {
            bar.style.width = `${inkPercent}%`;
            if (inkLeft <= (max * 0.2) && max > 0) {
                bar.style.backgroundColor = '';
                bar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-danger';
            } else {
                bar.style.backgroundColor = '#1e293b';
                bar.className = 'progress-bar progress-bar-striped progress-bar-animated';
            }
        }
        if (text) {
            text.className = (inkLeft <= (max * 0.2) && max > 0) ? 'text-danger fw-bold' : 'text-muted';
            text.innerText = `${Math.floor(inkLeft)} / ${max}`;
        }
        
        const hasMaxInk = (drawerInkExtraObj['black'] || 0) >= 2500;
        if (buyBtn) {
            buyBtn.style.display = (isDrawer && inkLeft <= 0 && !hasMaxInk) ? 'inline-block' : 'none';
        }
    }, [isDrawer, isDrawingPhase, drawerInkExtraObj]);

    const updateInkUIRef = useRef(updateInkUI);
    useEffect(() => { updateInkUIRef.current = updateInkUI; });

    useEffect(() => {
        if (room.status !== 'DRAWING') {
            localInkRef.current = {};
            inkUsedRef.current = 0;
            return;
        }
        // Initialize ink based on drawer state when joining phase
        const drawerInkUsedObj = drawerMember.ink_used || {};
        localInkRef.current['black'] = drawerInkUsedObj['black'] || 0;
        inkUsedRef.current = localInkRef.current['black'] || 0;
        updateInkUI();
    }, [room.status, drawerMember.ink_used, updateInkUI]);

    useEffect(() => {
        if (!socket) return;
        const handleUpdateInk = ({ color, used }) => {
            if (color === 'black') {
                inkUsedRef.current = used;
                localInkRef.current['black'] = used;
                updateInkUIRef.current();
            }
        };
        socket.on('update_ink', handleUpdateInk);
        return () => socket.off('update_ink', handleUpdateInk);
    }, [socket]);

    // Reactions cleanup and handler
    useEffect(() => {
        if (room.status === 'PRE_DRAW' || room.status === 'WAITING') {
            setUserReactions({});
        }
    }, [room.status, room.turn_index]);

    useEffect(() => {
        if (!socket) return;
        const handleReaction = ({ user_id, emoji, action }) => {
            setUserReactions(prev => {
                const next = { ...prev };
                if (action === 'remove') {
                    delete next[user_id];
                } else {
                    next[user_id] = emoji;
                }
                return next;
            });
        };
        socket.on('new_reaction', handleReaction);
        return () => socket.off('new_reaction', handleReaction);
    }, [socket]);

    const sendReaction = (emoji) => {
        if (isDrawer) return; // Drawee cannot react
        if (socket) {
            const action = userReactions[tgId] === emoji ? 'remove' : 'add';
            socket.emit('send_reaction', { emoji, action });
            // Optimistic update
            setUserReactions(prev => {
                const next = { ...prev };
                if (action === 'remove') {
                    delete next[tgId];
                } else {
                    next[tgId] = emoji;
                }
                return next;
            });
        }
    };

    useEffect(() => {
        if ((room.status === 'WAITING' || room.status === 'BREAK' || room.status === 'REVEAL') && room.break_end_time) {
            const offset = Date.now() - new Date(roomData.server_time).getTime();
            const targetTime = new Date(room.break_end_time).getTime() + offset;
            
            const updateTime = () => {
                const diff = targetTime - Date.now();
                setLocalTimeLeft(Math.max(0, Math.ceil(diff / 1000)));
            };
            updateTime();
            const intv = setInterval(updateTime, 1000);
            return () => clearInterval(intv);
        }
    }, [room.status, room.break_end_time, roomData.server_time]);

    useEffect(() => {
        if (room.status === 'PRE_DRAW' && room.round_end_time) {
            const offset = Date.now() - new Date(roomData.server_time).getTime();
            const targetTime = new Date(room.round_end_time).getTime() + offset;
            
            const updateTime = () => {
                const diff = targetTime - Date.now();
                setPreDrawTimeLeft(Math.max(0, Math.ceil(diff / 1000)));
            };
            updateTime();
            const intv = setInterval(updateTime, 1000);
            return () => clearInterval(intv);
        }
    }, [room.status, room.round_end_time, roomData.server_time]);

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
        socket.on('sync_initial_drawings', handleInitialDrawings);
        return () => socket.off('sync_initial_drawings', handleInitialDrawings);
    }, [socket, redraw]);

    useEffect(() => {
        if (!socket) return;
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
            
            // Increment ink locally for viewers to keep UI smooth
            if (!isDrawer) {
                let strokeLength = 0;
                for (let i = 0; i < lines.length; i += 4) {
                    strokeLength += Math.hypot(lines[i+2] - lines[i], lines[i+3] - lines[i+1]);
                }
                inkUsedRef.current += strokeLength;
                updateInkUIRef.current();
            }
        };
        socket.on('live_draw', handleLiveDraw);
        return () => socket.off('live_draw', handleLiveDraw);
    }, [socket, isDrawer]);

    const getMousePos = (e) => {
        const canvas = canvasRef.current;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return { 
            x: (e.clientX - rect.left) * scaleX, 
            y: (e.clientY - rect.top) * scaleY 
        };
    };

    const startDraw = (e) => {
        if (!isDrawer || !isDrawingPhase) return;
        try { e.target.setPointerCapture(e.pointerId); } catch(err) {}
        drawingRef.current = true;
        currentLineRef.current = [];
        lastPosRef.current = getMousePos(e);
    };

    const moveDraw = (e) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        const newPos = getMousePos(e);
        
        const dist = Math.hypot(newPos.x - lastPosRef.current.x, newPos.y - lastPosRef.current.y);
        if (dist < 1) return; 
        
        const hasMaxInk = (drawerInkExtraObj['black'] || 0) >= 2500;
        
        if (inkUsedRef.current + dist > currentMaxInkRef.current) {
            stopDraw(e); 
            if (!hasMaxInk) {
                setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: 0.5, color: 'black' });
            }
            return;
        }
        
        inkUsedRef.current += dist;
        localInkRef.current['black'] = inkUsedRef.current; 

        updateInkUI();
        
        const ctx = canvasRef.current.getContext('2d');
        ctx.beginPath();
        ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
        ctx.lineTo(newPos.x, newPos.y);
        ctx.strokeStyle = '#000000';
        ctx.stroke();

        currentLineRef.current.push(lastPosRef.current.x, lastPosRef.current.y, newPos.x, newPos.y);
        lastPosRef.current = newPos;
    };

    const flushDrawQueue = useCallback(() => {
        if (drawQueueRef.current.length > 0) {
            if (socket) socket.emit('draw', { lines: drawQueueRef.current });
            drawQueueRef.current = [];
        }
        emitTimeoutRef.current = null;
    }, [socket]);

    const stopDraw = (e) => {
        if(!drawingRef.current) return;
        drawingRef.current = false;
        try { e.target.releasePointerCapture(e.pointerId); } catch(err) {}
        
        if(currentLineRef.current.length > 0) {
            drawQueueRef.current.push(...currentLineRef.current);
        }
        
        if (!emitTimeoutRef.current && drawQueueRef.current.length > 0) {
            emitTimeoutRef.current = setTimeout(() => {
                flushDrawQueue();
            }, 500);
        }
    };

    return (
        <div className="w-100 d-flex flex-column align-items-center">
            {/* The Ink Level only renders for the drawer to declutter the UI */}
            {isDrawingPhase && isDrawer && (
                <div className="w-100 mb-2 px-2" style={{maxWidth: '500px'}}>
                    <div className="d-flex justify-content-between small fw-bold mb-1">
                        <span className="text-primary"><i className="fas fa-tint"></i> Ink Level</span>
                        <span id="inkProgressText" className="text-muted">{Math.floor(Math.max(0, currentMaxInkRef.current - (inkUsedRef.current || 0)))} / {currentMaxInkRef.current}</span>
                    </div>
                    <div className="progress shadow-sm border border-light" style={{height: '14px', borderRadius: '10px'}}>
                        <div id="inkProgressBar" className="progress-bar progress-bar-striped progress-bar-animated bg-primary" 
                             style={{width: '100%', transition: 'width 0.1s'}}></div>
                    </div>
                    <div className="text-center mt-3" id="buyInkBtn" style={{display: 'none'}}>
                        <button className="btn btn-sm btn-warning rounded-pill fw-bold shadow border border-warning text-dark" onClick={() => {
                            setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: 0.5, color: 'black' });
                        }}>
                            <i className="fas fa-plus-circle"></i> Refill Ink (0.5 Cred)
                        </button>
                    </div>
                </div>
            )}

            <div className="whiteboard-container">
                <canvas 
                    ref={canvasRef} width="500" height="500"
                    style={{ touchAction: 'none' }}
                    onPointerDown={startDraw} 
                    onPointerMove={moveDraw} 
                    onPointerUp={stopDraw} 
                    onPointerOut={stopDraw}
                    onPointerCancel={stopDraw}
                />
                
                {room.status === 'PRE_DRAW' && isDrawer && (
                    <div className="wb-overlay">
                        <h4 className="text-primary fw-bold">Your turn to draw!</h4>
                        <h5 className="text-danger fw-bold">{preDrawTimeLeft}s</h5>
                        <p className="text-muted small mb-0">Enter a word (3-10 characters)</p>
                        <input type="text" maxLength={10} minLength={3} className="form-control text-center my-3 w-75 rounded-pill" placeholder="Enter a word" value={wordInput} onChange={e => setWordInput(e.target.value.toUpperCase())} />
                        
                        <div className="d-flex gap-2 w-75">
                            <button className="btn btn-secondary w-50 rounded-pill shadow-sm" onClick={() => setWordInput(RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)].toUpperCase())}><i className="fas fa-random"></i> Random</button>
                            <button className="btn btn-primary w-50 rounded-pill shadow-sm" disabled={wordInput.length < 3 || wordInput.length > 10} onClick={() => socket.emit('set_word', {word: wordInput})}>Draw This!</button>
                        </div>
                    </div>
                )}
                
                {room.status === 'PRE_DRAW' && !isDrawer && (
                    <div className="wb-overlay"><h4>Drawer is choosing a word...</h4></div>
                )}

                {(room.status === 'REVEAL' || room.status === 'WAITING' || room.status === 'BREAK') && (
                    <div className="wb-overlay">
                        {room.status !== 'WAITING' && (
                            <>
                                {(room.word_to_draw && room.end_reason !== 'timeout_predraw' && room.end_reason !== 'drawer_skipped' && room.end_reason !== 'drawer_disconnected') && (
                                    <h6 className="fw-bold">The word was: <span className="text-success">{room.word_to_draw}</span></h6>
                                )}
                                
                                {room.end_reason === 'drawer_gave_up' ? (
                                    <div className="alert alert-danger mt-2 fw-bold shadow-sm">Drawer Gave Up</div>
                                ) : room.end_reason === 'all_gave_up' ? (
                                    <div className="alert alert-danger mt-2 fw-bold shadow-sm">All Players Gave Up</div>
                                ) : room.end_reason === 'timeout_predraw' ? (
                                    <div className="alert alert-danger mt-2 fw-bold shadow-sm">Drawer Skipped (Timeout)</div>
                                ) : room.end_reason === 'drawer_skipped' ? (
                                    <div className="alert alert-danger mt-2 fw-bold shadow-sm">Drawer Skipped Turn</div>
                                ) : room.end_reason === 'drawer_disconnected' ? (
                                    <div className="alert alert-danger mt-2 fw-bold shadow-sm">Drawer Disconnected</div>
                                ) : room.last_winner_id ? (
                                    <div className="alert alert-success mt-2 d-flex flex-column align-items-center gap-2 shadow-sm">
                                        {roomData.profiles[room.last_winner_id] ? (
                                            <img src={roomData.profiles[room.last_winner_id]} className="rounded-circle shadow" width="60" height="60" style={{objectFit: 'cover'}} alt="Winner"/>
                                        ) : (
                                            <i className="fas fa-user-circle fs-1 text-secondary"></i>
                                        )}
                                        <span className="fs-5"><b>{window.toHex(room.last_winner_id)}</b> guessed it!</span>
                                    </div>
                                ) : (
                                    <div className="alert alert-warning mt-2 fw-bold shadow-sm">Nobody guessed it!</div>
                                )}
                            </>
                        )}
                        
                        {isMeReady ? (
                            <h5 className="mt-4 text-muted fw-bold">
                                {members.length === 1 ? 'Waiting for players to join...' : `Waiting for others... (${readyCount}/${members.length})`}
                            </h5>
                        ) : (
                            <button className="btn btn-success rounded-pill px-5 py-2 mt-3 shadow fs-5" onClick={() => socket.emit('set_ready')}><i className="fas fa-check"></i> I'm Ready!</button>
                        )}
                    </div>
                )}
            </div>

            {isDrawer && isDrawingPhase && (
                <div className="d-flex gap-2 justify-content-center mt-3 w-100">
                    <button className="btn btn-light shadow-sm rounded-pill px-3 py-2 fw-bold text-secondary d-flex align-items-center gap-2 border" 
                            onClick={() => socket.emit('undo')} 
                            disabled={(room.undo_steps || 0) === 0}
                            title="Undo">
                        <i className="fas fa-undo"></i> <span className="badge bg-secondary rounded-circle">{room.undo_steps || 0}</span>
                    </button>
                    <button className="btn btn-light shadow-sm rounded-pill px-3 py-2 fw-bold text-danger d-flex align-items-center gap-2 border border-danger" 
                            onClick={() => socket.emit('clear_all')} 
                            title="Clear All">
                        <i className="fas fa-trash-alt"></i> Clear All
                    </button>
                    <button className="btn btn-light shadow-sm rounded-pill px-3 py-2 fw-bold text-secondary d-flex align-items-center gap-2 border" 
                            onClick={() => socket.emit('redo')} 
                            disabled={(room.redo_steps || 0) === 0}
                            title="Redo">
                        <i className="fas fa-redo"></i> <span className="badge bg-secondary rounded-circle">{room.redo_steps || 0}</span>
                    </button>
                </div>
            )}
            
            {/* Emojis Section: Modernized UI */}
            {isDrawingPhase && (
                <div className="d-flex justify-content-center mt-3 w-100 px-3">
                    <div className="bg-white rounded-pill shadow-sm border p-2 d-flex gap-3 justify-content-around" style={{ maxWidth: '100%', overflowX: 'auto' }}>
                        {emojis.map(emoji => {
                            const count = Object.values(userReactions).filter(e => e === emoji).length;
                            const myReaction = userReactions[tgId] === emoji;
                            return (
                                <button key={emoji} 
                                    className={`btn rounded-circle d-flex align-items-center justify-content-center position-relative flex-shrink-0 ${myReaction ? 'bg-primary border-primary text-white shadow' : 'bg-light border-0'}`}
                                    onClick={() => sendReaction(emoji)} 
                                    title={isDrawer ? "Reactions" : (myReaction ? "Remove Reaction" : "React")}
                                    disabled={isDrawer}
                                    style={{ 
                                        width: '48px', height: '48px',
                                        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                        transform: myReaction ? 'scale(1.15)' : 'scale(1)',
                                        opacity: isDrawer && count === 0 ? 0.4 : 1,
                                    }}>
                                    <span className="fs-3 lh-1" style={{ transform: myReaction ? 'translateY(-1px)' : 'none' }}>{emoji}</span>
                                    {count > 0 && (
                                        <span className="position-absolute translate-middle badge rounded-pill bg-danger shadow-sm border border-2 border-white" style={{ top: '5px', left: '85%', fontSize: '0.75rem' }}>
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

const ChatBox = ({ chats, profiles, socket, tgId, user }) => {
    const [input, setInput] = useState('');
    const messagesEndRef = useRef(null);
    
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chats]);

    const handleUnmute = () => {
        const botLink = `https://t.me/doodledashbot?start=unmute`;
        if (window.tg && window.tg.openTelegramLink) {
            try {
                window.tg.openTelegramLink(botLink);
                // Automatically close the mini-app so the user can interact directly with the bot
                setTimeout(() => window.tg.close(), 300);
            } catch (e) {
                window.open(botLink, '_blank');
            }
        } else {
            window.open(botLink, '_blank');
        }
    };

    return (
        <div className="d-flex flex-column h-100" style={{overflow: 'hidden'}}>
            <div className="panel-body flex-grow-1" style={{overflowY: 'auto'}}>
                {chats.map(c => (
                    <div key={c.id} className={`msg-box d-flex gap-2 ${c.user_id === 'System' ? 'sys' : ''}`} style={{ borderLeft: c.user_id === tgId ? '4px solid var(--primary)' : '' }}>
                        {c.user_id !== 'System' && (
                            profiles[c.user_id] ? <img src={profiles[c.user_id]} className="rounded-circle flex-shrink-0" width="28" height="28" style={{objectFit: 'cover'}} alt="User"/> : <i className="fas fa-user-circle fs-4 text-secondary flex-shrink-0 mt-1"></i>
                        )}
                        <div className="d-flex flex-column w-100">
                            <small className="fw-bold" style={{fontSize: '0.75rem', color: c.user_id === tgId ? 'var(--primary)' : '#64748b', lineHeight: '1'}}>
                                {c.user_id === 'System' ? 'System' : window.toHex(c.user_id)}
                            </small>
                            <span style={{marginTop: '2px'}}>{c.message}</span>
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            
            <div className="chat-input-wrapper d-flex align-items-end mt-auto gap-2" style={{padding: '10px 15px', backgroundColor: 'white', borderTop: '1px solid #e2e8f0'}}>
                {user?.status === 'mute' ? (
                    <button 
                        className="btn btn-danger w-100 rounded-pill fw-bold shadow-sm d-flex align-items-center justify-content-center gap-2"
                        style={{ height: '45px' }}
                        onClick={handleUnmute}
                    >
                        <i className="fas fa-volume-mute"></i> Unmute in Bot
                    </button>
                ) : (
                    <>
                        <textarea
                            className="form-control bg-light border-0"
                            style={{ resize: 'none', minHeight: '40px', maxHeight: '80px', borderRadius: '20px', padding: '10px 15px', overflowY: 'auto' }}
                            rows={1}
                            value={input}
                            maxLength={200}
                            placeholder="Type message..."
                            onChange={(e) => {
                                setInput(e.target.value);
                                e.target.style.height = 'auto';
                                e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (input.trim()) {
                                        socket.emit('chat', {message: input.trim()});
                                        setInput('');
                                        e.target.style.height = 'auto';
                                    }
                                }
                            }}
                        />
                        <button
                            className="btn btn-primary rounded-circle flex-shrink-0 shadow-sm"
                            style={{width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
                            onClick={() => {
                                if (input.trim()) {
                                    socket.emit('chat', {message: input.trim()});
                                    setInput('');
                                    const ta = document.querySelector('.chat-input-wrapper textarea');
                                    if (ta) ta.style.height = 'auto';
                                }
                            }}>
                            <i className="fas fa-paper-plane"></i>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

const GuessBox = ({ guesses, profiles, tgId, roomData, socket, setModal }) => {
    const [rawInput, setRawInput] = useState('');
    const isDrawer = roomData.room.current_drawer_id === tgId;
    const messagesEndRef = useRef(null);

    const myGuessesCount = guesses.filter(g => g.user_id === tgId).length;
    const isFree = myGuessesCount < 4;
    const isBlocked = myGuessesCount >= 6;
    const needsPayment = myGuessesCount === 4;

    const myMemberData = roomData.members.find(m => m.user_id === tgId);
    const hasGivenUp = myMemberData?.has_given_up;

    const totalGuessers = Math.max(0, roomData.members.length - 1);
    const givenUpCount = roomData.members.filter(m => m.user_id !== roomData.room.current_drawer_id && m.has_given_up).length;

    const wordData = (roomData.room.status === 'DRAWING' && roomData.masked_word) ? roomData.masked_word : null;
    const wordLength = wordData ? wordData.length : 10;
    const unrevealedCount = wordData ? wordData.filter(w => !w.revealed).length : wordLength;

    useEffect(() => {
        if (rawInput.length > unrevealedCount) {
            setRawInput(rawInput.slice(0, unrevealedCount));
        }
    }, [unrevealedCount, rawInput]);

    const reconstructGuess = () => {
        if (!wordData) return rawInput;
        let result = '';
        let rawIdx = 0;
        for (const item of wordData) {
            if (item.revealed) {
                result += item.char;
            } else {
                result += rawInput[rawIdx] || ' ';
                rawIdx++;
            }
        }
        return result;
    };

    const handleGuessSubmit = () => {
        if (isBlocked) return;
        if (rawInput.length !== unrevealedCount) {
            setModal({ type: 'error', title: 'Invalid Guess', content: `Please fill in all ${unrevealedCount} missing letters.`});
            return;
        }
        
        const fullGuess = reconstructGuess();

        if (needsPayment) {
            setModal({ type: 'confirm_guess_credit', guess: fullGuess, title: 'Unlock 2 Extra Guesses?' });
            setRawInput('');
        } else {
            if (socket) socket.emit('guess', {guess: fullGuess});
            setRawInput('');
        }
    };

    const handleInputChange = (e) => {
        const val = e.target.value.toUpperCase();
        if (val.length <= unrevealedCount) {
            setRawInput(val);
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [guesses]);

    return (
        <div className="d-flex flex-column h-100" style={{overflow: 'hidden'}}>
            <div className="panel-body flex-grow-1" style={{overflowY: 'auto'}}>
                {guesses.map(g => (
                    <div key={g.id} className={`msg-box d-flex gap-2 ${g.is_correct ? 'guess-correct' : 'bg-light'}`} style={{ borderLeft: g.user_id === tgId && !g.is_correct ? '4px solid var(--primary)' : '' }}>
                        {profiles[g.user_id] ? <img src={profiles[g.user_id]} className="rounded-circle flex-shrink-0" width="28" height="28" style={{objectFit: 'cover'}} alt="User"/> : <i className="fas fa-user-circle fs-4 text-secondary flex-shrink-0 mt-1"></i>}
                        <div className="d-flex flex-column w-100">
                            <small className="fw-bold" style={{fontSize: '0.75rem', color: g.user_id === tgId ? 'var(--primary)' : '#64748b', lineHeight: '1'}}>
                                {window.toHex(g.user_id)}
                            </small>
                            <span style={{marginTop: '2px'}}>{g.guess_text}</span>
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>
            
            {roomData.room.status === 'DRAWING' || roomData.room.status === 'PRE_DRAW' ? (
                <div className="chat-input-wrapper d-flex flex-column mt-auto pb-3">
                    <button 
                        className={`btn mb-2 rounded-pill shadow-sm fw-bold ${hasGivenUp ? 'btn-secondary text-light' : 'btn-warning text-dark'}`} 
                        onClick={() => {
                            setModal({ type: isDrawer ? 'confirm_drawer_give_up' : 'confirm_guesser_give_up', title: 'Confirm Give Up' });
                        }}
                        disabled={!isDrawer && hasGivenUp}
                    >
                        <i className="fas fa-flag"></i> 
                        {isDrawer ? 'Give Up Turn' : (hasGivenUp ? `Voted Give Up (${givenUpCount}/${totalGuessers})` : 'Give Up Round')}
                    </button>

                    {roomData.room.status === 'DRAWING' && (!isDrawer && !hasGivenUp) ? (
                        <div className="d-flex w-100 align-items-center bg-light rounded-pill p-1 shadow-sm position-relative border" style={{height: '42px'}}>
                            <div className="flex-grow-1 position-relative d-flex justify-content-center align-items-center h-100" style={{overflow: 'hidden'}}>
                                
                                {/* Box-by-Box Overlay */}
                                <div className="d-flex gap-1 h-100 position-absolute pointer-events-none w-100 px-2 justify-content-center" style={{zIndex: 1, pointerEvents: 'none'}}>
                                    {wordData ? (
                                        (() => {
                                            let rawIdx = 0;
                                            return wordData.map((item, i) => {
                                                let displayChar = '';
                                                let isHint = item.revealed;
                                                let showCursor = false;
                                                if (isHint) {
                                                    displayChar = item.char;
                                                } else {
                                                    displayChar = rawInput[rawIdx] || '';
                                                    if (rawIdx === rawInput.length && !isBlocked) showCursor = true;
                                                    rawIdx++;
                                                }
                                                return (
                                                    <div key={i} className={`d-flex align-items-center justify-content-center fw-bold fs-5 bg-white border rounded shadow-sm position-relative ${isHint ? 'text-success bg-light' : 'text-dark'}`} style={{width: '32px', height: '100%', borderColor: '#cbd5e1'}}>
                                                        {displayChar}
                                                        {showCursor && <span className="position-absolute" style={{ animation: 'blink 1s step-end infinite', borderRight: '2px solid #1e293b', height: '60%' }}></span>}
                                                    </div>
                                                );
                                            })
                                        })()
                                    ) : (
                                        Array.from({length: wordLength}).map((_, i) => {
                                            const showCursor = (i === rawInput.length) && !isBlocked;
                                            return (
                                                <div key={i} className="d-flex align-items-center justify-content-center fw-bold fs-5 bg-white border rounded shadow-sm position-relative" style={{width: '32px', height: '100%', borderColor: '#cbd5e1', color: '#1e293b'}}>
                                                    {rawInput[i] || ''}
                                                    {showCursor && <span className="position-absolute" style={{ animation: 'blink 1s step-end infinite', borderRight: '2px solid #1e293b', height: '60%' }}></span>}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                                
                                {/* Hidden Input that captures key presses seamlessly */}
                                <input type="text"
                                    className="form-control position-absolute w-100 h-100 border-0 bg-transparent text-transparent"
                                    style={{opacity: 0, zIndex: 10, cursor: 'text'}}
                                    value={rawInput}
                                    onChange={handleInputChange}
                                    onKeyPress={e => e.key === 'Enter' && handleGuessSubmit()}
                                    maxLength={unrevealedCount}
                                    disabled={isBlocked}
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />
                            </div>
                            <button className={`btn ${needsPayment ? 'btn-success' : 'btn-primary'} rounded-pill ms-2 px-3 h-100`} style={{zIndex: 11}} onClick={handleGuessSubmit} disabled={isBlocked || rawInput.length !== unrevealedCount}>
                                {needsPayment ? <i className="fas fa-unlock"></i> : <i className="fas fa-paper-plane"></i>}
                            </button>
                        </div>
                    ) : null}
                    
                    {!isDrawer && !hasGivenUp && isBlocked && (
                        <div className="text-danger fw-bold text-center small mt-1">Max 6 guesses reached.</div>
                    )}
                </div>
            ) : null}
        </div>
    );
};

const GameRoom = ({ roomData, tgId, socket, setProfileModal, setModal }) => {
    const { room, members } = roomData;
    const sortedMembers = [...members].sort((a, b) => a.joined_at - b.joined_at);

    return (
        <div className="row">
            <div className="col-12 col-lg-8 mx-auto">
                <div className="whiteboard-wrapper">
                    
                    {(roomData.room.status === 'DRAWING' && roomData.masked_word) ? (
                    <div className="w-100 d-flex flex-wrap justify-content-center gap-2 mb-3 bg-light p-2 rounded-pill shadow-sm">
                        {roomData.masked_word.map((item, i) => (
                            <div 
                                key={i}
                                className={`d-flex align-items-center justify-content-center rounded shadow-sm fw-bold fs-5 ${item.revealed ? 'bg-success text-white hint-reveal' : 'bg-secondary text-white cursor-pointer'}`}
                                style={{ width: '35px', height: '35px', transition: '0.2s' }}
                                onClick={() => {
                                    if (!item.revealed && roomData.room.current_drawer_id !== tgId) {
                                        setModal({ type: 'confirm_buy_hint', index: item.index });
                                    }
                                }}
                                title={!item.revealed && roomData.room.current_drawer_id !== tgId ? "Click to reveal (1 Credit)" : ""}
                            >
                                {item.revealed ? item.char : '?'}
                            </div>
                        ))}
                    </div>
                ) : null}

                <Whiteboard roomData={roomData} tgId={tgId} socket={socket} setModal={setModal} />

                    <div className="mt-4 w-100">
                        <h6 className="fw-bold text-secondary mb-3">Drawing Queue</h6>
                        {sortedMembers.map(m => {
                            return (
                                <div key={m.user_id} className="d-flex align-items-center justify-content-between p-2 bg-white shadow-sm rounded mb-2 border-start border-4" style={{borderColor: room.current_drawer_id === m.user_id ? 'var(--primary)' : 'transparent'}}>
                                    <div className="d-flex align-items-center">
                                        <div onClick={() => setProfileModal({user_id: m.user_id, pic: roomData.profiles[m.user_id], gender: roomData.genders?.[m.user_id]})} className="cursor-pointer">
                                            {roomData.profiles[m.user_id] ? <img src={roomData.profiles[m.user_id]} className="rounded-circle me-2" width="35" height="35" style={{objectFit: 'cover'}} alt="Player"/> : <i className="fas fa-user-circle fs-2 text-secondary me-2"></i>}
                                        </div>
                                        <div className="d-flex flex-column">
                                            <span className="fw-bold">{window.toHex(m.user_id)} {m.user_id === tgId ? ' (You)' : ''}</span>
                                            <div className="d-flex align-items-center gap-1">
                                                {m.has_given_up ? <span className="badge bg-warning text-dark shadow-sm" style={{fontSize: '0.65rem'}}><i className="fas fa-flag"></i> Gave Up</span> : null}
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className="d-flex align-items-center gap-2">
                                        {m.is_ready ? <i className="fas fa-check-circle text-success fs-5 shadow-sm" title="Ready"></i> : null}
                                        {(room.is_private === 1 && room.creator_id === tgId && m.user_id !== tgId) ? (
                                            <button className="btn btn-sm btn-danger rounded-circle shadow-sm" onClick={() => setModal({type: 'kick_player', target_id: m.user_id, title: 'Remove Player'})} title="Remove Player"><i className="fas fa-user-times"></i></button>
                                        ) : null}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Expose to window for the main app
window.Whiteboard = Whiteboard;
window.ChatBox = ChatBox;
window.GuessBox = GuessBox;
window.GameRoom = GameRoom;
