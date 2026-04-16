// Setup Global Variables & Configs
window.INK_CONFIG = {
    black: { free: 2500, extra: 2500, cost: 0.5 }
};

// CRITICAL FIX: Safe Initialization Check
// If Telegram's script is delayed or missing, this ensures React doesn't crash completely.
window.tg = window.Telegram?.WebApp;
if (window.tg) {
    window.tg.expand();
}

// Platform Hard Check to enforce Mobile Usage and block circumvention
window.isBlockedPlatform = false;

window.initData = window.tg?.initData || ''; 
window.tgId = window.tg?.initDataUnsafe?.user?.id?.toString() || null;
window.profilePic = window.tg?.initDataUnsafe?.user?.photo_url || '';
window.username = window.tg?.initDataUnsafe?.user?.username || 'unset';

window.toHex = (id) => id ? "0x" + Number(id).toString(16).toUpperCase().slice(-6) : '';

window.getStatusText = (status) => {
    const map = {
        'WAITING': 'Lobby Waiting',
        'PRE_DRAW': 'Choosing Word',
        'DRAWING': 'Drawing Phase',
        'REVEAL': 'Round Over',
        'BREAK': 'Intermission'
    };
    return map[status] || 'Unknown Phase';
};

window.triggerVibration = (style) => {
    if (window.Telegram?.WebApp?.HapticFeedback) {
        if (style === 'warning' || style === 'error' || style === 'success') {
            window.Telegram.WebApp.HapticFeedback.notificationOccurred(style);
        } else {
            window.Telegram.WebApp.HapticFeedback.impactOccurred(style);
        }
    }
};

// Extract hooks for App 
const { useState, useEffect, useRef, useCallback } = React;

// Extract components from window attached in prior scripts
const { LobbyView, TasksView, LeaderboardView, ProfileView, GameRoom, ModalManager, GuessBox, ChatBox } = window;


