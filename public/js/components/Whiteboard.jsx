const { useState, useEffect, useRef, useCallback } = React;

let RANDOM_WORDS = ["bell","belt","bench","berry","bib","bike","bin","bird","blanket","block","blue","board","boat","bolt","bomb","bone","book","boot","bottle","bow","bowl","box","branch","bread","brick","broom","brush","bubble","bucket","bud","bug","bulb","bun","bunny","bus","bush","button","cabin","cactus","cage","cake","camel","camera","camp","can","candy","cane","canoe","cap","cape","card","carrot","cart","castle","cat","cave","chain","chair","chalk","cheese","chest","chin","chip","circle","city","claw","clay","clip","clock","cloud","club","coat","coin","comb","cone","coral","cord","cork","corn","couch","cow","crab","crown","cube","cup","curtain","cushion","dart","deer","desk","dice","dish","dock","dog","doll","door","donut","dot","dove","dragon","mat","medal","melon","mic","milk","mint","mirror","mitt","mole","money","mop","motor","mug","nail","napkin","net","nose","nut","oar","onion","orange","owl","paint","pan","panda","pants","paper","park","parrot","pasta","paw","pea","peach","pear","pen","pencil","pepper","piano","pig","pillow","pin","pine","pipe","pizza","plane","plate","plum","pocket","pond","pony","popcorn","pot","potato","pumpkin","purse","puzzle","quill","rabbit","rake","rat","ribbon","rice","ring","river","robot","rock","rocket","roller","rope","rose","ruler","saddle","salt","sand","saw","scarf","scissors","screw","seed","sheep","shell","shield","ship","shirt","shoe","shovel","sink","skate","skirt","skull","sled","slide","slime","snail","snake","sock","sofa","soil","spear","spider","spoon","spring","square","squid","star","stick","stone","stool","straw","string","stump","sugar","sun","surf","swan","swing","sword","taco","tail","tape","teapot","teddy","tent","tie","tiger","tile","tire","toast","toe","tomato","tooth","top","torch","towel","tower","toy","train","tray","tree","truck","tube","tulip","turtle","tv","umbrella","vase","vest","vine","violin","wagon","wall","wand","watch","wave","web","whale","wheat","wheel","whip","whistle","wig","wind","window","wing","wire","wolf","worm","yarn","yoyo","zebra","zipper","zombie","acorn","airplane","almond","anchor","angel","ant","apron","arm","arrow","ash","axe","badge","bag","bait","ball","bamboo","band","bank","banner","barn","barrel","basket","bat","battery","beach","bean","beard","bee","bagel","bakery","balcony","balloon","bandana","bar","bark","bath","beanbag","beehive","bicycle","blender","bonnet","bracelet","bridge","buckle","buffalo","calendar","campfire","candle","capsule","carpet","catfish","cloth","cobra","collar","compass","cookie","crate","dome","drill","drum","duck","dust","eagle","ear","egg","elbow","elk","engine","envelope","eye","fan","fang","farm","feather","fence","fern","ferry","fig","fin","fire","fish","flag","flame","flute","fly","fog","fork","fox","frame","frog","fruit","gate","gear","gem","gift","glass","glove","glue","goat","goblet","goggles","gold","goose","grape","grass","grill","guitar","hair","hammer","hand","hanger","hat","heart","hive","hook","horn","horse","hose","house","ice","ink","iron","island","jacket","jam","jar","jaw","jeep","jelly","jet","jewel","key","kite","knee","knife","ladder","lake","lamp","land","leaf","leg","lemon","letter","lid","light","lily","lime","line","lock","log","lollipop","loop","magnet","mailbox","map","mask","match","mail","dune","food","foot","girl","gun","hill","lantern","leash","ankle","anvil","applepie","armor","astronaut","avocado","bandage","banjo","beaver","blueberry","broomstick","building","calculator","calf","cherry","chimney","cloak","clover","coconut","comet","cotton","cutlass","dagger","daisy","diamond","eraser","fountain","funnel","galaxy","gamepad","ginger","goldfish","golf","grid","gum","hamster","helmet","icecream","moon","table","bed","car","rain","snow","flower","apple","banana","mango","burger","phone","marker","radio","lion","mouse","shark","penguin","squirrel","mountain","road","garden","ghost","smile","baby","bear","beetle","dolphin","donkey","elephant","flamingo","giraffe","hawk","hippo","iguana","kitten","koala","lizard","llama","monkey","moose","otter","peacock","seal","slug","turkey", "yak","arch","chess","flash","glasses","ladle","needle","nest","ocean","paddle","poster","quilt","sail","scale","spark","tank","ticket","tractor","wallet"];

