const { useState } = React;

const ModalManager = ({ modal, setModal, socket, setCurrentRoomId, idleTimer, setSoundPolicyAccepted, systemConfig, roomData }) => {
    const [pwd, setPwd] = useState('');
    const [expireMinutes, setExpireMinutes] = useState(30);
    const [adLoading, setAdLoading] = useState(false);
    const [reason, setReason] = useState('');

    // Extracted state for maintenance modal hook safety
    const [maintTimeLeft, setMaintTimeLeft] = useState('');
    const [maintIsOver, setMaintIsOver] = useState(false);

    React.useEffect(() => {
        let intv;
        if (modal?.type === 'maintenance') {
            intv = setInterval(() => {
                const diff = new Date(Number(modal.end_time)) - new Date();
                if (diff <= 0) {
                    setMaintIsOver(true);
                    setMaintTimeLeft('');
                } else {
                    const h = Math.floor(diff / 1000 / 60 / 60);
                    const m = Math.floor((diff / 1000 / 60) % 60);
                    const s = Math.floor((diff / 1000) % 60);
                    setMaintTimeLeft(`${h > 0 ? h + 'h ' : ''}${m}m ${s}s`);
                    setMaintIsOver(false);
                }
            }, 1000);
        }
        return () => clearInterval(intv);
    }, [modal?.type, modal?.end_time]);

    // Client-Side Timer Logic for PRE_DRAW phase
    const [preDrawTimeLeft, setPreDrawTimeLeft] = useState(30);
    React.useEffect(() => {
        let intv;
        if (roomData?.status === 'PRE_DRAW' && roomData?.round_end_time) {
            const updateTimer = () => {
                const end = new Date(roomData.round_end_time).getTime();
                const diff = Math.max(0, Math.ceil((end - Date.now()) / 1000));
                setPreDrawTimeLeft(diff);
            };
            updateTimer(); 
            intv = setInterval(updateTimer, 1000);
        }
        return () => { if (intv) clearInterval(intv); };
    }, [roomData?.status, roomData?.round_end_time]);

    const close = () => { setModal(null); setPwd(''); setExpireMinutes(30); setReason(''); };

    // robust display name resolution prioritizing explicitly passed fallbackName (modal.name) over other lookups.
    const getDisplayName = (id, fallbackName, fallbackUsername) => {
        if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim() !== '' && fallbackName.toLowerCase() !== 'unset') {
            return fallbackName;
        }
        if (roomData?.names && roomData.names[id]) {
            return roomData.names[id];
        }
        if (window.getDisplayName) {
             const resolvedName = window.getDisplayName(id, roomData?.names);
             if (resolvedName !== (window.toHex ? window.toHex(id) : id)) {
                 return resolvedName;
             }
        }
        if (fallbackUsername && typeof fallbackUsername === 'string' && fallbackUsername.trim() !== '' && fallbackUsername.toLowerCase() !== 'unset') {
            return fallbackUsername;
        }
        return window.toHex ? window.toHex(id) : (id || 'Unknown');
    };

    const triggerHintAd = (index) => {
        setAdLoading(true);
        if (typeof window.show_10812134 !== 'function') {
            socket.emit('buy_hint_ad', { index });
            setAdLoading(false);
            return;
        }
        window.show_10812134({ ymid: window.tgId || 'unknown' }).then(() => {
            socket.emit('buy_hint_ad', { index });
            setAdLoading(false);
        }).catch(e => {
            setAdLoading(false);
            setTimeout(() => setModal({ type: 'error', title: 'Ad Error', content: 'Ad failed to load or skipped.' }), 100);
        });
    };

    const isPreDrawDrawer = roomData?.status === 'PRE_DRAW' && String(roomData?.current_drawer_id) === String(window.tgId);

    let content = null;
    let title = modal?.title || 'Notice';

    if (modal) {
        if (modal.type === 'maintenance') {
            title = 'Server Maintenance';
            content = (
                <div className="text-center py-3">
                    <i className="fas fa-tools fs-1 text-warning mb-3"></i>
                    <h5 className="fw-bold">Server Maintenance</h5>
                    {maintIsOver ? (
                        <p className="text-muted small mb-4">Wait for sometime... Admin is trying hard for your better experience. It'll be finished soon.</p>
                    ) : (
                        <>
                            <p className="text-muted small mb-2">The server is undergoing maintenance. Please come back later.</p>
                            <h3 className="fw-bold text-danger mb-4">{maintTimeLeft}</h3>
                        </>
                    )}
                    <div className="d-flex flex-column gap-2 mt-4">
                        <button className="btn btn-danger w-100 rounded-pill fw-bold" onClick={() => {
                            if (socket && setCurrentRoomId) {
                                socket.emit('leave_room');
                                setCurrentRoomId(null);
                            }
                            close();
                        }}>Exit Room</button>
                        <button className="btn btn-secondary w-100 rounded-pill fw-bold" onClick={close}>Close Window</button>
                    </div>
                </div>
            );
        } else if (modal.type === 'sound_policy') {
            title = 'Enable Sound?';
            content = (
                <div className="text-center py-3">
                    <i className="fas fa-volume-up fs-1 text-primary mb-3"></i>
                    <h5 className="fw-bold text-dark">Enable Sound?</h5>
                    <p className="text-muted small mb-4">Accept sound policy to trigger enable auto play sound for messages and guesses.</p>
                    <button className="btn btn-primary w-100 rounded-pill py-2 fw-bold" onClick={() => {
                        const mgsSound = document.getElementById('mgsSound');
                        if (mgsSound) {
                            mgsSound.volume = 0.5;
                            mgsSound.play().catch(()=>{});
                        }
                        if (setSoundPolicyAccepted) setSoundPolicyAccepted(true);
                        close();
                    }}>Accept</button>
                </div>
            );
        } else if (modal.type === 'leaderboard_rules') {
            title = 'Leaderboard Rules';
            content = (
                <>
                    <h6 className="fw-bold text-dark"><i className="fas fa-info-circle text-primary"></i> Leaderboard Rules</h6>
                    <div className="small text-muted text-start mt-3 ps-1">
                        {modal.activeTab === 'inviters' && (
                            <p className="mb-2"><b>Top Inviters:</b> Resets every week. The top 5 inviters receive an automated message from the bot to claim their credits (1 Friend = 1 Credit).</p>
                        )}
                        {modal.activeTab === 'guessers' && (
                            <p className="mb-2"><b>Top Guessers:</b> Resets every week. Showcases players with the most correct guesses! In case of a tie, the player who reached the score first is ranked higher.</p>
                        )}
                        {modal.activeTab === 'donators' && (
                            <p className="mb-2"><b>Top Donators:</b> All-time list of our generous supporters! Refreshes immediately on new donations.</p>
                        )}
                        <p className="mb-0"><b>Usernames:</b> If your username shows as 'unset', please update it in your Telegram profile.</p>
                    </div>
                    <button className="btn btn-secondary w-100 rounded-pill mt-4" onClick={close}>Close</button>
                </>
            );
        } else if (modal.type === 'idle_warning') {
            title = 'Are you still there?';
            content = (
                <div className="text-center py-3">
                    <i className="fas fa-user-clock fs-1 text-warning mb-3"></i>
                    <p className="text-muted small">You've been idle for a while.</p>
                    <h1 className="text-danger fw-bold display-4 my-3">{idleTimer}s</h1>
                    <button className="btn btn-primary w-100 rounded-pill py-2 shadow-sm fw-bold" onClick={() => {
                        socket.emit('active_event');
                        close();
                    }}>Confirm</button>
                </div>
            );
        } else if (modal.type === 'success' || modal.type === 'error') {
            content = (
                <>
                    <div className="mb-4 text-muted">{modal.content}</div>
                    <button className={`btn btn-${modal.type === 'success' ? 'success' : 'danger'} w-100 rounded-pill`} onClick={close}>Close</button>
                </>
            );
        } else if (modal.type === 'round_reveal') {
            title = 'Round Ended!';
            content = (
                <div className="text-center py-2 animate__animated animate__fadeIn">
                    <h4 className="fw-bold text-dark mb-4">
                        WORD: <span className="text-success text-uppercase">{modal.correct_word || '?'}</span>
                    </h4>
                    
                    {modal.round_leaderboard && modal.round_leaderboard.length > 0 ? (
                        <div className="leaderboard-list d-flex flex-column gap-2 mx-auto" style={{maxWidth: '350px'}}>
                            {modal.round_leaderboard.map((entry, idx) => {
                                const displayName = getDisplayName(entry.user_id, roomData?.names?.[entry.user_id], roomData?.usernames?.[entry.user_id]);
                                const photo = roomData?.photos?.[entry.user_id];
                                const styleClass = window.getStyleClass(roomData?.styles?.[entry.user_id], systemConfig) || 'text-dark';
                                return (
                                    <div key={entry.user_id} className="d-flex align-items-center justify-content-between p-2 bg-light rounded shadow-sm border border-light">
                                        <div className="d-flex align-items-center gap-2">
                                            <div className="fw-bold text-secondary small" style={{width: '18px'}}>{idx + 1}.</div>
                                            {photo ? (
                                                <img src={photo} className="rounded-circle border" width="28" height="28" style={{objectFit: 'cover'}} alt="Player"/>
                                            ) : (
                                                <i className="fas fa-user-circle text-secondary bg-white rounded-circle" style={{fontSize: '28px'}}></i>
                                            )}
                                            <span className={`fw-bold ${styleClass} small`} style={{fontSize: '0.85rem'}}>{displayName}</span>
                                        </div>
                                        <span className="badge bg-success rounded-pill px-2 py-1 shadow-sm" style={{fontSize: '0.75rem'}}>+{entry.points} pts</span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="p-3 bg-light rounded text-muted fw-bold small">No points were awarded this round.</div>
                    )}
                    <button className="btn btn-primary w-100 rounded-pill mt-4 py-2 fw-bold" onClick={close}>Close</button>
                </div>
            );
        } else if (modal.type === 'create_room') {
            const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
            const roomLimits = systemConfig?.roomLimits || defaultRoomLimits;
            const timeOptions = roomLimits.timeOptions || defaultRoomLimits.timeOptions;
            
            let activeTimeOption = timeOptions.find(o => o.minutes === expireMinutes);
            if (!activeTimeOption && timeOptions.length > 0) {
                activeTimeOption = timeOptions[0];
            }

            let baseRoomCost = (Number(roomLimits.privateBaseCost) || 0) + (activeTimeOption ? Number(activeTimeOption.cost) : 0); 

            content = (
                <>
                    <div className="mb-4 text-center">
                        <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-lock text-danger me-2"></i>Create Private Room</h6>
                        <small className="text-muted">A password is required for private rooms</small>
                    </div>

                    <input type="text" inputMode="numeric" pattern="[0-9]*" className="form-control mb-3 text-center fw-bold fs-5 prominent-input" placeholder="Numeric Password (6-10 digits)..." value={pwd} onChange={e => {
                        const val = e.target.value.replace(/[^0-9]/g, '');
                        setPwd(val.slice(0, 10));
                    }} />

                    <div className="mb-3">
                        <label className="form-label text-muted small mb-2 fw-bold"><i className="fas fa-users text-primary me-1"></i> Max Players</label>
                        <div className="alert alert-info py-2 small mb-0 shadow-sm border border-info">
                            <i className="fas fa-info-circle me-1"></i> Private rooms hold up to <b>{roomLimits.privateMax}</b> players.
                        </div>
                    </div>

                    <div className="mb-3">
                        <label className="form-label text-muted small mb-2 fw-bold"><i className="fas fa-clock text-primary me-1"></i> Room Duration</label>
                        <div className="d-flex flex-wrap gap-2">
                            {timeOptions.map((opt, idx) => {
                                const isSelected = activeTimeOption?.minutes === opt.minutes;
                                return (
                                    <div key={idx}
                                         className={`flex-fill text-center border rounded-3 py-2 cursor-pointer ${isSelected ? 'bg-primary border-primary text-white shadow-sm' : 'bg-white text-muted border-light shadow-sm'}`}
                                         onClick={() => setExpireMinutes(opt.minutes)} style={{transition: 'all 0.2s', minWidth: '40%'}}>
                                        <div className="fw-bold fs-6">{opt.minutes} mins</div>
                                        <div style={{fontSize:'0.75rem', opacity: isSelected ? 0.9 : 0.6}}>{opt.cost} Cred{opt.cost !== 1 ? 's' : ''}</div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    <div className="alert alert-warning py-2 small mb-3 fw-bold d-flex justify-content-between">
                        <span><i className="fas fa-coins text-warning me-1"></i> Total Cost:</span>
                        <span>{baseRoomCost} Credits</span>
                    </div>

                    <div className="d-flex gap-2">
                        <button className="btn btn-light w-50 rounded-pill fw-bold border" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill fw-bold shadow-sm" disabled={pwd.length < 6 || pwd.length > 10} onClick={() => { 
                            socket.emit('create_room', { 
                                is_private: true, 
                                password: pwd, 
                                expire_minutes: activeTimeOption ? activeTimeOption.minutes : 30, 
                                auto_join: true 
                            }); 
                            close(); 
                        }}>Create</button>
                    </div>
                </>
            );
        } else if (modal.type === 'change_password') {
            content = (
                <>
                    <p className="text-muted small">Set a new numeric password (6-10 digits).</p>
                    <input type="text" inputMode="numeric" pattern="[0-9]*" className="form-control mb-3 text-center fw-bold fs-5 prominent-input" placeholder="New Numeric Password" value={pwd} onChange={e => setPwd(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))} />
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill" disabled={pwd.length < 6 || pwd.length > 10} onClick={() => { socket.emit('change_password', { password: pwd }); close(); }}>Change</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_delete_room') {
            content = (
                <>
                    <p className="text-muted text-center mb-4">Are you sure you want to delete this room? Everyone will be kicked and it cannot be undone.</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('delete_room'); close(); }}>Delete</button>
                    </div>
                </>
            );
        } else if (modal.type === 'prompt_pwd') {
            content = (
                <>
                    <p className="text-muted small mb-3">This room is private. Please enter the numeric password to join.</p>
                    <input type="text" inputMode="numeric" pattern="[0-9]*" className="form-control mb-3 text-center fw-bold fs-5 prominent-input" placeholder="Numeric Password" value={pwd} onChange={e => setPwd(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))} />
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill" disabled={pwd.length < 6 || pwd.length > 10} onClick={() => { socket.emit('join_room', { room_id: modal.room_id, password: pwd }); close(); }}>Join</button>
                    </div>
                </>
            );
        } else if (modal.type === 'item_description') {
            title = modal.itemType === 'gems' ? 'Gems Package' : 'Credits Package';
            content = (
                <div className="text-center py-2">
                    <i className={`fas ${modal.itemType === 'gems' ? 'fa-gem text-info' : 'fa-coins text-warning'} fs-1 mb-3`}></i>
                    <h4 className="fw-bold mb-2">{modal.itemType === 'gems' ? `${modal.pkg.gems} Gems` : `${modal.pkg.credits} Credits`}</h4>
                    <p className="text-muted small mb-4">
                        {modal.itemType === 'gems' 
                            ? `This package grants you ${modal.pkg.gems} Gems, which can be exchanged for Credits to be used in the game.`
                            : `Exchange ${modal.pkg.gems} Gems to receive ${modal.pkg.credits} Credits instantly!`
                        }
                    </p>
                    {modal.itemType === 'gems' ? (
                        <button className="btn btn-primary w-100 rounded-pill fw-bold py-2 shadow-sm" onClick={() => setModal({ type: 'confirm_buy_gems', pkg: modal.pkg })}>
                            Purchase for {modal.pkg.stars} Stars
                        </button>
                    ) : (
                        <button className={`btn w-100 rounded-pill fw-bold py-2 shadow-sm ${modal.canAfford ? 'btn-success' : 'btn-secondary'}`} disabled={!modal.canAfford} onClick={() => modal.canAfford && setModal({ type: 'confirm_exchange_gems', pkg: modal.pkg })}>
                            {modal.canAfford ? `Exchange for ${modal.pkg.gems} Gems` : `Not enough Gems (${modal.pkg.gems} required)`}
                        </button>
                    )}
                </div>
            );
        } else if (modal.type === 'confirm_buy_gems') {
            title = 'Confirm Purchase';
            content = (
                <div className="text-center py-2">
                    <h5 className="fw-bold mb-3">Buy {modal.pkg.gems} Gems?</h5>
                    <p className="text-muted small mb-4">You will be redirected to Telegram to complete the purchase of {modal.pkg.gems} Gems for {modal.pkg.stars} Stars.</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill fw-bold" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill fw-bold" onClick={() => {
                            close();
                            const botLink = `https://t.me/doodledashbot?start=buygems_${modal.pkg.stars}`;
                            if (window.tg && window.tg.openTelegramLink) {
                                try { window.tg.openTelegramLink(botLink); } catch (e) { window.open(botLink, '_blank'); }
                            } else {
                                window.open(botLink, '_blank');
                            }
                        }}>Proceed</button>
                    </div>
                </div>
            );
        } else if (modal.type === 'confirm_exchange_gems') {
            title = 'Confirm Exchange';
            content = (
                <div className="text-center py-2">
                    <h5 className="fw-bold mb-3">Exchange {modal.pkg.gems} Gems?</h5>
                    <p className="text-muted small mb-4">Are you sure you want to exchange {modal.pkg.gems} Gems for {modal.pkg.credits} Credits?</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill fw-bold" onClick={close}>Cancel</button>
                        <button className="btn btn-success w-50 rounded-pill fw-bold" onClick={() => {
                            socket.emit('exchange_gems', { package_id: modal.pkg.id });
                            close();
                        }}>Confirm</button>
                    </div>
                </div>
            );
        } else if (modal.type === 'confirm_leave') {
            title = 'Leave Room?';
            content = (
                <>
                    <p className="text-muted text-center mb-4">Are you sure you want to leave this room?</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { 
                            socket.emit('leave_room'); 
                            setCurrentRoomId(null); 
                            close(); 
                        }}>Leave</button>
                    </div>
                </>
            );
        } else if (modal.type === 'extend_room') {
            const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
            const roomLimits = systemConfig?.roomLimits || defaultRoomLimits;
            const timeOptions = roomLimits.timeOptions || defaultRoomLimits.timeOptions;
            
            let activeTimeOption = timeOptions.find(o => o.minutes === expireMinutes);
            if (!activeTimeOption && timeOptions.length > 0) {
                activeTimeOption = timeOptions[0];
            }

            let baseRoomCost = (Number(roomLimits.privateBaseCost) || 0) + (activeTimeOption ? Number(activeTimeOption.cost) : 0);

            title = 'Extend Room Time';
            content = (
                <>
                    <div className="mb-3 text-center">
                        <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-clock text-success me-2"></i>Extend Private Room</h6>
                        <small className="text-muted">Add more time to your private room before it expires.</small>
                    </div>

                    <div className="mb-3">
                        <label className="form-label text-muted small mb-2 fw-bold"><i className="fas fa-hourglass-half text-primary me-1"></i> Extension Duration</label>
                        <div className="d-flex flex-wrap gap-2">
                            {timeOptions.map((opt, idx) => {
                                const isSelected = activeTimeOption?.minutes === opt.minutes;
                                return (
                                    <div key={idx}
                                         className={`flex-fill text-center border rounded-3 py-2 cursor-pointer ${isSelected ? 'bg-primary border-primary text-white shadow-sm' : 'bg-white text-muted border-light shadow-sm'}`}
                                         onClick={() => setExpireMinutes(opt.minutes)} style={{transition: 'all 0.2s', minWidth: '40%'}}>
                                        <div className="fw-bold fs-6">{opt.minutes} mins</div>
                                        <div style={{fontSize:'0.75rem', opacity: isSelected ? 0.9 : 0.6}}>{opt.cost} Cred{opt.cost !== 1 ? 's' : ''}</div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    <div className="alert alert-warning py-2 small mb-4 fw-bold d-flex justify-content-between">
                        <span><i className="fas fa-coins text-warning me-1"></i> Total Cost:</span>
                        <span>{baseRoomCost} Credits</span>
                    </div>

                    <div className="d-flex gap-2">
                        <button className="btn btn-light w-50 rounded-pill fw-bold border" onClick={close}>Cancel</button>
                        <button className="btn btn-success w-50 rounded-pill fw-bold shadow-sm" onClick={() => { 
                            socket.emit('extend_room', { expire_minutes: activeTimeOption ? activeTimeOption.minutes : 30 }); 
                            close(); 
                        }}>Extend</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_buy_ink') {
            content = (
                <>
                    <p className="text-center text-muted mb-4">Refill your black ink for <b>{modal.cost} Credits</b>?</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('buy_ink', { color: modal.color }); close(); }}>Buy</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_buy_hint') {
            title = 'Reveal Letter';
            content = (
                <>
                    <p className="text-center text-muted mb-4">Reveal this letter to help you guess?</p>
                    <div className="d-flex flex-column gap-2">
                        <button className="btn btn-primary w-100 rounded-pill fw-bold" onClick={() => { socket.emit('buy_hint_credit', { index: modal.index }); close(); }}>Use 1 Credit</button>
                        <button className="btn btn-outline-primary w-100 rounded-pill fw-bold" onClick={() => triggerHintAd(modal.index)} disabled={adLoading}>
                            {adLoading ? <span className="spinner-border spinner-border-sm me-2"></span> : <i className="fas fa-play-circle me-1"></i>} 
                            Watch Ad (Free)
                        </button>
                        <button className="btn btn-light w-100 rounded-pill text-muted border mt-2" onClick={close}>Cancel</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_guess_credit') {
            content = (
                <>
                    <p className="text-center text-muted mb-3">You've used your 4 free guesses. Unlock 2 more guesses for <b>1 Credit</b>?</p>
                    <div className="alert alert-warning py-2 small mb-3 text-center">Your guess: <b>{modal.guess}</b></div>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-success w-50 rounded-pill" onClick={() => { socket.emit('buy_guess', { guess: modal.guess }); close(); }}>Unlock & Guess</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_name_change') {
            title = 'Change Name';
            content = (
                <>
                    <p className="text-center text-muted mb-3">Set your display name to <b>{modal.name}</b>?</p>
                    {!modal.isFirstTime && <div className="alert alert-warning py-2 small mb-3 text-center">This will cost <b>5 Credits</b>.</div>}
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('set_name', { name: modal.name }); close(); }}>Confirm</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_gender_change') {
            title = 'Change Gender';
            content = (
                <>
                    <p className="text-center text-muted mb-3">Set your gender to <b>{modal.gender}</b>?</p>
                    {!modal.isFirstTime && <div className="alert alert-warning py-2 small mb-3 text-center">This will cost <b>5 Credits</b>.</div>}
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('set_gender', { gender: modal.gender }); close(); }}>Confirm</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_drawer_give_up') {
            content = (
                <>
                    <p className="text-center text-muted mb-4">Are you sure you want to give up your turn? You will lose points.</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('drawer_give_up'); close(); }}>Give Up</button>
                    </div>
                </>
            );
        } else if (modal.type === 'confirm_guesser_give_up') {
            content = (
                <>
                    <p className="text-center text-muted mb-4">Are you sure you want to give up this round? If all guessers give up, the round ends.</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('guesser_give_up'); close(); }}>Give Up</button>
                    </div>
                </>
            );
        } else if (modal.type === 'report_input') {
            title = 'Report User';
            content = (
                <>
                    <p className="text-muted small mb-2">Please describe why you are reporting this user.</p>
                    <textarea className="form-control mb-1" rows="3" maxLength={250} placeholder="Reason..." value={reason} onChange={e => setReason(e.target.value)}></textarea>
                    <div className="text-end small text-muted mb-3">{250 - reason.length} characters left</div>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" disabled={!reason.trim()} onClick={() => { 
                            socket.emit('report_user', { reported_id: modal.reported_id, reason, context: modal.context, snapshot_data: modal.snapshot_data }); 
                            close(); 
                            setModal({type: 'success', title: 'Report Submitted', content: 'Thank you. Our moderators will review this.'});
                        }}>Submit</button>
                    </div>
                </>
            );
        } else if (modal.type === 'chat_action') {
            title = 'Message Options';
            
            // Properly load user's equipped style or fallback to roomData style mapping
            const styleClass = window.getStyleClass(modal.message.equipped_style || roomData?.styles?.[modal.message.user_id], systemConfig) || 'text-dark';
            
            // Ensure name extraction uses proper order of properties available
            const id = modal.message.user_id;
            const name = modal.message.name;
            const username = modal.message.username;
            const displayMsgName = getDisplayName(id, name, username);
            
            content = (
                <div className="d-flex flex-column gap-2">
                    <div className="mb-3 text-center">
                        <div className="small text-muted mb-1">Message from:</div>
                        <div className={`fw-bold fs-5 ${styleClass}`} data-name={displayMsgName}>{displayMsgName}</div>
                    </div>
                    {modal.message.user_id !== window.tgId && (
                        <button className="btn btn-danger rounded-pill w-100 fw-bold" onClick={() => setModal({ type: 'report_input', context: 'chat', reported_id: modal.message.user_id, snapshot_data: modal.message.message })}>
                            <i className="fas fa-flag me-2"></i> Report Message
                        </button>
                    )}
                    {modal.isCreator && (
                        <button className="btn btn-warning text-dark rounded-pill w-100 fw-bold" onClick={() => { socket.emit('delete_chat_message', { message_id: modal.message.id }); close(); }}>
                            <i className="fas fa-trash me-2"></i> Delete (Creator)
                        </button>
                    )}
                    <button className="btn btn-secondary rounded-pill w-100 fw-bold" onClick={close}>Cancel</button>
                </div>
            );
        } else if (modal.type === 'confirm_clear_chat') {
            title = 'Clear Chat History';
            content = (
                <>
                    <p className="text-muted text-center mb-4">Are you sure you want to delete all messages in this room?</p>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('clear_chat_history'); close(); }}>Clear All</button>
                    </div>
                </>
            );
        } else if (modal.type === 'kick_player') {
            title = 'Kick Player';
            const styleClass = window.getStyleClass(modal.style, systemConfig) || 'text-dark';

            // Extracting name for kick player based on what gets passed in
            const id = modal.target_id;
            const name = modal.target_name || modal.name;
            const username = modal.target_username || modal.username;
            const displayTargetName = getDisplayName(id, name, username);

            content = (
                <>
                    <div className="mb-4 text-center">
                        <p className="text-muted mb-2">Remove this player from the room?</p>
                        <div className={`fw-bold fs-4 ${styleClass}`} data-name={displayTargetName}>{displayTargetName}</div>
                    </div>
                    <div className="d-flex gap-2">
                        <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                        <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('kick_player', { target_id: modal.target_id }); close(); }}>Kick</button>
                    </div>
                </>
            );
        } else if (modal.type === 'profile_view') {
            title = 'Player Profile';
            const styleClass = window.getStyleClass(modal.style, systemConfig) || 'text-dark';
            
            // Use user.name or modal values consistently
            const id = modal.user_id || modal.tg_id;
            const name = modal.name;
            const username = modal.username || modal.display_name;
            const displayName = getDisplayName(id, name, username);

            content = (
                <div className="d-flex flex-column align-items-center justify-content-center py-2 text-center">
                    {modal.pic ? (
                        <img src={modal.pic} className="rounded-circle shadow-sm border mb-3" width="80" height="80" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Profile" />
                    ) : (
                        <i className="fas fa-user-circle text-secondary mb-3 shadow-sm rounded-circle bg-white" style={{fontSize: '80px', color: 'var(--primary)'}}></i>
                    )}
                    <div className="w-100 d-flex flex-column align-items-center">
                        <h4 className={`fw-bold mb-1 ${styleClass}`} style={{wordBreak: 'break-word'}} data-name={displayName}>{displayName}</h4>
                        <div className="text-muted small mb-4 mt-1">
                            {window.renderGenderIcon(modal.gender)} {modal.gender || 'Not Set'}
                        </div>
                    </div>
                    <button className="btn btn-secondary w-100 rounded-pill mt-2" onClick={close}>Close</button>
                </div>
            );
        }
    }

    return (
        <>
            {/* Seamless Visual Overlay Timer For Word Selection Phase */}
            {isPreDrawDrawer && (
                <div style={{ position: 'fixed', top: '15%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1040, background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)', color: '#fff', padding: '12px 24px', borderRadius: '30px', fontWeight: 'bold', fontSize: '1.25rem', boxShadow: '0 8px 20px rgba(0,0,0,0.3)', border: '2px solid #f59e0b', display: 'flex', alignItems: 'center', gap: '10px', animation: 'fadeInDown 0.3s ease-out', pointerEvents: 'none' }}>
                    <i className={`fas fa-hourglass-half ${preDrawTimeLeft <= 10 ? 'text-danger fa-spin' : 'text-warning'}`}></i>
                    <span className={preDrawTimeLeft <= 10 ? 'text-danger' : 'text-white'}>
                        Time to choose: {preDrawTimeLeft}s
                    </span>
                </div>
            )}

            {modal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1050, background: 'rgba(0,0,0,0.6)', overflowY: 'auto' }} onPointerDown={(e) => { if(e.target === e.currentTarget && modal.type !== 'maintenance' && modal.type !== 'idle_warning' && modal.type !== 'sound_policy') close(); }}>
                    <div style={{ display: 'flex', minHeight: '100%', padding: '2rem 1rem', alignItems: 'center', justifyContent: 'center' }} onPointerDown={(e) => { if(e.target === e.currentTarget && modal.type !== 'maintenance' && modal.type !== 'idle_warning' && modal.type !== 'sound_policy') close(); }}>
                        <div className="modal-dialog m-0 w-100" style={{ maxWidth: '400px' }} onPointerDown={(e) => e.stopPropagation()}>
                            <div className="modal-content border-0 shadow-lg rounded-4 overflow-hidden w-100 bg-white" style={{ animation: 'slideUp 0.3s ease-out' }}>
                                {modal.type !== 'maintenance' && modal.type !== 'idle_warning' && modal.type !== 'sound_policy' && (
                                    <div className="modal-header border-0 pb-0 d-flex justify-content-between align-items-center p-3">
                                        <h5 className="modal-title fw-bold text-dark m-0">{title}</h5>
                                        <button type="button" className="btn-close shadow-none" onClick={close}></button>
                                    </div>
                                )}
                                <div className="modal-body p-4 bg-white">
                                    {content}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );

};

window.ModalManager = ModalManager;