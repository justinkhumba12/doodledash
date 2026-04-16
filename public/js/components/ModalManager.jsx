const { useState } = React;

const ModalManager = ({ modal, setModal, socket, setCurrentRoomId, idleTimer, setSoundPolicyAccepted }) => {
    if (!modal) return null;
    const [pwd, setPwd] = useState('');
    const [isPriv, setIsPriv] = useState(false);
    const [maxMembers, setMaxMembers] = useState(4);
    const [expireHours, setExpireHours] = useState(2);
    
    // New Ad loading state for Hints
    const [adLoading, setAdLoading] = useState(false);

    const close = () => { setModal(null); setPwd(''); setIsPriv(false); setMaxMembers(4); setExpireHours(2); };

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
                <ul className="small text-muted text-start mt-3 ps-3">
                    <li className="mb-2"><b>Top Inviters:</b> Resets every week. The top 5 inviters receive an automated message from the bot to claim their credits (1 Friend = 1 Credit).</li>
                    <li className="mb-2"><b>Top Donators:</b> All-time list of our generous supporters! This list refreshes every 24 hours.</li>
                    <li><b>Usernames:</b> If your username shows as 'unset', please update it in your Telegram profile.</li>
                </ul>
                <button className="btn btn-secondary w-100 rounded-pill mt-3" onClick={close}>Got it</button>
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
                }}>Yes, I'm here</button>
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
        let limitCost = maxMembers === 2 ? 1 : (maxMembers === 3 ? 3 : 4);
        let durationCost = expireHours === 2 ? 1 : 2;
        let baseRoomCost = isPriv ? (limitCost + durationCost) : 0;

        content = (
            <>
                <div className="d-flex justify-content-between align-items-center p-3 mb-3 border rounded-3 bg-light" onClick={() => setIsPriv(!isPriv)} style={{cursor: 'pointer'}}>
                    <div>
                        <h6 className="mb-0 fw-bold text-dark"><i className="fas fa-lock text-danger me-2"></i>Private Room</h6>
                        <small className="text-muted">Require password</small>
                    </div>
                    <div className="form-check form-switch fs-4 mb-0">
                        <input className="form-check-input mt-0 cursor-pointer" type="checkbox" checked={isPriv} readOnly />
                    </div>
                </div>

                {isPriv ? (
                    <>
                        <input type="number" className="form-control mb-3" placeholder="Set Password (6-10 digits)..." value={pwd} onChange={e => setPwd(e.target.value)} />
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-1">Max Players</label>
                            <select className="form-select" value={maxMembers} onChange={e => setMaxMembers(Number(e.target.value))}>
                                <option value={2}>2 Players (1 Credit)</option>
                                <option value={3}>3 Players (3 Credits)</option>
                                <option value={4}>4 Players (4 Credits)</option>
                            </select>
                        </div>
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-1">Room Duration</label>
                            <select className="form-select" value={expireHours} onChange={e => setExpireHours(Number(e.target.value))}>
                                <option value={2}>2 Hours (1 Credit)</option>
                                <option value={4}>4 Hours (2 Credits)</option>
                            </select>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="mb-3">
                            <label className="form-label text-muted small mb-1">Max Players</label>
                            <input type="text" className="form-control text-dark" value="4 Players (Fixed)" disabled />
                        </div>
                        <div className="alert alert-success py-2 small mb-3">
                            <i className="fas fa-check-circle me-1"></i> Creating a public room is FREE!<br/>
                            <span className="text-muted" style={{fontSize: '0.75rem'}}>* Anyone can join for free</span>
                        </div>
                    </>
                )}

                {(isPriv) && (
                    <div className="alert alert-warning py-2 small mb-3">
                        <i className="fas fa-coins text-warning me-1"></i> Total Cost: {baseRoomCost} Credits
                    </div>
                )}

                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill" disabled={isPriv && (pwd.length < 6 || pwd.length > 10)} onClick={() => { 
                        socket.emit('create_room', { 
                            is_private: isPriv, 
                            password: pwd, 
                            max_members: isPriv ? maxMembers : 4, 
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
                <p className="text-muted small">Set a new password (6-10 digits).</p>
                <input type="number" className="form-control mb-3" placeholder="New Password (6-10 digits)..." value={pwd} onChange={e => setPwd(e.target.value)} />
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
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('delete_room'); close(); }}><i className="fas fa-trash"></i> Delete</button>
                </div>
            </>
        );
    } else if (modal.type === 'prompt_pwd') {
        content = (
            <>
                <p className="text-muted">Enter password to join Room {modal.room_id}</p>
                <input type="number" className="form-control mb-3" placeholder="Password" value={pwd} onChange={e => setPwd(e.target.value)} />
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('join_room', { room_id: modal.room_id, password: pwd }); }}>Join Room</button>
                </div>
            </>
        );
    } else if (modal.type === 'extend_room') {
        content = (
            <>
                <div className="mb-3">
                    <label className="form-label text-muted small mb-1">Add Duration</label>
                    <select className="form-select" value={expireHours} onChange={e => setExpireHours(Number(e.target.value))}>
                        <option value={2}>+2 Hours (1 Credit)</option>
                        <option value={4}>+4 Hours (2 Credits)</option>
                    </select>
                </div>
                <div className="alert alert-warning py-2 small mb-3">
                    <i className="fas fa-coins text-warning me-1"></i> Cost: {expireHours === 4 ? 2 : 1} Credits
                </div>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-success w-50 rounded-pill" onClick={() => { socket.emit('extend_room', { expire_hours: expireHours }); close(); }}><i className="fas fa-clock"></i> Extend</button>
                </div>
            </>
        );
    } else if (modal.type === 'kick_player') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to remove this player from your room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('kick_player', { target_id: modal.target_id }); close(); }}><i className="fas fa-user-times"></i> Remove</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_leave') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to leave the room?</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('leave_room'); setCurrentRoomId(null); close(); }}><i className="fas fa-sign-out-alt"></i> Leave</button>
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
                    <button className="btn btn-success w-50 rounded-pill" onClick={() => { socket.emit('guess', { guess: modal.guess }); close(); }}>Confirm (1 Credit)</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_buy_hint') {
        content = (
            <>
                <p className="text-muted">Reveal this hidden character for <b>1 Credit</b> or Watch an Ad for free! (Limit 1 per round)</p>
                <div className="alert alert-warning text-center py-2 mb-3"><i className="fas fa-lightbulb"></i> Hint Options</div>
                <div className="d-flex flex-column gap-2 mt-2">
                    <button className="btn btn-success w-100 rounded-pill fw-bold" onClick={() => { socket.emit('buy_hint', { index: modal.index }); close(); }}>Reveal (1 Cred)</button>
                    <button className="btn btn-primary w-100 rounded-pill fw-bold" onClick={() => { triggerHintAd(modal.index); close(); }}><i className="fas fa-play-circle"></i> Watch Ad (Free)</button>
                    <button className="btn btn-secondary w-100 rounded-pill fw-bold" onClick={close}>Cancel</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_gender_change') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to change your gender to <b>{modal.gender}</b>? This will cost <b>5 Credits</b>.</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-primary w-50 rounded-pill" onClick={() => { socket.emit('set_gender', { gender: modal.gender }); close(); }}>Confirm (5 Cred)</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_drawer_give_up') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Are you sure you want to give up? This will skip your turn immediately.</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-danger w-50 rounded-pill" onClick={() => { socket.emit('give_up'); close(); }}><i className="fas fa-flag"></i> Give Up</button>
                </div>
            </>
        );
    } else if (modal.type === 'confirm_guesser_give_up') {
        content = (
            <>
                <p className="text-muted text-center mb-4">Vote to give up this round? If all guessers give up, the drawing is skipped and the word is revealed.</p>
                <div className="d-flex gap-2">
                    <button className="btn btn-secondary w-50 rounded-pill" onClick={close}>Cancel</button>
                    <button className="btn btn-warning w-50 rounded-pill" onClick={() => { socket.emit('give_up'); close(); }}><i className="fas fa-flag"></i> Vote Give Up</button>
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
                        Buy ({modal.cost} Cred)
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
                        <h5 className="m-0 fw-bold">{modal.title || 'Notification'}</h5>
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

// Expose to window for the main app
window.ModalManager = ModalManager;