fetch('/api/public/dictionary')
    .then(r => r.json())
    .then(words => { if (words && words.length > 0) RANDOM_WORDS = words; })
    .catch(e => console.error("Could not fetch custom dictionary"));

// Helper function to process intersection-based eraser refunds
const applyEraserStrokeAndGetRefund = (ctx, canvasWidth, canvasHeight, x1, y1, x2, y2) => {
    const pad = 30; // 20 (lineWidth) + 10 (shadow padding for glow removal)
    const minX = Math.floor(Math.min(x1, x2)) - pad;
    const minY = Math.floor(Math.min(y1, y2)) - pad;
    const maxX = Math.ceil(Math.max(x1, x2)) + pad;
    const maxY = Math.ceil(Math.max(y1, y2)) + pad;

    const sx = Math.max(0, minX);
    const sy = Math.max(0, minY);
    const sw = Math.min(canvasWidth - sx, maxX - sx);
    const sh = Math.min(canvasHeight - sy, maxY - sy);

    let beforeData = null;
    if (sw > 0 && sh > 0) {
        beforeData = ctx.getImageData(sx, sy, sw, sh).data;
    }

    // Execute the actual erasure on the canvas
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    let pixelsErased = 0;
    if (beforeData && sw > 0 && sh > 0) {
        const afterData = ctx.getImageData(sx, sy, sw, sh).data;
        for (let i = 3; i < beforeData.length; i += 4) {
            // Check alpha channel to see if ink was removed.
            // Require > 200 alpha to ensure lightly opaque pixels from glow effects are ignored.
            if (beforeData[i] > 200 && afterData[i] < beforeData[i]) {
                pixelsErased += (beforeData[i] - afterData[i]) / 255;
            }
        }
    }
    // Convert cleared area back to equivalent linear stroke distance (width = ~5)
    return pixelsErased / 5;
};