// --- Main App Component ---
const App = () => {
    const [loadingState, setLoadingState] = useState('Authenticating securely...');
    const [isAuthComplete, setIsAuthComplete] = useState(false);
    const [isDisconnected, setIsDisconnected] = useState(false);
    const [isReloading, setIsReloading] = useState(false);
    
    const [mainPageTab, setMainPageTab] = useState('home'); // Tabs: home, tasks, leaderboard, profile

    const [user, setUser] = useState(null);
    const [rooms, setRooms] = useState([]);
    const [currentRoomId, setCurrentRoomId] = useState(null);
    const [roomData, setRoomData] = useState(null);
    const [activeTab, setActiveTab] = useState('guess');
    const [panelOpen, setPanelOpen] = useState(false);
    const [glowToggle, setGlowToggle] = useState(false);
    const [modal, setModal] = useState(null);
    const [profileModal, setProfileModal] = useState(null);
    const [openAcc, setOpenAcc] = useState('volumes');
    const [soundPolicyAccepted, setSoundPolicyAccepted] = useState(false);
    
    const [socket, setSocket] = useState(null);
    
    const [unreadChat, setUnreadChat] = useState(false);
    const [unreadGuess, setUnreadGuess] = useState(false);

    // Modernized sound toggle replacing the slider
    const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('soundEnabled') !== 'false');

    const tgIdRef = useRef(window.tgId);
    const audioUnlocked = useRef(false);
    const prevChatsCount = useRef(0);
    const prevGuessesCount = useRef(0);
    const lastKnownRoomRef = useRef(null);

    const [idleTimer, setIdleTimer] = useState(30);

    useEffect(() => {
        let isMounted = true;
        
        // Failsafe handling if initData doesn't exist
        if (!window.initData) {
            setLoadingState('Please open this Mini App directly from Telegram.');
            return;
        }
        
        fetch('/api/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: window.initData })
        })
        .then(res => res.json())
        .then(data => {
            if (!isMounted) return;
            if (data.success) {
                setIsAuthComplete(true);
            } else {
                if (data.error === 'not_registered') {
                    setLoadingState('Please start the bot first! Redirecting...');
                    if (window.tg) {
                        try {
                            window.tg.openTelegramLink('https://t.me/doodledashbot?start=1');
                        } catch(e) {}
                        setTimeout(() => window.tg.close(), 500);
                    }
                } else if (data.error === 'banned') {
                    setLoadingState('You are banned. Check the bot for details. Closing...');
                    if (window.tg) {
                        setTimeout(() => window.tg.close(), 3000);
                    }
                } else {
                    setLoadingState('Authentication failed: ' + (data.error || 'Unauthorized'));
                }
            }
        })
        .catch(err => {
            if (!isMounted) return;
            setLoadingState('Network error during authentication. Check your connection.');
        });

        return () => { isMounted = false; };
    }, []);

    useEffect(() => {
        if (currentRoomId) {
            lastKnownRoomRef.current = currentRoomId;
            if (!soundPolicyAccepted && !modal) {
                setModal({ type: 'sound_policy' });
            }
        } else {
            setRoomData(null);
        }
    }, [currentRoomId, soundPolicyAccepted, modal]);

    useEffect(() => {
        let intv;
        if (modal?.type === 'idle_warning') {
            intv = setInterval(() => {
                setIdleTimer(prev => {
                    if (prev <= 1) {
                        clearInterval(intv);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
        } else {
            setIdleTimer(30);
        }
        return () => clearInterval(intv);
    }, [modal]);

    useEffect(() => {
        if (currentRoomId && roomData) {
            const isMember = roomData.members.some(m => m.user_id === tgIdRef.current);
            if (!isMember) {
                setCurrentRoomId(null);
                setRoomData(null);
            }
        }
    }, [currentRoomId, roomData]);

    useEffect(() => {
        ['mgsSound', 'guessSound'].forEach(id => {
            const s = document.getElementById(id);
            if (s) s.volume = soundEnabled ? 1.0 : 0.0;
        });
        localStorage.setItem('soundEnabled', soundEnabled);
    }, [soundEnabled]);

    const playAudioSafe = (id) => {
        if (!audioUnlocked.current && !soundPolicyAccepted) return;
        if (!soundEnabled) return;
        const el = document.getElementById(id);
        if (el) {
            el.currentTime = 0;
            const p = el.play();
            if (p !== undefined) {
                p.catch(e => console.warn('Audio blocked by browser policy:', e));
            }
        }
    };

    useEffect(() => {
        if (!roomData) return;
        
        if (roomData.chats && roomData.chats.length > prevChatsCount.current) {
            const newChats = roomData.chats.slice(prevChatsCount.current);
            if (newChats.some(c => c.user_id !== window.tgId && c.user_id !== 'System')) {
                playAudioSafe('mgsSound');
                window.triggerVibration('medium'); 
                
                if (activeTab !== 'chat' || !panelOpen) {
                    setGlowToggle(true); setTimeout(() => setGlowToggle(false), 3000);
                    setUnreadChat(true);
                }
            }
            prevChatsCount.current = roomData.chats.length;
        }

        if (roomData.guesses && roomData.guesses.length > prevGuessesCount.current) {
            const newGuesses = roomData.guesses.slice(prevGuessesCount.current);
            if (newGuesses.some(g => g.user_id !== window.tgId)) {
                playAudioSafe('guessSound');
                window.triggerVibration('light'); 
                
                if (activeTab !== 'guess' || !panelOpen) {
                    setGlowToggle(true); setTimeout(() => setGlowToggle(false), 3000);
                    setUnreadGuess(true);
                }
            }
            prevGuessesCount.current = roomData.guesses.length;
        }
    }, [roomData, activeTab, panelOpen]);

    const handleGlobalInteraction = () => {
        if (!audioUnlocked.current) {
            audioUnlocked.current = true;
            ['mgsSound', 'guessSound'].forEach(id => {
                const el = document.getElementById(id);
                if(el) {
                    el.volume = 0.01; 
                    const p = el.play();
                    if (p !== undefined) {
                        p.then(() => {
                            setTimeout(() => {
                                el.pause();
                                el.currentTime = 0;
                                el.volume = soundEnabled ? 1.0 : 0.0;
                            }, 50); 
                        }).catch(()=>{});
                    }
                }
            });
        }
    };

    useEffect(() => {
        if (!isAuthComplete) return;

        const newSocket = io({ 
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        });

        newSocket.on('connect', () => {
            setLoadingState('Connecting to server...');
            setIsDisconnected(false);
            setIsReloading(false);
            newSocket.emit('auth', { initData: window.initData });
            
            if (lastKnownRoomRef.current) {
                setTimeout(() => {
                    newSocket.emit('join_room', { room_id: lastKnownRoomRef.current });
                }, 500);
            }
        });

        newSocket.on('connect_error', (err) => {
            setLoadingState('Server connection failed. Retrying...');
            console.error('Socket error:', err);
        });

        newSocket.on('disconnect', () => {
            setIsDisconnected(true);
        });

        newSocket.on('disconnect_idle', () => {
            setIsDisconnected(true);
        });

        newSocket.on('auth_error', (msg) => {
            setLoadingState(`Auth Error: ${msg}`);
        });

        newSocket.on('lobby_data', (data) => {
            setUser(data.user);
            setRooms(data.rooms);
            setCurrentRoomId(data.currentRoom || null);
            if(!data.currentRoom) setRoomData(null);
        });
        
        newSocket.on('new_chat', (chatMsg) => {
            setRoomData(prev => {
                if (!prev) return prev;
                return { ...prev, chats: [...prev.chats, chatMsg] };
            });
        });

        newSocket.on('new_guess', (guessMsg) => {
            setRoomData(prev => {
                if (!prev) return prev;
                
                const isDrawer = prev.room.current_drawer_id === tgIdRef.current;
                const isReveal = prev.room.status === 'REVEAL' || prev.room.status === 'BREAK';
                let safeGuess = guessMsg;
                
                if (!isDrawer && guessMsg.user_id !== tgIdRef.current && !isReveal) {
                    safeGuess = { ...guessMsg, guess_text: '••••••••' };
                }
                return { ...prev, guesses: [...prev.guesses, safeGuess] };
            });
        });

        newSocket.on('lobby_rooms_update', (data) => setRooms(data));
        newSocket.on('user_update', (userData) => setUser(userData));
        newSocket.on('room_sync', (data) => setRoomData(data));
        
        newSocket.on('update_undo_redo', ({ undo_steps, redo_steps }) => {
            setRoomData(prev => {
                if (!prev) return prev;
                return { ...prev, room: { ...prev.room, undo_steps, redo_steps } };
            });
        });

        newSocket.on('kick_idle', () => {
            setModal({ type: 'error', title: 'Idle Timeout', content: 'You were removed from the room for being inactive for 1 minute.' });
            setCurrentRoomId(null);
        });

        newSocket.on('idle_warning', (data) => {
            setIdleTimer(data.timeLeft || 30);
            setModal({ type: 'idle_warning', title: 'Are you still there?' });
        });

        newSocket.on('reward_success', (msg) => setModal({ type: 'success', title: 'Success', content: msg }));
        newSocket.on('create_error', (msg) => setModal({ type: 'error', title: 'Error', content: msg }));
        newSocket.on('join_error', (msg) => setModal({ type: 'error', title: 'Cannot Join', content: msg }));
        
        newSocket.on('join_success', (roomId) => {
            setCurrentRoomId(roomId);
            setModal(null);
        });

        newSocket.on('kicked_by_admin', () => {
            setModal({ type: 'error', title: 'Kicked', content: 'You were removed from the private room by the creator.' });
            setCurrentRoomId(null);
        });

        newSocket.on('room_expired', () => {
            setModal({ type: 'error', title: 'Room Closed', content: 'The private room has expired or been deleted.' });
            setCurrentRoomId(null);
        });

        newSocket.on('room_created', ({ room_id }) => {
            setModal(null);
            newSocket.emit('search_room', { room_id }); 
        });

        newSocket.on('search_result', (room) => {
            if (room.is_private) {
                setModal({ type: 'prompt_pwd', title: 'Private Room Protected', room_id: room.id });
            } else {
                newSocket.emit('join_room', { room_id: room.id });
            }
        });

        setSocket(newSocket);
        
        const resetIdle = () => {
            if (newSocket && newSocket.connected) {
                newSocket.emit('active_event');
                setModal(prev => prev?.type === 'idle_warning' ? null : prev);
            }
        };
        window.addEventListener('mousemove', resetIdle);
        window.addEventListener('touchstart', resetIdle);
        window.addEventListener('keydown', resetIdle);

        return () => {
            window.removeEventListener('mousemove', resetIdle);
            window.removeEventListener('touchstart', resetIdle);
            window.removeEventListener('keydown', resetIdle);
            newSocket.disconnect();
        }
    }, [isAuthComplete]); 

    const [touchStartPos, setTouchStartPos] = useState(null);
    const onTouchStart = (e) => setTouchStartPos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    const onTouchEnd = (e) => {
        if (!touchStartPos) return;
        const diffX = touchStartPos.x - e.changedTouches[0].clientX;
        const diffY = touchStartPos.y - e.changedTouches[0].clientY;
        
        if (Math.abs(diffY) > Math.abs(diffX)) {
            setTouchStartPos(null);
            return;
        }

        if (diffX > 50) {
            if (activeTab === 'guess') { setActiveTab('chat'); setUnreadChat(false); }
            else if (activeTab === 'chat') { setActiveTab('sounds'); }
        } else if (diffX < -50) { 
            if (activeTab === 'sounds') { setActiveTab('chat'); setUnreadChat(false); }
            else if (activeTab === 'chat') { setActiveTab('guess'); setUnreadGuess(false); }
            else if (activeTab === 'guess') setPanelOpen(false);
        }
        setTouchStartPos(null);
    };

    if (isDisconnected) {
        return (
            <div className="container mt-5 text-center px-4">
                <div className="alert bg-white border shadow-lg py-5 rounded-4 d-flex flex-column align-items-center">
                    <i className="fas fa-plug fs-1 text-danger mb-3"></i>
                    <h4 className="fw-bold">Connection Lost</h4>
                    <p className="text-muted small mt-2">You have been disconnected from the server.</p>
                    <button className="btn btn-primary rounded-pill px-5 py-2 mt-3 fw-bold shadow-sm" disabled={isReloading} onClick={() => { 
                        setIsReloading(true); 
                        if (socket) {
                            socket.connect();
                            setTimeout(() => setIsReloading(false), 2000);
                        } else {
                            window.location.reload();
                        }
                    }}>
                        {isReloading ? <><i className="fas fa-spinner fa-spin me-2"></i> Reconnecting...</> : <><i className="fas fa-redo me-2"></i> Reconnect</>}
                    </button>
                </div>
            </div>
        );
    }

    if (!user || !socket || !isAuthComplete) {
        return (
            <div className="container mt-5 text-center px-4">
                <div className="alert alert-light border shadow-lg py-5 rounded-4 d-flex flex-column align-items-center">
                    <i className="fas fa-circle-notch fa-spin fs-1 text-primary mb-3"></i>
                    <h4 className="fw-bold">{loadingState}</h4>
                </div>
            </div>
        );
    }

    let timeLeftText = '';
    if (roomData && roomData.room.is_private && roomData.room.expire_at) {
        const timeDiff = new Date(roomData.room.expire_at).getTime() - new Date(roomData.server_time).getTime();
        if (timeDiff > 0) {
            const hoursLeft = Math.floor(timeDiff / (1000 * 60 * 60));
            const minsLeft = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
            
            if (hoursLeft === 0 && minsLeft === 0) {
                timeLeftText = '< 1m';
            } else {
                timeLeftText = `${hoursLeft > 0 ? hoursLeft + 'h ' : ''}${minsLeft > 0 ? minsLeft + 'm' : ''}`.trim();
            }
        }
    }

    const handleLoadBalance = () => {
        const link = 'https://t.me/doodledashbot?start=load_balance';
        if (window.tg && window.tg.openTelegramLink) {
            try {
                window.tg.openTelegramLink(link);
            } catch (e) {
                window.open(link, '_blank');
            }
            setTimeout(() => window.tg.close(), 300);
        } else {
            window.open(link, '_blank');
        }
    };

    return (
        <div onClick={handleGlobalInteraction} onTouchStart={handleGlobalInteraction} className="w-100 h-100 d-flex flex-column" style={{ minHeight: '100vh' }}>
            <div className="app-header flex-shrink-0">
                <h1 className="app-title"><i className="fas fa-palette"></i> DoodleDash</h1>
                <div className="badge bg-light text-dark border border-warning px-3 py-2 rounded-pill shadow-sm d-flex align-items-center">
                    <i className="fas fa-coins text-warning me-1"></i> <b className="me-2">{user.credits}</b>
                    <button className="btn btn-sm btn-link p-0 text-success m-0 lh-1" onClick={handleLoadBalance} title="Load Balance">
                        <i className="fas fa-plus-circle fs-5"></i>
                    </button>
                </div>
            </div>

            <div className="flex-grow-1 position-relative">
                {!currentRoomId ? (
                    <div style={{ paddingBottom: '80px' }}>
                        {mainPageTab === 'home' && <LobbyView user={user} rooms={rooms} setModal={setModal} socket={socket} />}
                        {mainPageTab === 'tasks' && <TasksView user={user} socket={socket} />}
                        {mainPageTab === 'leaderboard' && <LeaderboardView socket={socket} setModal={setModal} />}
                        {mainPageTab === 'profile' && <ProfileView user={user} socket={socket} setModal={setModal} />}
                        
                        <div className="bottom-nav">
                            <div className={`nav-item ${mainPageTab === 'home' ? 'active' : ''}`} onClick={() => setMainPageTab('home')}>
                                <i className="fas fa-gamepad"></i><span>Home</span>
                            </div>
                            <div className={`nav-item ${mainPageTab === 'tasks' ? 'active' : ''}`} onClick={() => setMainPageTab('tasks')}>
                                <i className="fas fa-tasks"></i><span>Tasks</span>
                            </div>
                            <div className={`nav-item ${mainPageTab === 'leaderboard' ? 'active' : ''}`} onClick={() => setMainPageTab('leaderboard')}>
                                <i className="fas fa-trophy"></i><span>Leaderboard</span>
                            </div>
                            <div className={`nav-item ${mainPageTab === 'profile' ? 'active' : ''}`} onClick={() => setMainPageTab('profile')}>
                                <i className="fas fa-user"></i><span>Profile</span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        {roomData ? (
                            <div className="container-fluid pt-3">
                                <div className="col-12 col-lg-8 mx-auto room-header p-2 mb-3">
                                    <div className="d-flex justify-content-between align-items-center w-100 border-bottom pb-2 mb-2">
                                        <div className="d-flex flex-column">
                                            <span className="small text-muted fw-bold">Room {roomData.room.id} • {roomData.room.is_private ? 'Private' : 'Public'}</span>
                                            <div className="d-flex align-items-center gap-2 mt-1">
                                                {timeLeftText ? <span className="badge bg-warning text-dark"><i className="fas fa-hourglass-half"></i> {timeLeftText}</span> : null}
                                                {timeLeftText ? <button className="btn btn-sm btn-outline-success py-1 px-2 rounded-circle shadow-none fw-bold" title="Extend Room Time" onClick={() => setModal({type: 'extend_room', title: 'Extend Room Time'})}><i className="fas fa-clock"></i></button> : null}
                                                {roomData.room.is_private === 1 && roomData.room.creator_id === window.tgId ? (
                                                    <>
                                                        <button className="btn btn-sm btn-outline-primary py-1 px-2 rounded-circle shadow-none fw-bold" title="Change Password" onClick={() => setModal({type: 'change_password', title: 'Change Room Password'})}><i className="fas fa-key"></i></button>
                                                        <button className="btn btn-sm btn-outline-danger py-1 px-2 rounded-circle shadow-none fw-bold" title="Delete Room" onClick={() => setModal({type: 'confirm_delete_room', title: 'Delete Room'})}><i className="fas fa-trash"></i></button>
                                                    </>
                                                ) : null}
                                            </div>
                                        </div>
                                        <button className="btn btn-link text-danger p-0 shadow-none" onClick={() => setModal({ type: 'confirm_leave' })}><i className="fas fa-sign-out-alt fs-5"></i></button>
                                    </div>
                                    <div className="text-center w-100">
                                    <strong className="text-primary fs-6">{window.getStatusText(roomData.room.status)}</strong>
                                    <div className="text-muted" style={{fontSize: '0.7rem'}}><i className="fas fa-users"></i> {roomData.members.length} / {roomData.room.max_members} Players</div>
                                </div>
                            </div>
                        
                            <GameRoom 
                                roomData={roomData} 
                                tgId={window.tgId} 
                                socket={socket}
                                setProfileModal={setProfileModal}
                                setModal={setModal}
                            />
                            
                            <div className={`interaction-panel ${panelOpen ? 'open' : ''}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                                    <div className={`floating-toggle ${!panelOpen && glowToggle ? 'toggle-glow' : ''}`} onClick={() => { setPanelOpen(!panelOpen); setGlowToggle(false); }}>
                                        <i className={`fas fa-chevron-${panelOpen ? 'right' : 'left'}`}></i>
                                    </div>
                                    <div className="panel-header">
                                        <div className={`panel-tab ${activeTab === 'guess' ? 'active' : ''} ${unreadGuess && activeTab !== 'guess' ? 'tab-glow' : ''}`} onClick={() => { setActiveTab('guess'); setUnreadGuess(false); }}>
                                            Guesses {unreadGuess && activeTab !== 'guess' ? <span className="ms-1 text-danger fw-bold">!</span> : null}
                                        </div>
                                        <div className={`panel-tab ${activeTab === 'chat' ? 'active' : ''} ${unreadChat && activeTab !== 'chat' ? 'tab-glow' : ''}`} onClick={() => { setActiveTab('chat'); setUnreadChat(false); }}>
                                            Chat {unreadChat && activeTab !== 'chat' ? <span className="ms-1 text-danger fw-bold">!</span> : null}
                                        </div>
                                        <div className={`panel-tab ${activeTab === 'sounds' ? 'active' : ''}`} onClick={() => setActiveTab('sounds')} title="Sound Settings"><i className="fas fa-volume-up"></i></div>
                                    </div>
                                    
                                    {activeTab === 'guess' && <GuessBox guesses={roomData.guesses} tgId={window.tgId} roomData={roomData} socket={socket} setModal={setModal} />}
                                    {activeTab === 'chat' && <ChatBox chats={roomData.chats} socket={socket} tgId={window.tgId} user={user} />}
                                    {activeTab === 'sounds' && (
                                        <div className="panel-body">
                                            <h5 className="fw-bold mb-4 text-center mt-3"><i className="fas fa-sliders-h text-primary"></i> Sound Settings</h5>
                                            
                                            <div className="accordion" id="soundAccordion">
                                                <div className="accordion-item border-0 mb-3 shadow-sm rounded-4 overflow-hidden">
                                                    <h2 className="accordion-header">
                                                        <button className="accordion-button fw-bold" type="button" onClick={() => setOpenAcc('volumes')} style={{backgroundColor: '#e0e7ff', color: 'var(--text-main)', boxShadow: 'none'}}>
                                                            <i className="fas fa-volume-up text-primary me-2"></i> Toggle Sound
                                                        </button>
                                                    </h2>
                                                    <div className="accordion-collapse collapse show">
                                                        <div className="accordion-body bg-light pb-3">
                                                            <div className="d-flex justify-content-between align-items-center mb-2 px-1">
                                                                <div>
                                                                    <label className="form-label fw-bold mb-0 text-dark">Notifications</label><br/>
                                                                    <small className="text-muted" style={{fontSize:'0.75rem'}}>Sound alerts for chats and guesses</small>
                                                                </div>
                                                                <div className="form-check form-switch fs-4 mb-0">
                                                                    <input className="form-check-input mt-0 cursor-pointer shadow-none" type="checkbox" checked={soundEnabled} onChange={e => setSoundEnabled(e.target.checked)} />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : <div className="text-center mt-5"><i className="fas fa-circle-notch fa-spin fs-2 text-primary"></i><p>Loading room data...</p></div>}
                    </>
                )}
            </div>

            <ModalManager modal={modal} setModal={setModal} socket={socket} setCurrentRoomId={setCurrentRoomId} idleTimer={idleTimer} setSoundPolicyAccepted={setSoundPolicyAccepted} />
            
            {profileModal && (
                <div className="wb-overlay" style={{zIndex: 5000, background: 'rgba(0,0,0,0.8)', position: 'fixed'}} onClick={() => { if(profileModal.full) setProfileModal(null); else setProfileModal(null); }}>
                   {!profileModal.full ? (
                       <div className="call-toast text-center" style={{maxWidth: '400px', width: '90%'}} onClick={e=>e.stopPropagation()}>
                           {profileModal.pic ? (
                               <img src={profileModal.pic} className="rounded-circle mb-3 shadow cursor-pointer border" width="100" height="100" style={{borderColor: 'var(--primary)', objectFit: 'cover'}} onClick={() => setProfileModal({...profileModal, full: true})} alt="Profile Pic"/>
                           ) : (
                               <i className="fas fa-user-circle text-secondary mb-3" style={{fontSize: '100px'}}></i>
                           )}
                           <h3 className="mb-1">{window.toHex(profileModal.user_id)}</h3>
                           <p className="text-muted small fw-bold mb-3">{profileModal.gender || 'Gender Not Set'}</p>
                           <button className="btn btn-secondary w-100 rounded-pill fw-bold mt-2" onClick={() => setProfileModal(null)}>Close Profile</button>
                       </div>
                   ) : (
                       <div className="w-100 h-100 d-flex align-items-center justify-content-center" onClick={() => setProfileModal(null)}>
                           {profileModal.pic ? <img src={profileModal.pic} style={{maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain'}} alt="Profile Full"/> : <i className="fas fa-user-circle text-secondary" style={{fontSize: '200px'}}></i>}
                       </div>
                   )}
                </div>
            )}
        </div>
    );
};

// Start React
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
