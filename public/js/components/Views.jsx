const { useState, useEffect } = React;

const ProfileView = ({ user }) => (
    <div className="container mt-5 text-center">
        <img src={window.profilePic || 'https://via.placeholder.com/120'} className="rounded-circle shadow-lg mb-4 border" width="120" height="120" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Profile" />
        <h3 className="fw-bold text-dark">{window.toHex(user.tg_id)}</h3>
    </div>
);

const TasksView = ({ user, socket, setModal }) => {
    const [adState, setAdState] = useState({ show: false });

    // Preload Interstitial Ad when component mounts to reduce latency
    useEffect(() => {
        if (typeof window.show_10812134 === 'function' && user?.tg_id) {
            window.show_10812134({ type: 'preload', ymid: user.tg_id.toString() }).catch(() => {
                // Ignore preload errors silently
            });
        }
    }, [user]);

    const triggerAdTask = (adNum, prefix) => {
        setAdState({ show: true });
        
        // Fallback if AdBlocker blocks script
        if (typeof window.show_10812134 !== 'function') {
            setTimeout(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }, 2500);
            return;
        }

        // ymid allows Monetag's postback to match the reward to the specific Telegram user ID
        const adConfig = { ymid: user.tg_id.toString() };

        if (adNum === 1) {
            // AD 1: REWARDED POPUP
            window.show_10812134({ type: 'pop', ...adConfig }).then(() => {
                // User attempted to watch the popup
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }).catch(e => {
                // Handle blocked or failed popups
                setAdState({ show: false });
                setModal({ type: 'error', title: 'Ad Error', content: 'Popup ad failed to open or was blocked. Try again later.' });
            });
        } else {
            // AD 2: REWARDED INTERSTITIAL
            window.show_10812134(adConfig).then(() => {
                // User successfully watched the interstitial
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }).catch(e => {
                // Handle skipped or failed interstitial ad
                setAdState({ show: false });
                setModal({ type: 'error', title: 'Ad Error', content: 'Ad failed to load or was skipped. Try again later.' });
            });
        }
    };

    const renderTaskAdBtn = (adNum) => {
        const prefix = adNum === 1 ? 'ad' : 'ad2';
        const claims = adNum === 1 ? user.ad_claims_today : user.ad2_claims_today;
        const isAvailable = adNum === 1 ? user.ad1_available : user.ad2_available;
        const waitMins = Number(adNum === 1 ? user.ad1_wait_mins : user.ad2_wait_mins) || 0;
        const maxClaims = adNum === 1 ? 3 : 5;

        let btnText = `Watch (${claims}/${maxClaims})`;
        let disabled = false;
        
        if (!isAvailable) {
            disabled = true;
            if (claims >= maxClaims) { 
                btnText = `Done`; 
            } else { 
                const wH = Math.floor(waitMins / 60);
                const wM = waitMins % 60;
                btnText = `Wait ${wH > 0 ? wH + 'h ' : ''}${wM > 0 ? wM + 'm' : ''}`.trim(); 
            }
        }

        return (
            <button className={`btn btn-sm ${disabled ? 'btn-secondary' : 'btn-outline-primary'} rounded-pill px-3`} disabled={disabled} onClick={() => triggerAdTask(adNum, prefix)}>
                {btnText}
            </button>
        );
    };

    return (
        <div className="container mt-4 pb-5">
            <h3 className="fw-bold mb-4 text-center">Daily Tasks</h3>
            <div className="card border-0 shadow-sm rounded-4 mb-3">
                <div className="card-body d-flex justify-content-between align-items-center">
                    <div>
                        <h6 className="fw-bold mb-1"><i className="fas fa-calendar-check text-success me-2"></i> Daily Login</h6>
                        <p className="small text-muted mb-0">Log in every day to get 1 free credit.</p>
                    </div>
                    <button className={`btn btn-sm ${!user.daily_available ? 'btn-secondary' : 'btn-primary'} rounded-pill px-3`} disabled={!user.daily_available} onClick={() => socket.emit('claim_reward', {type: 'daily'})}>
                        {user.daily_available ? 'Claim' : 'Done'}
                    </button>
                </div>
            </div>
            <div className="card border-0 shadow-sm rounded-4 mb-3">
                <div className="card-body d-flex justify-content-between align-items-center">
                    <div>
                        <h6 className="fw-bold mb-1"><i className="fas fa-tv text-warning me-2"></i> Watch Ad 1 (Popup)</h6>
                        <p className="small text-muted mb-0">Watch ads to earn extra credits.</p>
                    </div>
                    {renderTaskAdBtn(1)}
                </div>
            </div>
            <div className="card border-0 shadow-sm rounded-4 mb-3">
                <div className="card-body d-flex justify-content-between align-items-center">
                    <div>
                        <h6 className="fw-bold mb-1"><i className="fas fa-play-circle text-danger me-2"></i> Watch Ad 2 (Interstitial)</h6>
                        <p className="small text-muted mb-0">Additional ad views for more credits.</p>
                    </div>
                    {renderTaskAdBtn(2)}
                </div>
            </div>

            {adState.show && (
                <div className="wb-overlay" style={{zIndex: 9999, background: 'rgba(0,0,0,0.92)', position: 'fixed', top:0, left:0, right:0, bottom:0}}>
                    <h2 className="text-white mb-4 fw-bold">Loading Advertisement</h2>
                    <div className="spinner-border text-primary mb-4" style={{width: '4rem', height: '4rem', borderWidth: '0.4em'}}></div>
                    <p className="text-muted mt-5 small">Please wait, do not close.</p>
                </div>
            )}
        </div>
    );
};

