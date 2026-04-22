const { useState, useEffect, useRef, useCallback } = React;

let RANDOM_WORDS = ["bell","belt","bench","berry","bib","bike","bin","bird","blanket","block","blue","board","boat","bolt","bomb","bone","book","boot","bottle","bow","bowl","box","branch","bread","brick","broom","brush","bubble","bucket","bud","bug","bulb","bun","bunny","bus","bush","button","cabin","cactus","cage","cake","camel","camera","camp","can","candy","cane","canoe","cap","cape","card","carrot","cart","castle","cat","cave","chain","chair","chalk","cheese","chest","chin","chip","circle","city","claw","clay","clip","clock","cloud","club","coat","coin","comb","cone","coral","cord","cork","corn","couch","cow","crab","crown","cube","cup","curtain","cushion","dart","deer","desk","dice","dish","dock","dog","doll","door","donut","dot","dove","dragon","mat","medal","melon","mic","milk","mint","mirror","mitt","mole","money","mop","motor","mug","nail","napkin","net","nose","nut","oar","onion","orange","owl","paint","pan","panda","pants","paper","park","parrot","pasta","paw","pea","peach","pear","pen","pencil","pepper","piano","pig","pillow","pin","pine","pipe","pizza","plane","plate","plum","pocket","pond","pony","popcorn","pot","potato","pumpkin","purse","puzzle","quill","rabbit","rake","rat","ribbon","rice","ring","river","robot","rock","rocket","roller","rope","rose","ruler","saddle","salt","sand","saw","scarf","scissors","screw","seed","sheep","shell","shield","ship","shirt","shoe","shovel","sink","skate","skirt","skull","sled","slide","slime","snail","snake","sock","sofa","soil","spear","spider","spoon","spring","square","squid","star","stick","stone","stool","straw","string","stump","sugar","sun","surf","swan","swing","sword","taco","tail","tape","teapot","teddy","tent","tie","tiger","tile","tire","toast","toe","tomato","tooth","top","torch","towel","tower","toy","train","tray","tree","truck","tube","tulip","turtle","tv","umbrella","vase","vest","vine","violin","wagon","wall","wand","watch","wave","web","whale","wheat","wheel","whip","whistle","wig","wind","window","wing","wire","wolf","worm","yarn","yoyo","zebra","zipper","zombie","acorn","airplane","almond","anchor","angel","ant","apron","arm","arrow","ash","axe","badge","bag","bait","ball","bamboo","band","bank","banner","barn","barrel","basket","bat","battery","beach","bean","beard","bee","bagel","bakery","balcony","balloon","bandana","bar","bark","bath","beanbag","beehive","bicycle","blender","bonnet","bracelet","bridge","buckle","buffalo","calendar","campfire","candle","capsule","carpet","catfish","cloth","cobra","collar","compass","cookie","crate","dome","drill","drum","duck","dust","eagle","ear","egg","elbow","elk","engine","envelope","eye","fan","fang","farm","feather","fence","fern","ferry","fig","fin","fire","fish","flag","flame","flute","fly","fog","fork","fox","frame","frog","fruit","gate","gear","gem","gift","glass","glove","glue","goat","goblet","goggles","gold","goose","grape","grass","grill","guitar","hair","hammer","hand","hanger","hat","heart","hive","hook","horn","horse","hose","house","ice","ink","iron","island","jacket","jam","jar","jaw","jeep","jelly","jet","jewel","key","kite","knee","knife","ladder","lake","lamp","land","leaf","leg","lemon","letter","lid","light","lily","lime","line","lock","log","lollipop","loop","magnet","mailbox","map","mask","match","mail","dune","food","foot","girl","gun","hill","lantern","leash","ankle","anvil","applepie","armor","astronaut","avocado","bandage","banjo","beaver","blueberry","broomstick","building","calculator","calf","cherry","chimney","cloak","clover","coconut","comet","cotton","cutlass","dagger","daisy","diamond","eraser","fountain","funnel","galaxy","gamepad","ginger","goldfish","golf","grid","gum","hamster","helmet","icecream","moon","table","bed","car","rain","snow","flower","apple","banana","mango","burger","phone","marker","radio","lion","mouse","shark","penguin","squirrel","mountain","road","garden","ghost","smile","baby","bear","beetle","dolphin","donkey","elephant","flamingo","giraffe","hawk","hippo","iguana","kitten","koala","lizard","llama","monkey","moose","otter","peacock","seal","slug","turkey", "yak","arch","chess","flash","glasses","ladle","needle","nest","ocean","paddle","poster","quilt","sail","scale","spark","tank","ticket","tractor","wallet"];

fetch('/api/public/dictionary')
    .then(r => r.json())
    .then(words => { if (words && words.length > 0) RANDOM_WORDS = words; })
    .catch(e => console.error("Could not fetch custom dictionary"));

