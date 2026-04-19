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
    if (modal.type === 'maintenance') {
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
            </