const Whiteboard = ({ roomData, tgId, socket, setModal, systemConfig }) => {
    const canvasRef = useRef(null);
    const [timeLeft, setTimeLeft] = useState(0); // Drawing turn timer
    const [localTimeLeft, setLocalTimeLeft] = useState(0); // Break/waiting timer
    const [preDrawTimeLeft, setPreDrawTimeLeft] = useState(30);
    const [selectedColor, setSelectedColor] = useState('black');
    const [glowEnabled, setGlowEnabled] = useState(false);
    const [glowColor, setGlowColor] = useState('#00ffff');
    
    const drawingRef = useRef(false);
    const currentLineRef = useRef([]);
    const lastPosRef = useRef({x: 0, y: 0});
    const inkUsedRef = useRef(0);
    const localInkRef = useRef({});
    const currentRefundRef = useRef(0); // Tracks exact eraser refund calculated during stroke
    
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
    const currentMaxInk = inkConfig.free + (drawerInkExtraObj['total'] || drawerInkExtraObj['black'] || 0);

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
        
        const buysMade = (drawerInkExtraObj['total'] || drawerInkExtraObj['black'] || 0) / inkConfig.extra;
        const hasMaxInk = buysMade >= inkConfig.max_buys;
        if (buyBtn) {
            buyBtn.style.display = (isDrawer && !hasMaxInk) ? 'flex' : 'none';
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
        const totalUsed = drawerInkUsedObj['total'] || drawerInkUsedObj['black'] || 0;
        localInkRef.current['total'] = totalUsed;
        inkUsedRef.current = totalUsed;
        updateInkUI();
    }, [room.status, drawerMember.ink_used, updateInkUI]);

    useEffect(() => {
        if (!socket) return;
        const handleUpdateInk = ({ used }) => {
            inkUsedRef.current = used;
            localInkRef.current['total'] = used;
            updateInkUIRef.current();
        };
        socket.on('update_ink', handleUpdateInk);
        return () => socket.off('update_ink', handleUpdateInk);
    }, [socket]);

    useEffect(() => {
        if (room.status === 'PRE_DRAW' || room.status === 'WAITING') {
            setUserReactions({});
            setSelectedColor('black');
            setGlowEnabled(false);
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

    // Drawing Phase Timer logic
    useEffect(() => {
        if (room.status === 'DRAWING' && room.round_end_time) {
            const updateTimer = () => {
                const end = new Date(room.round_end_time).getTime();
                const now = Date.now();
                const remaining = Math.max(0, Math.floor((end - now) / 1000));
                setTimeLeft(remaining);
            };
            
            updateTimer(); 
            const interval = setInterval(updateTimer, 1000);
            
            return () => clearInterval(interval);
        }
    }, [room.status, room.round_end_time]);

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

    const applyStrokeStyle = (ctx, color, glow, currentGlowColor) => {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // True Eraser Logic - configured to clean up outer glows too
        if (color === 'eraser') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.lineWidth = 20;
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.shadowBlur = 15; // Emits a soft masking shadow to beautifully wipe away surrounding stroke glows
            ctx.shadowColor = 'rgba(0,0,0,1)';
            return;
        }

        // Standard Pen Logic
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = 5;
        
        // Handle Glow
        if (glow) {
            ctx.shadowBlur = color === 'magic-mix' ? 18 : 12;
            ctx.shadowColor = currentGlowColor || '#00ffff'; 
        } else {
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
        }

        // Handle Color
        if (color === 'magic-mix') {
            const gradient = ctx.createLinearGradient(0, 0, 500, 500);
            gradient.addColorStop(0, '#ff00cc');
            gradient.addColorStop(0.5, '#3333ff');
            gradient.addColorStop(1, '#00ffcc');
            ctx.strokeStyle = gradient;
        } else {
            ctx.strokeStyle = color === 'red' ? '#dc3545' : color === 'green' ? '#2ecc71' : '#000000';
        }
    };

    const redraw = useCallback(() => {
        const canvas = canvasRef.current;
        if(!canvas) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0,0, canvas.width, canvas.height);
        
        initialDrawingsRef.current.forEach(data => {
            const c = data.color || 'black';
            const g = !!data.glow;
            const gc = data.glowColor || '#00ffff';
            const lines = data.lines;
            if (!lines) return;
            
            ctx.save();
            applyStrokeStyle(ctx, c, g, gc);
            
            ctx.beginPath();
            for (let i = 0; i < lines.length; i += 4) {
                ctx.moveTo(lines[i], lines[i+1]);
                ctx.lineTo(lines[i+2], lines[i+3]);
            }
            ctx.stroke();
            
            ctx.restore();
        });
    }, []);

    useEffect(() => {
        if (room.status === 'PRE_DRAW' || room.status === 'WAITING' || room.status === 'BREAK') {
            initialDrawingsRef.current = [];
            redraw();
        }
    }, [room.status, redraw]);

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
            let c = data.color || 'black';
            let g = !!data.glow;
            let gc = data.glowColor || '#00ffff';
            const canvas = canvasRef.current;
            if(!canvas || !lines) return;
            
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            
            ctx.save();
            applyStrokeStyle(ctx, c, g, gc);
            
            if (c === 'eraser') {
                let totalRefund = 0;
                for (let i = 0; i < lines.length; i += 4) {
                    const dist = Math.hypot(lines[i+2] - lines[i], lines[i+3] - lines[i+1]);
                    const refund = applyEraserStrokeAndGetRefund(ctx, canvas.width, canvas.height, lines[i], lines[i+1], lines[i+2], lines[i+3]);
                    // Cap the refund to what it would normally cost to draw this segment
                    totalRefund += Math.min(refund, Math.max(5, dist));
                }
                
                if (!isDrawer) {
                    // Use exact server-provided refund amount if sent to stay synchronized, otherwise recalculate
                    let appliedRefund = typeof data.refundAmount === 'number' ? data.refundAmount : totalRefund;
                    inkUsedRef.current = Math.max(0, inkUsedRef.current - appliedRefund);
                    updateInkUIRef.current();
                }
            } else {
                ctx.beginPath();
                for (let i = 0; i < lines.length; i += 4) {
                    ctx.moveTo(lines[i], lines[i+1]);
                    ctx.lineTo(lines[i+2], lines[i+3]);
                }
                ctx.stroke();
                
                if (!isDrawer) {
                    let strokeLength = 0;
                    for (let i = 0; i < lines.length; i += 4) {
                        strokeLength += Math.hypot(lines[i+2] - lines[i], lines[i+3] - lines[i+1]);
                    }
                    inkUsedRef.current += strokeLength;
                    updateInkUIRef.current();
                }
            }
            
            ctx.restore();
            
            initialDrawingsRef.current.push({ lines, color: c, glow: g, glowColor: gc, refundAmount: data.refundAmount });
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
        
        const pos = getMousePos(e);
        lastPosRef.current = pos;
        
        const tapPos = { x: pos.x + 0.1, y: pos.y + 0.1 };
        const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
        
        ctx.save();
        applyStrokeStyle(ctx, selectedColor, glowEnabled, glowColor);
        
        if (selectedColor === 'eraser') {
            const refund = applyEraserStrokeAndGetRefund(ctx, canvasRef.current.width, canvasRef.current.height, pos.x, pos.y, tapPos.x, tapPos.y);
            const actualRefund = Math.min(refund, 5); // Taps are minimal distance, allow up to 5 refund based on removed pixels
            inkUsedRef.current = Math.max(0, inkUsedRef.current - actualRefund);
            localInkRef.current['total'] = inkUsedRef.current;
            currentRefundRef.current = actualRefund; // Track exact refund directly
            updateInkUI();
        } else {
            currentRefundRef.current = 0; // Reset for drawing tools
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            ctx.lineTo(tapPos.x, tapPos.y);
            ctx.stroke();
        }
        
        ctx.restore();
        
        currentLineRef.current.push(pos.x, pos.y, tapPos.x, tapPos.y);
        lastPosRef.current = tapPos;
    };

    const moveDraw = (e) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        const newPos = getMousePos(e);
        
        const dist = Math.hypot(newPos.x - lastPosRef.current.x, newPos.y - lastPosRef.current.y);
        if (dist < 1) return; 
        
        const buysMade = (drawerInkExtraObj['total'] || drawerInkExtraObj['black'] || 0) / inkConfig.extra;
        const hasMaxInk = buysMade >= inkConfig.max_buys;
        
        // Handle Ink Capacity Checks for standard pens
        if (selectedColor !== 'eraser') {
            if (inkUsedRef.current + dist > currentMaxInkRef.current) {
                stopDraw(e); 
                if (!hasMaxInk) {
                    setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: inkConfig.cost, color: 'black' });
                }
                return;
            }
            inkUsedRef.current += dist;
        }

        const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
        
        ctx.save();
        applyStrokeStyle(ctx, selectedColor, glowEnabled, glowColor);
        
        if (selectedColor === 'eraser') {
            // Process pixel-perfect intersection refund
            const refund = applyEraserStrokeAndGetRefund(ctx, canvasRef.current.width, canvasRef.current.height, lastPosRef.current.x, lastPosRef.current.y, newPos.x, newPos.y);
            // Cap to distance to prevent farming ink from erasing heavy glow areas
            const actualRefund = Math.min(refund, dist);
            inkUsedRef.current = Math.max(0, inkUsedRef.current - actualRefund);
            currentRefundRef.current += actualRefund; // Accumulate exact stroke refund amount
        } else {
            ctx.beginPath();
            ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
            ctx.lineTo(newPos.x, newPos.y);
            ctx.stroke();
        }
        
        ctx.restore();

        localInkRef.current['total'] = inkUsedRef.current; 
        updateInkUI();
        
        currentLineRef.current.push(lastPosRef.current.x, lastPosRef.current.y, newPos.x, newPos.y);
        lastPosRef.current = newPos;
    };

    const flushDrawQueue = useCallback(() => {
        if (drawQueueRef.current.length > 0) {
            const grouped = {};
            drawQueueRef.current.forEach(cmd => {
                const key = `${cmd.color}_${cmd.glow}_${cmd.glowColor}`;
                if (!grouped[key]) grouped[key] = { lines: [], color: cmd.color, glow: cmd.glow, glowColor: cmd.glowColor, refundAmount: 0 };
                grouped[key].lines.push(...cmd.lines);
                if (cmd.color === 'eraser') {
                    grouped[key].refundAmount += (cmd.refundAmount || 0); // Aggregate total refund amount
                }
            });
            Object.values(grouped).forEach(group => {
                if (socket) socket.emit('draw', group);
            });
            drawQueueRef.current = [];
        }
        emitTimeoutRef.current = null;
    }, [socket]);

    const stopDraw = (e) => {
        if(!drawingRef.current) return;
        drawingRef.current = false;
        try { e.target.releasePointerCapture(e.pointerId); } catch(err) {}
        
        if(currentLineRef.current.length > 0) {
            drawQueueRef.current.push({ 
                lines: [...currentLineRef.current], 
                color: selectedColor, 
                glow: glowEnabled, 
                glowColor: glowColor,
                refundAmount: currentRefundRef.current || 0 
            });
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
            {/* Header toolbar for Canvas controls (Ink Level and Report Button) */}
            <div className="w-100 d-flex justify-content-between align-items-end mb-2 px-2" style={{maxWidth: '500px'}}>
                {isDrawingPhase && isDrawer && (
                    <div className="w-100">
                        <div className="d-flex justify-content-between small fw-bold mb-1">
                            <span className="text-primary"><i className="fas fa-tint"></i> Shared Ink Level</span>
                            <span id="inkProgressText" className="text-muted">{Math.floor(Math.max(0, currentMaxInkRef.current - (inkUsedRef.current || 0)))} / {currentMaxInkRef.current}</span>
                        </div>
                        <div className="d-flex align-items-center gap-2">
                            <div className="progress shadow-sm border border-light flex-grow-1" style={{height: '14px', borderRadius: '10px'}}>
                                <div id="inkProgressBar" className="progress-bar progress-bar-striped progress-bar-animated bg-primary" 
                                     style={{width: '100%', transition: 'width 0.1s'}}></div>
                            </div>
                            <button id="buyInkBtn" className="btn btn-warning rounded-circle p-0 align-items-center justify-content-center shadow-sm flex-shrink-0"
                                    style={{ width: '24px', height: '24px', display: 'none' }}
                                    onClick={() => {
                                        setModal({ type: 'confirm_buy_ink', title: 'Refill Ink', cost: inkConfig.cost, color: 'black' });
                                    }}
                                    title={`Refill Ink (${inkConfig.cost} Cred)`}>
                                <i className="fas fa-plus" style={{fontSize: '12px'}}></i>
                            </button>
                        </div>
                    </div>
                )}
                
                {room.status === 'DRAWING' && !isDrawer && (
                    <div className="w-100 d-flex justify-content-end">
                        <button 
                            className="btn btn-sm btn-outline-danger shadow-sm rounded-pill fw-bold report-drawing-btn bg-white" 
                            onClick={() => {
                                setModal({ type: 'report_input', context: 'drawing', reported_id: room.current_drawer_id, snapshot_data: JSON.stringify(initialDrawingsRef.current) });
                            }}
                            title="Report Inappropriate Drawing"
                        >
                            <i className="fas fa-flag"></i>
                        </button>
                    </div>
                )}
            </div>

            {/* Ink Color, Glow Selector & Eraser */}
            {isDrawer && isDrawingPhase && (
                <div className="d-flex flex-column mb-2 w-100 bg-white p-2 rounded shadow-sm border" style={{maxWidth: '500px'}}>
                    
                    {/* Main Palette */}
                    <div className="color-palette-scroll w-100 hide-scrollbar pb-1">
                        {/* Glow Effect Toggle */}
                        <button 
                            className={`btn rounded-circle flex-shrink-0 shadow-sm border transition ${glowEnabled ? 'btn-warning text-dark fw-bold glow-active' : 'btn-light text-secondary'}`}
                            onClick={() => setGlowEnabled(!glowEnabled)}
                            style={{ width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            title="Toggle Glow Effect"
                        >
                            <i className="fas fa-magic"></i>
                        </button>
                        
                        <div className="vr text-muted flex-shrink-0 mx-1" style={{opacity: 0.2, height: '32px'}}></div>

                        {/* Standard Color Options */}
                        <button className="btn rounded-circle p-0 transition flex-shrink-0"
                                style={{
                                    width: '32px', height: '32px', backgroundColor: '#000000', 
                                    outline: selectedColor === 'black' ? '3px solid #0d6efd' : 'none', 
                                    outlineOffset: '2px', border: '2px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }} 
                                onClick={() => setSelectedColor('black')}
                                title="Black Ink"></button>
                        <button className="btn rounded-circle p-0 transition flex-shrink-0"
                                style={{
                                    width: '32px', height: '32px', backgroundColor: '#dc3545', 
                                    outline: selectedColor === 'red' ? '3px solid #0d6efd' : 'none', 
                                    outlineOffset: '2px', border: '2px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }} 
                                onClick={() => setSelectedColor('red')}
                                title="Red Ink"></button>
                        <button className="btn rounded-circle p-0 transition flex-shrink-0"
                                style={{
                                    width: '32px', height: '32px', backgroundColor: '#2ecc71', 
                                    outline: selectedColor === 'green' ? '3px solid #0d6efd' : 'none', 
                                    outlineOffset: '2px', border: '2px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }} 
                                onClick={() => setSelectedColor('green')}
                                title="Green Ink"></button>
                        
                        {/* 1 Simplified Gradient Mix */}
                        <button className="btn rounded-circle p-0 transition magic-mix-btn flex-shrink-0"
                                style={{
                                    width: '32px', height: '32px', 
                                    outline: selectedColor === 'magic-mix' ? '3px solid #0d6efd' : 'none', 
                                    outlineOffset: '2px', border: '2px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }} 
                                onClick={() => setSelectedColor('magic-mix')}
                                title="Magic Gradient Ink"></button>
                                
                        <div className="vr text-muted flex-shrink-0 mx-1" style={{opacity: 0.2, height: '32px'}}></div>
                        
                        {/* Eraser Tool */}
                        <button className="btn rounded-circle p-0 transition flex-shrink-0 d-flex align-items-center justify-content-center"
                                style={{
                                    width: '32px', height: '32px', backgroundColor: '#f8f9fa', 
                                    outline: selectedColor === 'eraser' ? '3px solid #0d6efd' : 'none', 
                                    outlineOffset: '2px', border: '2px solid #e2e8f0', boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                                }} 
                                onClick={() => setSelectedColor('eraser')}
                                title="Eraser Tool">
                            <i className="fas fa-eraser text-secondary" style={{fontSize: '14px'}}></i>
                        </button>
                    </div>

                    {/* Secondary Conditional Glow Palette */}
                    {glowEnabled && (
                        <div className="color-palette-scroll w-100 hide-scrollbar pt-2 mt-1 border-top" style={{ borderColor: '#e2e8f0' }}>
                            <span className="small text-muted flex-shrink-0 fw-bold me-1" style={{ fontSize: '0.75rem' }}>Glow Color:</span>
                            {['#00ffff', '#ff00ff', '#39ff14', '#ffeb3b', '#ff4d4d', '#ffffff'].map(gc => (
                                <button key={gc} className="btn rounded-circle p-0 transition flex-shrink-0"
                                    style={{
                                        width: '24px', height: '24px', backgroundColor: gc,
                                        outline: glowColor === gc ? '2px solid #0d6efd' : 'none',
                                        outlineOffset: '2px', border: '1px solid #cbd5e1', boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                                    }}
                                    onClick={() => setGlowColor(gc)}
                                    title={`Glow ${gc}`}></button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="whiteboard-container" style={{ position: 'relative' }}>
                <canvas 
                    ref={canvasRef} width="500" height="500"
                    style={{ touchAction: 'none' }}
                    onPointerDown={startDraw} 
                    onPointerMove={moveDraw} 
                    onPointerUp={stopDraw} 
                    onPointerOut={stopDraw}
                    onPointerCancel={stopDraw}
                />
                
                {/* Embedded absolute Timer UI right above the canvas content */}
                {room.status === 'DRAWING' && (
                    <div 
                        style={{
                            position: 'absolute',
                            top: '8px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            backgroundColor: timeLeft <= 15 ? 'rgba(220, 53, 69, 0.9)' : 'rgba(255, 255, 255, 0.85)',
                            color: timeLeft <= 15 ? '#fff' : '#333',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontSize: '0.75rem',
                            fontWeight: 'bold',
                            pointerEvents: 'none',
                            boxShadow: '0 2px 4px rgba(0,0,0,0.15)',
                            zIndex: 10,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                    >
                        <i className="fas fa-clock"></i>{timeLeft}s
                    </div>
                )}

                {room.status === 'PRE_DRAW' && isDrawer && (
                    <div className="wb-overlay d-flex flex-column justify-content-center align-items-center w-100" style={{background: 'rgba(255,255,255,0.95)', padding: '10px'}}>
                        <h5 className="text-primary fw-bold mb-1">Your Turn!</h5>
                        <h6 className="text-danger fw-bold mb-2"><i className="fas fa-stopwatch"></i> {preDrawTimeLeft}s</h6>
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
                                        <span className="fs-5">
                                            <b className={window.getStyleClass(room.winner_style || roomData?.styles?.[room.last_winner_id], systemConfig) || ''}>
                                                {window.getDisplayName(room.last_winner_id, roomData?.names)}
                                            </b> guessed it!
                                        </span>
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
                    <button className="btn btn-sm btn-light shadow-sm rounded-pill px-2 py-1 text-secondary d-flex align-items-center gap-1 border" 
                            style={{ fontSize: '0.8rem' }}
                            onClick={() => socket.emit('undo')} 
                            disabled={(room.undo_steps || 0) === 0}
                            title="Undo">
                        <i className="fas fa-undo"></i> <span className="badge bg-secondary rounded-circle" style={{ fontSize: '0.65rem' }}>{room.undo_steps || 0}</span>
                    </button>
                    <button className="btn btn-sm btn-light shadow-sm rounded-pill px-2 py-1 text-danger d-flex align-items-center gap-1 border border-danger" 
                            style={{ fontSize: '0.8rem' }}
                            onClick={() => socket.emit('clear_all')} 
                            title="Clear All">
                        <i className="fas fa-trash-alt"></i> Clear All
                    </button>
                    <button className="btn btn-sm btn-light shadow-sm rounded-pill px-2 py-1 text-secondary d-flex align-items-center gap-1 border" 
                            style={{ fontSize: '0.8rem' }}
                            onClick={() => socket.emit('redo')} 
                            disabled={(room.redo_steps || 0) === 0}
                            title="Redo">
                        <i className="fas fa-redo"></i> <span className="badge bg-secondary rounded-circle" style={{ fontSize: '0.65rem' }}>{room.redo_steps || 0}</span>
                    </button>
                </div>
            )}
            
            {isDrawingPhase && !shouldHideReactions && (
                <div className="d-flex justify-content-center mt-3 w-100 px-3">
                    <div className="bg-white rounded-4 shadow-sm border p-2 d-flex flex-wrap gap-2 justify-content-center" style={{ maxWidth: '100%' }}>
                        {emojis.map(emoji => {
                            const count = Object.values(userReactions).filter(e => e === emoji).length;
                            const myReaction = userReactions[tgId] === emoji;
                            if (isDrawer && count === 0) return null;
                            
                            return (
                                <button key={emoji} 
                                    className={`btn rounded-circle d-flex align-items-center justify-content-center position-relative flex-shrink-0 ${myReaction ? 'bg-primary border-primary text-white shadow' : 'bg-light border-0'}`}
                                    onClick={() => sendReaction(emoji)} 
                                    title={isDrawer ? "Reactions" : (myReaction ? "Remove Reaction" : "React")}
                                    disabled={isDrawer}
                                    style={{ 
                                        width: '38px', height: '38px',
                                        transition: 'all 0.2s',
                                        transform: myReaction ? 'scale(1.15)' : 'scale(1)',
                                        opacity: 1
                                    }}>
                                    <span className="fs-5 lh-1" style={{ transform: myReaction ? 'translateY(-1px)' : 'none' }}>{emoji}</span>
                                    {count > 0 && (
                                        <span className="position-absolute translate-middle badge rounded-pill bg-danger shadow-sm border border-2 border-white" style={{ top: '2px', left: '90%', fontSize: '0.65rem', padding: '0.2em 0.4em' }}>
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

window.Whiteboard = Whiteboard;