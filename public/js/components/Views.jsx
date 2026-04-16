const { useState, useEffect } = React;

const ProfileView = ({ user, socket, setModal }) => {
    const [editingGender, setEditingGender] = useState(false);
    const [selectedGender, setSelectedGender] = useState(user?.gender || 'Other');

    const handleSaveGender = () => {
        setModal({ type: 'confirm_gender_change', gender: selectedGender, isFirstTime: !user?.gender });
        setEditingGender(false);
    };

    const handleDonateClick = () => {
        const botLink = `https://t.me/doodledashbot?start=donate`;
        if (window.tg && window.tg.openTelegramLink) {
            try { window.tg.openTelegramLink(botLink); }
            catch (e) { window.open(botLink, '_blank'); }
            setTimeout(() => window.tg.close(), 300);
        } else {
            window.open(botLink, '_blank');
        }
    };

    return (
        <div className="container mt-4 pb-5">
            <div className="text-center mb-4">
                <img src={window.profilePic || 'https://via.placeholder.com/120'} className="rounded-circle shadow-lg mb-3 border" width="120" height="120" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Profile" />
                <h3 className="fw-bold text-dark mb-1">{window.toHex(user.tg_id)}</h3>
                {window.username !== 'unset' && <p className="text-muted small">@{window.username}</p>}
            </div>

            <div className="card bg-white rounded-4 border shadow-sm mb-4">
                <div className="card-body p-3">
                    <div className="d-flex justify-content-between align-items-center">
                        <span className="fw-bold text-secondary"><i className="fas fa-venus-mars me-2"></i> Gender</span>
                        {editingGender ? (
                            <div className="d-flex align-items-center gap-2">
                                <select className="form-select form-select-sm rounded-pill" value={selectedGender} onChange={e => setSelectedGender(e.target.value)}>
                                    <option value="Male">Male</option>
                                    <option value="Female">Female</option>
                                    <option value="Other">Other</option>
                                </select>
                                <button className="btn btn-success btn-sm rounded-pill px-3" onClick={handleSaveGender}><i className="fas fa-check"></i></button>
                            </div>
                        ) : (
                            <div className="d-flex align-items-center gap-2">
                                <span className="fw-bold">{user?.gender || 'Not Set'}</span>
                                <button className="btn btn-light btn-sm rounded-circle shadow-sm" onClick={() => setEditingGender(true)} title={user?.gender ? "Edit (5 Credits)" : "Set Gender"}>
                                    <i className="fas fa-edit text-primary"></i>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="card bg-light border border-primary rounded-4 cursor-pointer hover-up" onClick={handleDonateClick} style={{ transition: '0.3s' }}>
                <div className="card-body p-4 text-center">
                    <i className="fas fa-heart text-danger fs-1 mb-2"></i>
                    <h5 className="fw-bold text-dark">Support DoodleDash</h5>
                    <p className="small text-muted mb-0">Donate Telegram Stars to keep the servers running and get featured on the Donators Leaderboard!</p>
                    <button className="btn btn-primary rounded-pill mt-3 px-4 fw-bold shadow-sm">Donate via Bot</button>
                </div>
            </div>
        </div>
    );
};

const TasksView = ({ user, socket }) => {
    // Dynamic invite counts fetched from database
    const inviteCount = user?.weekly_invites || 0;
    const goal = 3;
    const isCompleted = inviteCount >= goal;
    const hasClaimed = user?.invite_claimed_this_week;

    const handleInvite = () => {
        const botLink = `https://t.me/share/url?url=https://t.me/doodledashbot?start=invite_${user?.tg_id}&text=Play%20DoodleDash%20with%20me!`;
        if (window.tg && window.tg.openTelegramLink) {
            try {
                window.tg.openTelegramLink(botLink);
            } catch (e) {
                window.open(botLink, '_blank');
            }
        } else {
            window.open(botLink, '_blank');
        }
    };

    const handleClaim = () => {
        if (socket && isCompleted && !hasClaimed) {
            socket.emit('claim_reward', { type: 'invite_3' });
        }
    };

    return (
        <div className="container mt-4 pb-5">
            <h3 className="fw-bold mb-4 text-center">Your Tasks</h3>

            <div className="card bg-white rounded-4 border shadow-sm overflow-hidden mb-3" style={{ transition: '0.3s' }}>
                <div className="card-body p-4">
                    <div className="d-flex align-items-center justify-content-between mb-3">
                        <div className="d-flex align-items-center gap-3">
                            <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '55px', height: '55px', background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)'}}>
                                <i className="fas fa-user-friends fs-4"></i>
                            </div>
                            <div>
                                <h5 className="fw-bold mb-1">Weekly Invite Challenge</h5>
                                <p className="text-muted small mb-0">Invite 3 friends this week for 5 Credits!</p>
                            </div>
                        </div>
                        <div className="text-end">
                            <span className="badge bg-warning text-dark fs-6 rounded-pill shadow-sm py-2 px-3">
                                <i className="fas fa-coins me-1"></i> 5
                            </span>
                        </div>
                    </div>

                    <div className="mb-3 mt-4">
                        <div className="d-flex justify-content-between small fw-bold mb-2 px-1">
                            <span className="text-secondary">Weekly Progress</span>
                            <span className={isCompleted ? 'text-success' : 'text-primary'}>{inviteCount} / {goal}</span>
                        </div>
                        <div className="progress rounded-pill bg-light border shadow-sm" style={{height: '14px'}}>
                            <div className={`progress-bar progress-bar-striped progress-bar-animated rounded-pill ${isCompleted ? 'bg-success' : 'bg-primary'}`} style={{width: `${Math.min((inviteCount / goal) * 100, 100)}%`}}></div>
                        </div>
                    </div>

                    <div className="d-flex gap-2 mt-4 pt-2 border-top">
                        <button className="btn btn-primary flex-grow-1 rounded-pill fw-bold shadow-sm py-2" onClick={handleInvite}>
                            <i className="fas fa-paper-plane me-2"></i> Invite Link
                        </button>
                        <button
                            className={`btn ${isCompleted && !hasClaimed ? 'btn-success shadow-sm' : 'btn-light text-muted border'} rounded-pill fw-bold px-4 py-2`}
                            disabled={!isCompleted || hasClaimed}
                            onClick={handleClaim}
                        >
                            {hasClaimed ? 'Claimed' : 'Claim'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="card bg-light border-dashed rounded-4 mb-3" style={{ borderStyle: 'dashed', borderColor: '#cbd5e1' }}>
                <div className="card-body p-4 text-center text-muted">
                    <i className="fas fa-lock fs-2 mb-2 text-secondary opacity-50"></i>
                    <h6 className="fw-bold">More Tasks Coming Soon</h6>
                    <p className="small mb-0">Stay tuned for more ways to earn credits!</p>
                </div>
            </div>
        </div>
    );
};

const LeaderboardView = ({ socket, setModal }) => {
    const [activeTab, setActiveTab] = useState('inviters');
    const [inviters, setInviters] = useState([]);
    const [guessers, setGuessers] = useState([]);
    const [donators, setDonators] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (socket) {
            setLoading(true);
            if (activeTab === 'inviters' || activeTab === 'guessers') {
                socket.emit('get_leaderboard');
            } else {
                socket.emit('get_donators_leaderboard');
            }
            
            const handleLeaderboard = (data) => { 
                setInviters(data.inviters); 
                setGuessers(data.guessers);
                setLoading(false); 
            };
            const handleDon = (data) => { setDonators(data); setLoading(false); };
            
            socket.on('leaderboard_data', handleLeaderboard);
            socket.on('donators_leaderboard_data', handleDon);
            
            return () => {
                socket.off('leaderboard_data', handleLeaderboard);
                socket.off('donators_leaderboard_data', handleDon);
            }
        }
    }, [socket, activeTab]);

    return (
        <div className="container mt-4 pb-5">
            <div className="text-center mb-4 position-relative">
                <button className="btn btn-link text-muted position-absolute end-0 top-0 fs-4 p-0 shadow-none hover-up" onClick={() => setModal({type: 'leaderboard_rules'})}>
                    <i className="fas fa-info-circle"></i>
                </button>
                <i className="fas fa-trophy text-warning mb-2" style={{ fontSize: '3rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.1))' }}></i>
                <h3 className="fw-bold m-0">Leaderboard</h3>
                <p className="small text-muted">See the top players and supporters!</p>
            </div>

            <div className="lobby-tabs-wrapper mb-4 overflow-auto" style={{whiteSpace: 'nowrap'}}>
                <div className={`lobby-tab ${activeTab === 'inviters' ? 'active' : ''}`} onClick={() => setActiveTab('inviters')}>
                    <i className="fas fa-user-plus me-2"></i>Inviters
                </div>
                <div className={`lobby-tab ${activeTab === 'guessers' ? 'active' : ''}`} onClick={() => setActiveTab('guessers')}>
                    <i className="fas fa-lightbulb me-2"></i>Guessers
                </div>
                <div className={`lobby-tab ${activeTab === 'donators' ? 'active' : ''}`} onClick={() => setActiveTab('donators')}>
                    <i className="fas fa-heart me-2"></i>Donators
                </div>
            </div>

            {loading ? (
                <div className="text-center mt-5">
                    <i className="fas fa-circle-notch fa-spin fs-2 text-primary"></i>
                    <p className="text-muted mt-2">Loading...</p>
                </div>
            ) : (
                <>
                {(activeTab === 'inviters' || activeTab === 'guessers') && (
                    (activeTab === 'inviters' ? inviters : guessers).length > 0 ? (
                        <div className="card rounded-4 shadow-sm border overflow-hidden bg-white">
                            {(activeTab === 'inviters' ? inviters : guessers).map((l, index) => {
                                let rankStyle = "bg-primary";
                                if (index === 0) rankStyle = "bg-warning text-dark";
                                if (index === 1) rankStyle = "bg-secondary text-white";
                                if (index === 2) rankStyle = "bg-danger text-white";

                                return (
                                    <div key={l.tg_id} className={`d-flex align-items-center justify-content-between p-3 border-bottom ${index === 0 ? 'bg-warning' : ''}`} style={{ '--bs-bg-opacity': '.1' }}>
                                        <div className="d-flex align-items-center gap-2">
                                            <div className={`rounded-circle d-flex align-items-center justify-content-center fw-bold shadow-sm flex-shrink-0 ${rankStyle}`} style={{width: '35px', height: '35px', fontSize: '0.9rem'}}>
                                                #{index + 1}
                                            </div>
                                            <div className="flex-shrink-0 ms-1">
                                                {l.profile_pic ? <img src={l.profile_pic} className="rounded-circle shadow-sm" width="35" height="35" style={{objectFit: 'cover'}} alt="Player"/> : <i className="fas fa-user-circle fs-2 text-secondary"></i>}
                                            </div>
                                            <div className="d-flex flex-column ms-1" style={{minWidth: 0}}>
                                                <span className="fw-bold text-dark" style={{fontSize: '0.95rem'}}>{window.toHex(l.tg_id)}</span>
                                                <span className="text-muted text-truncate" style={{fontSize: '0.75rem', maxWidth: '120px'}}>{l.username !== 'unset' ? `@${l.username}` : ''}</span>
                                            </div>
                                        </div>
                                        <div className={`badge bg-light ${activeTab === 'guessers' ? 'text-primary border-primary' : 'text-dark border-secondary'} border px-3 py-1 rounded-pill shadow-sm`} style={{ fontSize: '0.85rem' }}>
                                            {activeTab === 'guessers' ? <i className="fas fa-star text-warning"></i> : null} {l.score}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="text-center mt-5 text-muted">
                            <i className={`fas ${activeTab === 'inviters' ? 'fa-users-slash' : 'fa-brain'} mb-3 text-secondary opacity-50`} style={{ fontSize: '3rem' }}></i>
                            <h5>No data yet this week!</h5>
                        </div>
                    )
                )}

                {activeTab === 'donators' && (
                    donators.length > 0 ? (
                        <div className="card rounded-4 shadow-sm border overflow-hidden bg-white">
                            {donators.map((d, index) => {
                                let rankStyle = "bg-primary";
                                if (index === 0) rankStyle = "bg-warning text-dark";
                                if (index === 1) rankStyle = "bg-secondary text-white";
                                if (index === 2) rankStyle = "bg-danger text-white";

                                return (
                                    <div key={d.tg_id} className={`d-flex align-items-center justify-content-between p-3 border-bottom ${index === 0 ? 'bg-warning' : ''}`} style={{ '--bs-bg-opacity': '.1' }}>
                                        <div className="d-flex align-items-center gap-2">
                                            <div className={`rounded-circle d-flex align-items-center justify-content-center fw-bold shadow-sm flex-shrink-0 ${rankStyle}`} style={{width: '35px', height: '35px', fontSize: '0.9rem'}}>
                                                #{index + 1}
                                            </div>
                                            <div className="flex-shrink-0 ms-1">
                                                {d.profile_pic ? <img src={d.profile_pic} className="rounded-circle shadow-sm" width="35" height="35" style={{objectFit: 'cover'}} alt="Player"/> : <i className="fas fa-user-circle fs-2 text-secondary"></i>}
                                            </div>
                                            <div className="d-flex flex-column ms-1" style={{minWidth: 0}}>
                                                <span className="fw-bold text-dark" style={{fontSize: '0.95rem'}}>{window.toHex(d.tg_id)}</span>
                                                <span className="text-muted text-truncate" style={{fontSize: '0.75rem', maxWidth: '120px'}}>{d.username !== 'unset' ? `@${d.username}` : ''}</span>
                                            </div>
                                        </div>
                                        <div className="badge bg-light text-danger border border-danger px-3 py-1 rounded-pill shadow-sm" style={{ fontSize: '0.85rem' }}>
                                            <i className="fas fa-star"></i> {d.total_donated}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="text-center mt-5 text-muted">
                            <i className="fas fa-heart-broken mb-3 text-secondary opacity-50" style={{ fontSize: '3rem' }}></i>
                            <h5>No donations yet.</h5>
                            <p className="small">Be the first to support DoodleDash!</p>
                        </div>
                    )
                )}
                </>
            )}
        </div>
    );
};

const LobbyView = ({ user, rooms, setModal, socket }) => {
    const [searchId, setSearchId] = useState('');
    const [adState, setAdState] = useState({ show: false });
    const [activeTab, setActiveTab] = useState('public');
    const [hideFull, setHideFull] = useState(false);
    
    const [touchStartPos, setTouchStartPos] = useState(null);

    const hasGender = !!user?.gender;

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
        
        if (typeof window.show_10812134 !== 'function') {
            setTimeout(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }, 2500);
            return;
        }

        const adConfig = { ymid: user.tg_id.toString() };

        if (adNum === 1) {
            window.show_10812134({ type: 'pop', ...adConfig }).then(() => {
                socket.emit('claim_reward', { type: prefix });
                setAdState({ show: false });
            }).catch(e => {
                setAdState({ show: false });
                setModal({ type: 'error', title: 'Ad Error', content: 'Popup ad failed to open or was blocked. Try again later.' });
            });
        } else {
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
                    <button className="btn btn-primary shadow-sm rounded-pill px-4" disabled={!hasGender} onClick={() => { if(hasGender) setModal({ type: 'create_room', title: 'Create Room' }) }}>
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

            <div onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} className="position-relative swipe-container" style={{ minHeight: '300px' }}>
                {!hasGender && (
                    <div className="position-absolute top-0 start-0 w-100 h-100 d-flex flex-column align-items-center pt-5" style={{zIndex: 10, background: 'rgba(248, 250, 252, 0.85)', backdropFilter: 'blur(3px)', borderRadius: '16px', border: '1px solid #e2e8f0'}}>
                        <i className="fas fa-lock text-danger mb-3" style={{fontSize: '3rem'}}></i>
                        <h5 className="fw-bold text-dark">Profile Locked</h5>
                        <p className="text-muted small text-center px-4">Please set your gender in your Profile tab to enter game rooms.</p>
                    </div>
                )}

                <div className="input-group mb-4 shadow-sm rounded-pill overflow-hidden border bg-white">
                    <input type="text" className="form-control border-0 px-4 py-2" placeholder={`Search ${activeTab.replace('_', ' ')} Room...`} value={searchId} onChange={e => setSearchId(e.target.value)} disabled={!hasGender} />
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
                                            disabled={isFull || !hasGender}
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

window.ProfileView = ProfileView;
window.TasksView = TasksView;
window.LeaderboardView = LeaderboardView;
window.LobbyView = LobbyView;
