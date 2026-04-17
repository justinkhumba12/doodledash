const { useState, useEffect } = React;

const ModalManager = ({ modal, setModal, socket, setCurrentRoomId, idleTimer, setSoundPolicyAccepted }) => {
    if (!modal) return null;

    const [inputValue, setInputValue] = useState('');
    const [isPrivate, setIsPrivate] = useState(false);
    const [maxMembers, setMaxMembers] = useState(4);
    const [expireHours, setExpireHours] = useState(2);
    const [autoJoin, setAutoJoin] = useState(true);

    const close = () => setModal(null);

    const renderContent = () => {
        switch (modal.type) {
            case 'sound_policy':
                return (
                    <div className="text-center">
                        <i className="fas fa-volume-up text-primary fs-1 mb-3"></i>
                        <h4 className="fw-bold">Enable Game Sounds</h4>
                        <p className="text-muted small">DoodleDash uses sound effects for messages and guesses to keep you in the game!</p>
                        <button className="btn btn-primary rounded-pill w-100 fw-bold shadow-sm" onClick={() => {
                            setSoundPolicyAccepted(true);
                            close();
                        }}>Allow Sounds</button>
                    </div>
                );

            case 'error':
                return (
                    <div className="text-center">
                        <i className="fas fa-exclamation-circle text-danger fs-1 mb-3"></i>
                        <h4 className="fw-bold">{modal.title || 'Error'}</h4>
                        <p className="text-muted">{modal.content}</p>
                        <button className="btn btn-secondary rounded-pill px-4 fw-bold" onClick={close}>Close</button>
                    </div>
                );

            case 'success':
                return (
                    <div className="text-center">
                        <i className="fas fa-check-circle text-success fs-1 mb-3"></i>
                        <h4 className="fw-bold">{modal.title || 'Success'}</h4>
                        <p className="text-muted">{modal.content}</p>
                        <button className="btn btn-success rounded-pill px-4 fw-bold" onClick={close}>Awesome!</button>
                    </div>
                );

            case 'idle_warning':
                return (
                    <div className="text-center">
                        <i className="fas fa-clock text-warning fs-1 mb-3"></i>
                        <h4 className="fw-bold">Are you still there?</h4>
                        <p className="text-muted">You will be disconnected in <strong className="text-danger">{idleTimer}</strong> seconds.</p>
                        <button className="btn btn-primary rounded-pill px-4 fw-bold" onClick={() => {
                            if (socket) socket.emit('active_event');
                            close();
                        }}>I'm Here!</button>
                    </div>
                );

            case 'confirm_leave':
                return (
                    <div className="text-center">
                        <i className="fas fa-sign-out-alt text-danger fs-1 mb-3"></i>
                        <h4 className="fw-bold">Leave Room?</h4>
                        <p className="text-muted">Are you sure you want to return to the lobby?</p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-danger rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('leave_room');
                                close();
                            }}>Leave</button>
                        </div>
                    </div>
                );

            case 'create_room':
                return (
                    <div>
                        <h4 className="fw-bold text-center mb-3">Create Room</h4>
                        <div className="mb-3">
                            <div className="form-check form-switch mb-2">
                                <input className="form-check-input shadow-none" type="checkbox" id="isPrivate" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} />
                                <label className="form-check-label fw-bold" htmlFor="isPrivate">Private Room (Requires Password)</label>
                            </div>
                            {isPrivate && (
                                <>
                                    <input type="text" className="form-control mb-2 rounded" placeholder="Password (6-10 chars)" maxLength="10" value={inputValue} onChange={e => setInputValue(e.target.value)} />
                                    <div className="d-flex justify-content-between mb-2">
                                        <span className="small text-muted fw-bold">Duration</span>
                                        <select className="form-select form-select-sm w-auto shadow-none" value={expireHours} onChange={e => setExpireHours(Number(e.target.value))}>
                                            <option value={2}>2 Hours</option>
                                            <option value={4}>4 Hours</option>
                                        </select>
                                    </div>
                                </>
                            )}
                            <div className="d-flex justify-content-between align-items-center mb-3 mt-2">
                                <span className="small text-muted fw-bold">Max Players</span>
                                <select className="form-select form-select-sm w-auto shadow-none" value={maxMembers} onChange={e => setMaxMembers(Number(e.target.value))}>
                                    <option value={2}>2 Players</option>
                                    <option value={3}>3 Players</option>
                                    <option value={4}>4 Players</option>
                                </select>
                            </div>
                            <div className="form-check form-switch">
                                <input className="form-check-input shadow-none" type="checkbox" id="autoJoin" checked={autoJoin} onChange={e => setAutoJoin(e.target.checked)} />
                                <label className="form-check-label small fw-bold text-muted" htmlFor="autoJoin">Auto-join upon creation</label>
                            </div>
                        </div>
                        <div className="d-flex gap-2">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-primary rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('create_room', { is_private: isPrivate, password: inputValue, max_members: maxMembers, expire_hours: expireHours, auto_join: autoJoin });
                                close();
                            }}>Create</button>
                        </div>
                    </div>
                );

            case 'prompt_pwd':
                return (
                    <div className="text-center">
                        <i className="fas fa-lock text-warning fs-1 mb-3"></i>
                        <h4 className="fw-bold">Private Room</h4>
                        <p className="text-muted small mb-3">Please enter the password to join Room {modal.room_id}.</p>
                        <input type="text" className="form-control text-center mb-3 rounded" placeholder="Password" value={inputValue} onChange={e => setInputValue(e.target.value)} />
                        <div className="d-flex gap-2">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-primary rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('join_room', { room_id: modal.room_id, password: inputValue });
                                close();
                            }}>Join</button>
                        </div>
                    </div>
                );

            case 'change_password':
                return (
                    <div className="text-center">
                        <i className="fas fa-key text-primary fs-1 mb-3"></i>
                        <h4 className="fw-bold">Change Password</h4>
                        <p className="text-muted small mb-3">Enter a new password (6-10 chars).</p>
                        <input type="text" className="form-control text-center mb-3 rounded" placeholder="New Password" maxLength="10" value={inputValue} onChange={e => setInputValue(e.target.value)} />
                        <div className="d-flex gap-2">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-success rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('change_password', { password: inputValue });
                                close();
                            }}>Update</button>
                        </div>
                    </div>
                );

            case 'extend_room':
                return (
                    <div className="text-center">
                        <i className="fas fa-clock text-info fs-1 mb-3"></i>
                        <h4 className="fw-bold">Extend Room</h4>
                        <p className="text-muted small mb-3">Add more time before your private room expires.</p>
                        <select className="form-select mb-3 shadow-none text-center" value={expireHours} onChange={e => setExpireHours(Number(e.target.value))}>
                            <option value={2}>+ 2 Hours (Cost: 1 Credit)</option>
                            <option value={4}>+ 4 Hours (Cost: 2 Credits)</option>
                        </select>
                        <div className="d-flex gap-2">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-primary rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('extend_room', { expire_hours: expireHours });
                                close();
                            }}>Extend</button>
                        </div>
                    </div>
                );

            case 'confirm_delete_room':
                return (
                    <div className="text-center">
                        <i className="fas fa-trash-alt text-danger fs-1 mb-3"></i>
                        <h4 className="fw-bold">Delete Room?</h4>
                        <p className="text-muted small">This will kick all players and close the room permanently. Are you sure?</p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-danger rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('delete_room');
                                close();
                            }}>Delete</button>
                        </div>
                    </div>
                );

            case 'confirm_buy_ink':
                return (
                    <div className="text-center">
                        <i className="fas fa-tint text-primary fs-1 mb-3"></i>
                        <h4 className="fw-bold">Refill Ink</h4>
                        <p className="text-muted small">Run out of ink? Refill your pen for {modal.cost} Credit.</p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-primary rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('buy_ink');
                                close();
                            }}>Buy Ink</button>
                        </div>
                    </div>
                );

            case 'confirm_buy_hint':
                return (
                    <div className="text-center">
                        <i className="fas fa-lightbulb text-warning fs-1 mb-3"></i>
                        <h4 className="fw-bold">Reveal Letter</h4>
                        <p className="text-muted small">Unlock this letter hint to help you guess?</p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-warning rounded-pill flex-grow-1 fw-bold text-dark" onClick={() => {
                                if (socket) socket.emit('buy_hint', { index: modal.index });
                                close();
                            }}>Unlock (1 Credit)</button>
                        </div>
                    </div>
                );
                
            case 'confirm_guess_credit':
                return (
                    <div className="text-center">
                        <i className="fas fa-unlock text-success fs-1 mb-3"></i>
                        <h4 className="fw-bold">{modal.title}</h4>
                        <p className="text-muted small">You've reached the free guess limit. Use 1 Credit to unlock 2 more guesses for this round?</p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-success rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('guess', { guess: modal.guess });
                                close();
                            }}>Unlock (1 Credit)</button>
                        </div>
                    </div>
                );

            case 'confirm_drawer_give_up':
            case 'confirm_guesser_give_up':
                const isDrawer = modal.type === 'confirm_drawer_give_up';
                return (
                    <div className="text-center">
                        <i className="fas fa-flag text-danger fs-1 mb-3"></i>
                        <h4 className="fw-bold">Give Up?</h4>
                        <p className="text-muted small">
                            {isDrawer 
                                ? "Are you sure you want to give up drawing? This will end your turn." 
                                : "Vote to give up this round? If everyone gives up, the word is revealed."}
                        </p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-danger rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) socket.emit('give_up');
                                close();
                            }}>Confirm</button>
                        </div>
                    </div>
                );

            case 'confirm_gender_change':
            case 'confirm_name_change':
                const isName = modal.type === 'confirm_name_change';
                return (
                    <div className="text-center">
                        <i className={`fas ${isName ? 'fa-id-card' : 'fa-venus-mars'} text-primary fs-1 mb-3`}></i>
                        <h4 className="fw-bold">Confirm Change</h4>
                        <p className="text-muted small">
                            {modal.isFirstTime 
                                ? `Are you sure you want to set your ${isName ? 'name' : 'gender'}? This is free the first time.` 
                                : `Changing your ${isName ? 'name' : 'gender'} will cost 5 Credits. Are you sure?`}
                        </p>
                        <div className="d-flex gap-2 mt-3">
                            <button className="btn btn-light border rounded-pill flex-grow-1 fw-bold" onClick={close}>Cancel</button>
                            <button className="btn btn-primary rounded-pill flex-grow-1 fw-bold" onClick={() => {
                                if (socket) {
                                    if (isName) socket.emit('set_name', { name: modal.name });
                                    else socket.emit('set_gender', { gender: modal.gender });
                                }
                                close();
                            }}>Confirm</button>
                        </div>
                    </div>
                );

            case 'leaderboard_rules':
                return (
                    <div>
                        <h4 className="fw-bold text-center mb-3">Leaderboard Info</h4>
                        <ul className="text-muted small mb-0 ps-3">
                            <li className="mb-2"><strong>Top Inviters:</strong> Players with the most successful invites this week.</li>
                            <li className="mb-2"><strong>Top Guessers:</strong> Players who correctly guessed the most words this week.</li>
                            <li className="mb-2"><strong>Donators:</strong> All-time top supporters of DoodleDash via Telegram Stars.</li>
                            <li><em>Weekly challenges reset every Monday. Top 5 players in weekly categories win Credit rewards!</em></li>
                        </ul>
                        <button className="btn btn-primary w-100 rounded-pill mt-4 fw-bold shadow-sm" onClick={close}>Got It</button>
                    </div>
                );

            default:
                return null;
        }
    };

    return (
        <div className="wb-overlay" style={{ zIndex: 1060, backgroundColor: 'rgba(0,0,0,0.6)' }} onClick={close}>
            <div className="call-toast bg-white rounded-4 shadow p-4 position-relative" style={{ minWidth: '320px', maxWidth: '400px', margin: 'auto' }} onClick={e => e.stopPropagation()}>
                {modal.type !== 'sound_policy' && modal.type !== 'idle_warning' && (
                    <button className="btn-close position-absolute top-0 end-0 m-3" onClick={close}></button>
                )}
                {renderContent()}
            </div>
        </div>
    );
};

window.ModalManager = ModalManager;
