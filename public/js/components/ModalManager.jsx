const { useState } = React;

const ModalManager = ({ modal, setModal, socket, setCurrentRoomId, idleTimer, setSoundPolicyAccepted }) => {
    const [pwd, setPwd] = useState('');
    const [isPriv, setIsPriv] = useState(false);
    const [maxMembers, setMaxMembers] = useState(6);
    const [expireHours, setExpireHours] = useState(0.5);
    const [adLoading, setAdLoading] = useState(false);
    const [reason, setReason] = useState('');
    
    if (!modal) return null;

    const close = () => { setModal(null); setPwd(''); setIsPriv(false); setMaxMembers(6); setExpireHours(0.5); setReason(''); };

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

    let content = null;
    let title = modal.title || 'Notice';

    if (modal.type === 'maintenance') {
        title = 'Server Maintenance';
        const [timeLeft, setTimeLeft] = useState('');
        const [isOver, setIsOver] = useState(false);
        
        React.useEffect(() => {
            const intv = setInterval(() => {
                const diff = new Date(Number(modal.end_time)) - new Date();
                if (diff <= 0) {
                    setIsOver(true);
                    setTimeLeft('');
                } else {
                    const h = Math.floor(diff / 1000 / 60 / 60);
                    const m = Math.floor((diff / 1000 / 60) % 60);
                    const s = Math.floor((diff / 1000) % 60);
                    setTimeLeft(`${h > 0 ? h + 'h ' : ''}${m}m ${s}s`);
                    setIsOver(false);
                }
            }, 1000);
            return () => clearInterval(intv);
        }, [modal.end_time]);

        content = (
            <div className="text-center py-3">
                <i className="fas fa-tools fs-1 text-warning mb-3"></i>
                <h5 className="fw-bold">Server Maintenance</h5>
                {isOver ? (
                    <p className="text-muted small mb-4">Wait for sometime... Admin is trying hard for your better experience. It'll be finished soon.</p>
                ) : (
                    <>
                        <p className="text-muted small mb-2">The server is undergoing maintenance. Please come back later.</p>
                        <h3 className="fw-bold text-danger mb-4">{timeLeft}</h3>
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
    } else if (modal.type === 'create_room') {
        let baseRoomCost = isPriv ? maxMembers : 0; 
        content = (
            <>
                <div className="d-flex justify-content-between align-items-center p-3 mb-3 border rounded-3 bg-light" onClick={() => setIsPriv(!isPriv)} style={{cursor: 'pointer'}}>
                    <div>
                        <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-lock text-danger me-2"></i>Private Room</h6>
                        <small className="text-muted">Require password</small>
                    </div>
                    <div className="form-check form-switch fs-4 mb-0">
                        <input className="form-check-input mt-0 cursor-pointer shadow-none" type="checkbox" checked={isPriv} readOnly />
                    </div>
                </div>

                {isPriv ? (
                    <>
                        <input type="text" className="form-control mb-3" placeholder="Set Password (6-10 chars)..." value={pwd} onChange={e => setPwd(e.target.value)} />
                        
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-2 fw-bold"><i className="fas fa-users text-primary me-1"></i> Max Players (1 Cred / Player)</label>
                            <div className="d-flex gap-1 flex-wrap">
                                {[2, 3, 4, 5, 6].map(num => (
                                    <div key={num}
                                         className={`flex-fill text-center border rounded-3 py-1 cursor-pointer ${maxMembers === num ? 'bg-primary border-primary text-white shadow-sm' : 'bg-white text-muted border-light shadow-sm'}`}
                                         onClick={() => setMaxMembers(num)} style={{transition: 'all 0.2s', minWidth: '45px'}}>
                                        <div className="fw-bold fs-6">{num}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-2 fw-bold"><i className="fas fa-clock text-primary me-1"></i> Room Duration</label>
                            <div className="d-flex gap-2">
                                {[0.5, 1].map(hours => (
                                    <div key={hours}
                                         className={`flex-fill text-center border rounded-3 py-1 cursor-pointer ${expireHours === hours ? 'bg-primary border-primary text-white shadow-sm' : 'bg-white text-muted border-light shadow-sm'}`}
                                         onClick={() => setExpireHours(hours)} style={{transition: 'all 0.2s'}}>
                                        <div className="fw-bold fs-6">{hours === 0.5 ? '30' : '1'} <span style={{fontSize:'0.7rem'}}>{hours === 0.5 ? 'mins' : 'hr'}</span></div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-1 fw-bold">Max Players</label>
                            <div className="w-100 text-center border rounded-3 py-2 bg-light text-muted">
                                <div className="fw-bold fs-5">6</div>
                                <div style={{fontSize: '0.65rem'}}>Players (Fixed)</div>
                            </div>
                        </div>
                        <div className="alert alert-success py-2 small mb-3 shadow-sm border border-success">
                            <i className="fas fa-check-circle me-1"></i> Creating a public room is FREE!<br/>
                            <span className="text-muted" style={{fontSize: '0.75rem'}}>* Anyone can join for free</span>
                        </div>
                    </>
                )}

                {(isPriv) && (
                    <div className="alert alert-warning py-2 small mb-3 fw-bold d-flex justify-content-between">
                        <span><i className="fas fa-coins text-warning me-1"></i> Total Cost:</span>
                        <span>{baseRoomCost} Credits</span>
                    </div>
                )}

                <div className="d-flex gap-2">
                    <button className="btn btn-light w-50 rounded-pill fw-bold border" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill fw-bold shadow-sm" disabled={isPriv && (pwd.length < 6 || pwd.length > 10)} onClick={() => { 
                        socket.emit('create_room', { 
                            is_private: isPriv, 
                            password: pwd, 
                            max_members: isPriv ? maxMembers : 6, 
                            expire_hours: expireHours, 
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
                <p className="text-muted small">Set a new password (6-10 characters).</p>
                <input type="text" className="form-control mb-3" placeholder="New Password..." value={pwd} onChange={e => setPwd(e.target.value)} />
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
                <p className="text-muted small mb-3">This room is private. Please enter the password to join.</p>
                <input type="text" className="form-control mb-3 text-center fw-bold" placeholder="Password" value={pwd} onChange={e => setPwd(e.target.value)} />
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill" disabled={!pwd} onClick={() => { socket.emit('join_room', { room_id: modal.room_id, password: pwd }); close(); }}>Join</button>
                </div>
            </>
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
        content = (
            <>
                <div className="alert alert-info py-2 small mb-3">Extending adds 30 minutes. Cost: 5 Credits.</div>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-success w-50 rounded-pill" onClick={() => { socket.emit('extend_room'); close(); }}>Extend</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_buy_ink') {
        content = (
            <>
                <p className="text-center text-muted mb-4">Refill your black ink by 2500 units for <b>{modal.cost} Credits</b>?</p>
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
                    <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('update_profile', { name: modal.name }); close(); }}>Confirm</button>
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
                    <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('update_profile', { gender: modal.gender }); close(); }}>Confirm</button>
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
                    }}>Submit Report</button>
                </div>
            </>
        );
    } else if (modal.type === 'chat_action') {
        title = 'Message Options';
        content = (
            <div className="d-flex flex-column gap-2">
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
        content = (
            <>
                <p className="text-muted text-center mb-4">Remove this player from the room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('kick_player', { target_id: modal.target_id }); close(); }}>Kick</button>
                </div>
            </>
        );
    }

    return (
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
    );
};

window.ModalManager = ModalManager;
