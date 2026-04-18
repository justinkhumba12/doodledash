const { useState } = React;

const ModalManager = ({ modal, setModal, socket, setCurrentRoomId, idleTimer, setSoundPolicyAccepted }) => {
    if (!modal) return null;
    const [pwd, setPwd] = useState('');
    const [isPriv, setIsPriv] = useState(false);
    const [maxMembers, setMaxMembers] = useState(6);
    const [expireHours, setExpireHours] = useState(0.5);
    
    const [adLoading, setAdLoading] = useState(false);

    const close = () => { setModal(null); setPwd(''); setIsPriv(false); setMaxMembers(6); setExpireHours(0.5); };

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
    if (modal.type === 'sound_policy') {
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
                <p className="text-muted">Enter password to join Room {modal.room_id}</p>
                <input type="text" className="form-control mb-3" placeholder="Password" value={pwd} onChange={e => setPwd(e.target.value)} />
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('join_room', { room_id: modal.room_id, password: pwd }); }}>Join</button>
                </div>
            </>
        );
    } else if (modal.type === 'extend_room') {
        content = (
            <>
                <div className="mb-3">
                    <label className="form-label text-muted small mb-2 fw-bold">Add Duration (Once Only)</label>
                    <div className="d-flex gap-2">
                        {[0.5, 1].map(hours => (
                            <div key={hours}
                                 className={`flex-fill text-center border rounded-3 py-2 cursor-pointer ${expireHours === hours ? 'bg-primary border-primary text-white shadow-sm' : 'bg-white text-muted border-light shadow-sm'}`}
                                 onClick={() => setExpireHours(hours)} style={{transition: 'all 0.2s'}}>
                                <div className="fw-bold fs-5">{hours === 0.5 ? '30' : '1'} <span className="fs-6">{hours === 0.5 ? 'mins' : 'hr'}</span></div>
                                <div style={{fontSize: '0.65rem', opacity: 0.8}}>{hours === 0.5 ? 1 : 2} Creds</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="alert alert-warning py-2 small mb-3 fw-bold d-flex justify-content-between shadow-sm">
                    <span><i className="fas fa-coins text-warning me-1"></i> Cost:</span>
                    <span>{expireHours === 1 ? 2 : 1} Credits</span>
                </div>
                <div className="d-flex gap-2">
                    <button className="btn btn-light border w-50 rounded-pill fw-bold" onClick={close}>Cancel</button>
                    <button className="btn btn-success w-50 rounded-pill fw-bold shadow-sm" onClick={() => { socket.emit('extend_room', { expire_hours: expireHours }); close(); }}>Extend</button>
                </div>
            </>
        );
    } else if (modal.type === 'kick_player') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to remove this player from your room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('kick_player', { target_id: modal.target_id }); close(); }}>Remove</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_leave') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to leave the room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('leave_room'); setCurrentRoomId(null); close(); }}>Leave</button>
                </div>
            </>
        );
    } else if (modal.type === 'chat_action') {
        // Message Action menu enabling robust community moderation features
        content = (
            <>
                <h6 className="fw-bold mb-3 text-center">Message Options</h6>
                <div className="d-flex flex-column gap-2">
                    {modal.message.user_id !== window.tgId && (
                        <button className="btn btn-warning w-100 rounded-pill fw-bold" onClick={() => {
                            setModal({ type: 'report_input', context: 'message', reported_id: modal.message.user_id, snapshot_data: modal.message.message });
                        }}>
                            <i className="fas fa-flag me-2"></i> Report Message
                        </button>
                    )}
                    {modal.isCreator && (
                        <button className="btn btn-danger w-100 rounded-pill fw-bold" onClick={() => {
                            socket.emit('delete_message', { message_id: modal.message.id });
                            close();
                        }}>
                            <i className="fas fa-trash-alt me-2"></i> Delete Message
                        </button>
                    )}
                    <button className="btn btn-secondary w-100 rounded-pill fw-bold mt-2" onClick={close}>Cancel</button>
                </div>
            </>
        );
    } else if (modal.type === 'report_input') {
        // Uniform reporting reason input logic
        content = (
            <>
                <p className="text-muted small">Please provide a reason for reporting this {modal.context}.</p>
                <textarea className="form-control mb-3" placeholder="Reason..." rows="3" value={pwd} onChange={e => setPwd(e.target.value)}></textarea>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill fw-bold" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill fw-bold" disabled={pwd.trim().length < 3} onClick={() => { 
                        socket.emit('report_user', { reported_id: modal.reported_id, context: modal.context, reason: pwd.trim(), snapshot_data: modal.snapshot_data }); 
                        close(); 
                    }}><i className="fas fa-paper-plane me-1"></i> Submit</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_clear_chat') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to delete ALL messages in this room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('clear_chat'); close(); }}>Clear All</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_guess_credit') {
        content = (
            <>
                <p className="text-muted">You have used your 4 free guesses. Unlock your final 2 guesses for <b>1 Credit</b>.</p>
                <div className="alert alert-warning text-center" style={{letterSpacing: '3px'}}><b>{modal.guess}</b></div>
                <div className="d-flex gap-2 mt-4">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-success w-50 rounded-pill" onClick={() => { socket.emit('guess', { guess: modal.guess }); close(); }}>Confirm</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_buy_hint') {
        content = (
            <>
                <p className="text-muted">Reveal this hidden character for <b>1 Credit</b> or Watch an Ad for free! (Limit 1 per round)</p>
                <div className="alert alert-warning text-center py-2 mb-3"><i className="fas fa-lightbulb"></i> Hint Options</div>
                <div className="d-flex flex-column gap-2 mt-2">
                    <button className="btn btn-success w-100 rounded-pill fw-bold" onClick={() => { socket.emit('buy_hint', { index: modal.index }); close(); }}>Reveal</button>
                    <button className="btn btn-primary w-100 rounded-pill fw-bold" onClick={() => { triggerHintAd(modal.index); close(); }}>Watch</button>
                    <button className="btn btn-secondary w-100 rounded-pill fw-bold" onClick={close}>Cancel</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_gender_change') {
        content = (
            <>
                <p className="text-dark text-center mb-3">
                    Are you sure you want to set your gender to <b>{modal.gender}</b>?
                </p>
                {modal.isFirstTime ? (
                    <div className="alert alert-info py-2 small mb-4">
                        <i className="fas fa-info-circle"></i> Note: This first change is free. Future changes will cost 5 Credits.
                    </div>
                ) : (
                    <div className="alert alert-warning py-2 small mb-4">
                        <i className="fas fa-exclamation-triangle"></i> This will cost 5 Credits.
                    </div>
                )}
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill fw-bold" onClick={() => { socket.emit('set_gender', { gender: modal.gender }); close(); }}>Confirm</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_name_change') {
        content = (
            <>
                <p className="text-dark text-center mb-3">
                    Are you sure you want to set your display name to <b>{modal.name}</b>?
                </p>
                {modal.isFirstTime ? (
                    <div className="alert alert-info py-2 small mb-4">
                        <i className="fas fa-info-circle"></i> Note: This first change is free. Future changes will cost 5 Credits.
                    </div>
                ) : (
                    <div className="alert alert-warning py-2 small mb-4">
                        <i className="fas fa-exclamation-triangle"></i> This will cost 5 Credits.
                    </div>
                )}
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill fw-bold" onClick={() => { socket.emit('set_name', { name: modal.name }); close(); }}>Confirm</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_drawer_give_up') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to give up? This will skip your turn immediately.</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('give_up'); close(); }}>Quit</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_guesser_give_up') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Vote to give up this round? If all guessers give up, the drawing is skipped and the word is revealed.</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-warning w-50 rounded-pill" onClick={() => { socket.emit('give_up'); close(); }}>Vote</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_buy_ink') {
        content = (
            <>
                <p className="text-muted text-center mb-4">
                    Refill your ink supply to keep drawing? (Limit: Max 5000 Ink Output/Round)
                </p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill fw-bold" onClick={() => { socket.emit('buy_ink'); close(); }}>
                        Buy
                    </button>
                </div>
            </>
        );
    }

    return (
        <>
            <div className="wb-overlay" style={{ zIndex: 4000, background: 'rgba(0,0,0,0.5)', position: 'fixed' }}>
                <div className="call-toast text-start" style={{ width: '90%', maxWidth: '350px' }}>
                    <div className="d-flex justify-content-between align-items-center mb-3">
                        <h5 className="m-0 fw-bold">{modal.title || 'Notice'}</h5>
                        {modal.type !== 'idle_warning' && modal.type !== 'sound_policy' && <button className="btn-close" onClick={close}></button>}
                    </div>
                    {content}
                </div>
            </div>
            
            {adLoading && (
                <div className="wb-overlay" style={{ zIndex: 9999, background: 'rgba(0,0,0,0.92)', position: 'fixed', top:0, left:0, right:0, bottom:0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <h2 className="text-white mb-4 fw-bold text-center">Loading Advertisement</h2>
                    <div className="spinner-border text-primary mb-4" style={{width: '4rem', height: '4rem', borderWidth: '0.4em'}}></div>
                    <p className="text-muted mt-2 small text-center">Please wait, your reward is loading.</p>
                </div>
            )}
        </>
    );
};

window.ModalManager = ModalManager;