const Whiteboard = ({ roomData, tgId, socket, setModal, systemConfig }) => {
    const canvasRef = useRef(null);
    const [localTimeLeft, setLocalTimeLeft] = useState(0);
    
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

    const [userReactions, setUserReactions] = useState({});
    
    const emojis = ['😂', '😍', '😋', '💦', '🍑', '🍆', '🔥', '💀', '💯', '🤔', '😡', '👀', '🎉', '💩', '🤡', '😭'];

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
        
        const buysMade = (drawerInkExtraObj['black'] || 0) / inkConfig.extra;
        const hasMaxInk = buysMade >= inkConfig.max_buys;
        if (buyBtn) {
            buyBtn.style.display = (isDrawer && inkLeft <= 0 && !hasMaxInk) ? 'inline-block' : 'none';
        }
    }, [isDrawer, isDrawingPhase, drawerInkExtraObj, inkConfig]);

    const updateInkUIRef = useRef(updateInkUI);
    useEffect(() => { updateInkUIRef.current = updateInkUI; });

    const currentMaxInkRef = useRef(currentMaxInk);
    useEffect(() => { 
        currentMaxInkRef.current = currentMaxInk; 
        if (updateInkUIRef.current) updateInkUIRef.current();
    }, [currentMaxInk]);

    useEffect(() => {
        if (room.status !== 'DRAWING') {
            localInkRef.current = {};
            inkUsedRef.current = 0;
            return;
        }
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
        if (isDrawer) return;
        if (socket) {
            const action = userReactions[tgId] === emoji ? 'remove' : 'add';
            socket.emit('send_reaction', { emoji, action });
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
        
        const buysMade = (drawerInkExtraObj['black'] || 0) / inkConfig.extra;
        const hasMaxInk = buysMade >= inkConfig.max_buys;
        
        if (inkUsedRef.current + dist > currentMaxInkRef.current) {
            stopDraw(e); 
            if (!hasMaxInk) {
                setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: inkConfig.cost, color: 'black' });
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

    const activeReactionCount = Object.values(userReactions).length;
    const shouldHideReactions = isDrawer && activeReactionCount === 0;

    return (
        <div className="w-100 d-flex flex-column align-items-center">
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
                            setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: inkConfig.cost, color: 'black' });
                        }}>
                            <i className="fas fa-plus-circle"></i> Refill Ink ({inkConfig.cost} Cred)
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
                
                {room.status === 'DRAWING' && !isDrawer && (
                    <button 
                        className="btn btn-light text-danger shadow-sm rounded-circle position-absolute" 
                        style={{top: '10px', right: '10px', zIndex: 100, width: '36px', height: '36px'}}
                        onClick={() => {
                            setModal({ type: 'report_input', context: 'drawing', reported_id: room.current_drawer_id, snapshot_data: JSON.stringify(initialDrawingsRef.current) });
                        }}
                        title="Report Inappropriate Drawing"
                    >
                        <i className="fas fa-flag"></i>
                    </button>
                )}
                
                {room.status === 'PRE_DRAW' && isDrawer && (
                    <div className="wb-overlay d-flex flex-column justify-content-center align-items-center w-100" style={{background: 'rgba(255,255,255,0.95)', padding: '10px'}}>
                        <h5 className="text-primary fw-bold mb-3">Your Turn!</h5>
                        <div className="w-100 px-2 text-center">
                            <label className="small fw-bold text-muted mb-1">Word to draw (3-10 chars)</label>
                            <div className="input-group input-group-sm mb-2">
                                <input type="text" maxLength={10} minLength={3} className="form-control text-center fw-bold text-dark" placeholder="Enter word" value={wordInput} onChange={e => setWordInput(e.target.value.toUpperCase())} style={{letterSpacing: '1px'}} />
                                {wordInput && <button className="btn btn-outline-secondary btn-sm" onClick={() => setWordInput('')}><i className="fas fa-times"></i></button>}
                            </div>
                            <div className="d-flex gap-2 justify-content-center">
                                <button className="btn btn-outline-primary btn-sm rounded-pill shadow-sm fw-bold flex-grow-1" onClick={() => setWordInput(RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)].toUpperCase())}><i className="fas fa-dice me-1"></i> Random</button>
                                <button className="btn btn-success btn-sm rounded-pill shadow-sm fw-bold flex-grow-1" disabled={wordInput.length < 3 || wordInput.length > 10} onClick={() => socket.emit('set_word', {word: wordInput})}><i className="fas fa-paint-brush me-1"></i> Start</button>
                            </div>
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
                                        {(roomData?.photos?.[room.last_winner_id]) ? (
                                            <img src={roomData.photos[room.last_winner_id]} className="rounded-circle shadow border" width="60" height="60" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Winner"/>
                                        ) : (
                                            <i className="fas fa-user-circle text-secondary bg-white rounded-circle shadow-sm" style={{fontSize: '60px'}}></i>
                                        )}
                                        <span className="fs-5"><b>{window.getDisplayName(room.last_winner_id, roomData?.names)}</b> guessed it!</span>
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
                        ) : maintActive ? (
                            <button className="btn btn-secondary rounded-pill px-5 py-2 mt-3 shadow fs-5" onClick={() => setModal({ type: 'maintenance', end_time: maintEndTime })}><i className="fas fa-tools"></i> Server Maintenance</button>
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