const LeaderboardView = () => (
    <div className="container mt-4 text-center">
        <i className="fas fa-trophy text-light mt-5" style={{ fontSize: '6rem' }}></i>
        <h4 className="text-muted mt-3 fw-bold">Coming Soon</h4>
    </div>
);

const LobbyView = ({ user, rooms, setModal, socket }) => {
    const [searchId, setSearchId] = useState('');
    const [adState, setAdState] = useState({ show: false });
    const [activeTab, setActiveTab] = useState('public');
    const [hideFull, setHideFull] = useState(false);
    
    const [touchStartPos, setTouchStartPos] = useState(null);

    // Preload Interstitial Ad when component mounts to reduce latency
    useEffect(() => {
        if (typeof window.show_10812134 === 'function' && user?.tg_id) {
            window.show_10812134({ type: 'preload', ymid: user.tg_id.toString() }).catch(() => {});
        }
    }, [user]);

    const handleTouchStart = (e) => setTouchStartPos({ x: e.touches[0].clientX, y: e.touches[0].clientY });
    const handleTouchEnd = (e) => {
        if (!touchStartPos) return;
        const diffX = touchStartPos.x - e.changedTouches[0].clientX;
        const diffY = touchStartPos.y - e.changedTouches[0].clientY;

        if (Math.abs(diffY) > Math.abs(diffX)) {
            setTouchStartPos(null);
            return;
        }

        if (diffX > 50) {
            if (activeTab === 'public') setActiveTab('private');
            else if (activeTab === 'private') setActiveTab('my_rooms');
        } else if (diffX < -50) {
            if (activeTab === 'my_rooms') setActiveTab('private');
            else if (activeTab === 'private') setActiveTab('public');
        }
        setTouchStartPos(null);
    };

    const triggerAd = (adNum, prefix) => {
        setAdState({ show: true });
        
        // Fallback if AdBlocker blocks script
        if (typeof window.show_10812134 !== 'function') {
            setTimeout(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }, 2500);
            return;
        }

        const adConfig = { ymid: user.tg_id.toString() };

        if (adNum === 1) {
            // AD 1: REWARDED POPUP
            window.show_10812134({ type: 'pop', ...adConfig }).then(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }).catch(e => {
                setAdState({ show: false });
                setModal({ type: 'error', title: 'Ad Error', content: 'Popup ad failed to open or was blocked. Try again later.' });
            });
        } else {
            // AD 2: REWARDED INTERSTITIAL
            window.show_10812134(adConfig).then(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }).catch(e => {
                setAdState({ show: false });
                setModal({ type: 'error', title: 'Ad Error', content: 'No ad available right now or skipped. Try again later.' });
            });
        }
    };

    const renderAdBtn = (adNum) => {
        const prefix = adNum === 1 ? 'ad' : 'ad2';
        const claims = adNum === 1 ? user.ad_claims_today : user.ad2_claims_today;
        const isAvailable = adNum === 1 ? user.ad1_available : user.ad2_available;
        const waitMins = Number(adNum === 1 ? user.ad1_wait_mins : user.ad2_wait_mins) || 0;
        const maxClaims = adNum === 1 ? 3 : 5;

        let btnText = `Watch ad (${claims}/${maxClaims})`;
        let disabled = false;
        
        if (!isAvailable) {
            disabled = true;
            if (claims >= maxClaims) { 
                btnText = `Max ${maxClaims}/${maxClaims} Reached`; 
            } else { 
                const wH = Math.floor(waitMins / 60);
                const wM = waitMins % 60;
                btnText = `Wait ${wH > 0 ? wH + 'h ' : ''}${wM > 0 ? wM + 'm' : ''}`.trim(); 
            }
        }

        return (
            <button className="btn btn-light fw-bold rounded-pill btn-sm w-100 text-dark" disabled={disabled} onClick={() => triggerAd(adNum, prefix)}>
                {btnText}
            </button>
        );
    };

    let filteredRooms = rooms.filter(r => {
        if (hideFull && r.member_count >= r.max_members) return false;
        if (activeTab === 'my_rooms') return r.creator_id === user.tg_id;
        return activeTab === 'private' ? r.is_private : !r.is_private;
    });

    const totalRooms = rooms.length;
    const isRoomLimitReached = totalRooms >= 1250;

    if (searchId) {
        const searchNum = searchId.replace(/\D/g, '');
        if (searchNum) {
            filteredRooms.sort((a, b) => {
                const aStr = a.id.toString();
                const bStr = b.id.toString();
                const aExact = aStr === searchNum;
                const bExact = bStr === searchNum;
                const aPart = aStr.includes(searchNum);
                const bPart = bStr.includes(searchNum);
                
                if (aExact && !bExact) return -1;
                if (!aExact && bExact) return 1;
                if (aPart && !bPart) return -1;
                if (!aPart && bPart) return 1;
                return 0;
            });
        }
    }

    return (
        <div className="container mt-3 pb-4">
            <div className="row mb-4">
                <div className="col-md-6 mb-3">
                    <div className="hero-section h-100" style={{background: 'linear-gradient(135deg, #10b981 0%, #34d399 100%)'}}>
                        <h5><i className="fas fa-calendar-check"></i> Daily Claim</h5>
                        <p className="small mb-2">Get 1 Free Credit everyday!</p>
                        <button className="btn btn-light text-success fw-bold rounded-pill btn-sm w-100 mt-2" disabled={!user.daily_available} onClick={() => socket.emit('claim_reward', {type: 'daily'})}>
                            {user.daily_available ? 'Claim Now' : 'Claimed Today'}
                        </button>
                    </div>
                </div>
                <div className="col-md-6 mb-3">
                    <div className="hero-section h-100" style={{background: 'linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)'}}>
                        <h5><i className="fas fa-tv"></i> Ad Bonuses</h5>
                        <p className="small mb-2">Watch ads to earn Credits! (Bonus credits on final views)</p>
                        <div className="d-flex flex-column gap-2 mt-2">
                            {renderAdBtn(1)}
                            {renderAdBtn(2)}
                        </div>
                    </div>
                </div>
            </div>
            
            <div className="d-flex justify-content-between align-items-center mb-3">
                <h3 className="fw-bold m-0">Game Lobbies</h3>
                {!isRoomLimitReached ? (
                    <button className="btn btn-primary shadow-sm rounded-pill px-4" onClick={() => setModal({ type: 'create_room', title: 'Create Room' })}>
                        <i className="fas fa-plus"></i> Create
                    </button>
                ) : (
                    <div className="text-muted small fw-bold text-end">
                        <i className="fas fa-ban text-danger"></i> Room limit (1250) reached.
                    </div>
                )}
            </div>

            <div className="lobby-tabs-wrapper mb-2">
                <div className={`lobby-tab ${activeTab === 'public' ? 'active' : ''}`} onClick={() => setActiveTab('public')}>
                    <i className="fas fa-globe me-2"></i>Public
                </div>
                <div className={`lobby-tab ${activeTab === 'private' ? 'active' : ''}`} onClick={() => setActiveTab('private')}>
                    <i className="fas fa-lock me-2"></i>Private
                </div>
                <div className={`lobby-tab ${activeTab === 'my_rooms' ? 'active' : ''}`} onClick={() => setActiveTab('my_rooms')}>
                    <i className="fas fa-user me-2"></i>My Rooms
                </div>
            </div>
            
            <div className="d-flex justify-content-between align-items-center mb-3 px-2">
                <div className="form-check form-switch">
                    <input className="form-check-input" type="checkbox" id="hideFullCheck" checked={hideFull} onChange={e => setHideFull(e.target.checked)} />
                    <label className="form-check-label small fw-bold text-muted" htmlFor="hideFullCheck">Hide Full Rooms</label>
                </div>
                <div className="small text-muted fw-bold">{filteredRooms.length} Rooms</div>
            </div>

            <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} className="swipe-container" style={{ minHeight: '300px' }}>
                <div className="input-group mb-4 shadow-sm rounded-pill overflow-hidden border bg-white">
                    <input type="text" className="form-control border-0 px-4 py-2" placeholder={`Search ${activeTab.replace('_', ' ')} Room...`} value={searchId} onChange={e => setSearchId(e.target.value)} />
                </div>

                <div className="row g-3">
                    {filteredRooms.length > 0 ? filteredRooms.map(r => {
                        const isFull = r.member_count >= r.max_members;
                        const isFree = !r.is_private;
                        return (
                            <div key={r.id} className="col-md-4 col-sm-6 mb-2">
                                <div className="room-card bg-white rounded-4 p-3 border shadow-sm h-100 position-relative overflow-hidden hover-up">
                                    <div className={`position-absolute top-0 start-0 w-100`} style={{height: '4px', background: r.is_private ? '#f43f5e' : (isFree ? '#10b981' : '#6366f1')}}></div>
                                    
                                    <div className="d-flex justify-content-between align-items-center mb-2 mt-1">
                                        <h5 className="fw-bold m-0 text-dark d-flex align-items-center">
                                            <i className={`fas fa-${r.is_private ? 'lock text-danger' : 'globe text-primary'} me-2 fs-5`}></i>
                                            Room {r.id}
                                        </h5>
                                        {isFull ? (
                                            <span className="badge bg-secondary rounded-pill">Full</span>
                                        ) : (
                                            <span className={`badge ${isFree ? 'bg-success' : 'bg-danger'} rounded-pill px-2 py-1`}>
                                                {isFree ? <><i className="fas fa-gift"></i> Free</> : <><i className="fas fa-key"></i> Password</>}
                                            </span>
                                        )}
                                    </div>
                                    
                                    <div className="d-flex align-items-center justify-content-between mt-3">
                                        <div className="text-muted small fw-bold bg-light px-2 py-1 rounded">
                                            <i className="fas fa-users text-secondary"></i> {r.member_count} / {r.max_members}
                                        </div>
                                        <button className={`btn btn-sm ${isFull ? 'btn-light text-muted' : (isFree ? 'btn-success' : 'btn-primary')} rounded-pill px-4 fw-bold shadow-sm`} 
                                            disabled={isFull}
                                            onClick={() => {
                                                if (r.is_private && activeTab !== 'my_rooms') {
                                                    setModal({ type: 'prompt_pwd', title: 'Join Private Room', room_id: r.id });
                                                } else if (r.is_private && activeTab === 'my_rooms') {
                                                    socket.emit('join_room', { room_id: r.id }); 
                                                } else {
                                                    socket.emit('join_room', { room_id: r.id });
                                                }
                                            }}>
                                            {isFull ? 'Full' : 'Join'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    }) : (
                        <div className="col-12 text-center py-5 text-muted">
                            <i className={`fas fa-${activeTab === 'public' ? 'globe' : (activeTab === 'private' ? 'lock' : 'user')} fs-1 mb-3 text-light`}></i>
                            <h5>No {activeTab.replace('_', ' ')} rooms found</h5>
                            <p className="small">Be the first to create one!</p>
                        </div>
                    )}
                </div>
            </div>

            {adState.show && (
                <div className="wb-overlay" style={{zIndex: 9999, background: 'rgba(0,0,0,0.92)', position: 'fixed'}}>
                    <h2 className="text-white mb-4 fw-bold">Loading Advertisement</h2>
                    <div className="spinner-border text-primary mb-4" style={{width: '4rem', height: '4rem', borderWidth: '0.4em'}}></div>
                    <p className="text-muted mt-5 small">Please wait, do not close.</p>
                </div>
            )}
        </div>
    );
};

// Expose to window for the main app
window.ProfileView = ProfileView;
window.TasksView = TasksView;
window.LeaderboardView = LeaderboardView;
window.LobbyView = LobbyView;
