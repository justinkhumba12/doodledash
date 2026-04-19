const { useState, useEffect } = React;

const ShopView = ({ user, socket, setModal, systemConfig }) => {
    const gemPackages = systemConfig?.gemPackages || [];
    const starPackages = systemConfig?.starPackages || [];

    const handleBuyGems = (amount) => {
        const botLink = `https://t.me/doodledashbot?start=buygems_${amount}`;
        if (window.tg && window.tg.openTelegramLink) {
            try { window.tg.openTelegramLink(botLink); } catch (e) { window.open(botLink, '_blank'); }
        } else {
            window.open(botLink, '_blank');
        }
    };

    const handleExchange = (package_id, cost) => {
        if (user?.gems < cost) return setModal({ type: 'error', title: 'Error', content: 'Not enough gems.' });
        socket.emit('exchange_gems', { package_id });
    };

    return (
        <div className="container mt-4 pb-5 text-center">
            {/* Inline styles for horizontal scrollable UI */}
            <style dangerouslySetInnerHTML={{__html: `
                .scrollable-row::-webkit-scrollbar { display: none; }
                .scrollable-row { -ms-overflow-style: none; scrollbar-width: none; scroll-snap-type: x mandatory; }
                .shop-pkg-card { min-width: 140px; transition: transform 0.2s; scroll-snap-align: center; }
                .shop-pkg-card:active { transform: scale(0.95); }
            `}} />

            <i className="fas fa-store text-primary mb-3" style={{fontSize: '4rem'}}></i>
            <h3 className="fw-bold mb-2">Item Shop</h3>
            <p className="text-muted">Get Gems and exchange them for Credits!</p>
            
            <div className="row g-3 mt-3 text-start">
                <div className="col-12">
                    <div className="card bg-white rounded-4 border shadow-sm p-3 p-md-4 h-100">
                        <h5 className="fw-bold mb-1"><i className="fas fa-gem text-info me-2"></i> Buy Gems</h5>
                        <p className="small text-muted mb-3">Purchase Gems securely using Telegram Stars.</p>
                        
                        <div className="d-flex flex-row gap-3 overflow-auto pb-2 scrollable-row w-100 px-1">
                            {starPackages.map(pkg => (
                                <div key={pkg.id} className="shop-pkg-card card bg-light rounded-4 shadow-sm border-0 text-center flex-shrink-0 cursor-pointer" onClick={() => handleBuyGems(pkg.stars)} style={{ width: '150px' }}>
                                    <div className="card-body p-3 d-flex flex-column align-items-center justify-content-center h-100">
                                        <div className="bg-info bg-opacity-10 rounded-circle d-flex align-items-center justify-content-center mb-2" style={{width:'60px', height:'60px'}}>
                                            <i className="fas fa-gem text-info" style={{fontSize: '2rem'}}></i>
                                        </div>
                                        <h4 className="fw-bold mb-0 text-dark">{pkg.gems}</h4>
                                        <small className="text-muted mb-3 fw-bold">Gems</small>
                                        <button className="btn btn-primary btn-sm rounded-pill w-100 fw-bold mt-auto shadow-sm d-flex justify-content-center align-items-center gap-2">
                                            <i className="fas fa-star text-warning"></i> {pkg.stars}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                
                <div className="col-12">
                    <div className="card bg-white rounded-4 border shadow-sm p-3 p-md-4 h-100 mt-2">
                        <h5 className="fw-bold mb-1"><i className="fas fa-exchange-alt text-warning me-2"></i> Exchange Gems</h5>
                        <p className="small text-muted mb-3">Convert your Gems into Credits instantly!</p>
                        
                        <div className="d-flex flex-row gap-3 overflow-auto pb-2 scrollable-row w-100 px-1">
                            {gemPackages.map(pkg => {
                                const canAfford = user?.gems >= pkg.gems;
                                return (
                                    <div key={pkg.id} className={`shop-pkg-card card rounded-4 shadow-sm border-0 text-center flex-shrink-0 ${canAfford ? 'bg-light cursor-pointer' : 'bg-light opacity-50'}`} onClick={() => canAfford && handleExchange(pkg.id, pkg.gems)} style={{ width: '150px' }}>
                                        <div className="card-body p-3 d-flex flex-column align-items-center justify-content-center h-100">
                                            <div className="bg-warning bg-opacity-10 rounded-circle d-flex align-items-center justify-content-center mb-2" style={{width:'60px', height:'60px'}}>
                                                <i className="fas fa-coins text-warning" style={{fontSize: '2rem'}}></i>
                                            </div>
                                            <h4 className="fw-bold mb-0 text-dark">{pkg.credits}</h4>
                                            <small className="text-muted mb-3 fw-bold">Credits</small>
                                            <button className={`btn btn-sm rounded-pill w-100 fw-bold mt-auto shadow-sm d-flex justify-content-center align-items-center gap-2 ${canAfford ? 'btn-success' : 'btn-secondary'}`} disabled={!canAfford}>
                                                <i className="fas fa-gem text-info"></i> {pkg.gems}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            {gemPackages.length === 0 && <span className="text-muted small w-100 text-center py-4">No packages available.</span>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const ProfileView = ({ user, socket, setModal }) => {
    const [editingGender, setEditingGender] = useState(false);
    const [selectedGender, setSelectedGender] = useState(user?.gender || 'Other');
    
    const [editingName, setEditingName] = useState(false);
    const [inputName, setInputName] = useState(user?.name || '');

    useEffect(() => {
        if (user?.name) setInputName(user.name);
    }, [user?.name]);

    const handleSaveGender = () => {
        setModal({ type: 'confirm_gender_change', gender: selectedGender, isFirstTime: !user?.gender });
        setEditingGender(false);
    };

    const handleSaveName = () => {
        const finalName = inputName.trim();
        if (finalName.length < 2) return setModal({ type: 'error', title: 'Invalid Name', content: 'Name must be at least 2 characters long.' });
        setModal({ type: 'confirm_name_change', name: finalName, isFirstTime: !user?.name });
        setEditingName(false);
    };

    const handleDonateClick = () => {
        const botLink = `https://t.me/doodledashbot?start=donate`;
        if (window.tg && window.tg.openTelegramLink) {
            try { window.tg.openTelegramLink(botLink); }
            catch (e) { window.open(botLink, '_blank'); }
        } else {
            window.open(botLink, '_blank');
        }
    };

    return (
        <div className="container mt-4 pb-5">
            <div className="text-center mb-4">
                {window.profilePic ? (
                    <img src={window.profilePic} className="rounded-circle shadow-lg mb-3 border" width="120" height="120" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Profile" />
                ) : (
                    <i className="fas fa-user-circle text-secondary mb-3 shadow-sm rounded-circle bg-white" style={{fontSize: '120px', color: 'var(--primary)'}}></i>
                )}
                <h3 className="fw-bold text-dark mb-1">{user?.name || window.toHex(user?.tg_id)}</h3>
                {window.username !== 'unset' && <p className="text-muted small">@{window.username}</p>}
            </div>

            <div className="card bg-white rounded-4 border shadow-sm mb-4">
                <div className="card-body p-3">
                    <div className="d-flex flex-column gap-2 mb-3">
                        <span className="fw-bold text-secondary mb-1"><i className="fas fa-id-card me-2"></i> Display Name</span>
                        {editingName ? (
                            <div className="d-flex flex-column align-items-center gap-2 w-100">
                                <input type="text" className="form-control text-center shadow-sm border" placeholder="Enter Name (Max 15)" maxLength={15} value={inputName} onChange={e => setInputName(e.target.value)} />
                                <div className="d-flex gap-2 w-100 mt-2">
                                    <button className="btn btn-outline-danger flex-shrink-0 rounded shadow-sm py-2 px-3" onClick={() => { setEditingName(false); setInputName(user?.name || ''); }} title="Cancel">
                                        <i className="fas fa-times"></i>
                                    </button>
                                    <button className="btn btn-success flex-grow-1 rounded fw-bold py-2 shadow-sm" onClick={handleSaveName}>
                                        <i className="fas fa-check me-2"></i> Save Name
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="d-flex align-items-center justify-content-between mt-1">
                                <span className="fw-bold text-dark fs-5">{user?.name || 'Not Set'}</span>
                                <button className="btn btn-light btn-sm rounded-pill shadow-sm px-3 fw-bold border" onClick={() => setEditingName(true)} title={user?.name ? "Edit (5 Credits)" : "Set Name"}>
                                    <i className="fas fa-edit text-primary me-1"></i> Edit
                                </button>
                            </div>
                        )}
                    </div>
                    
                    <hr className="my-3 text-muted opacity-25" />

                    <div className="d-flex flex-column gap-2 mt-2">
                        <span className="fw-bold text-secondary mb-1"><i className="fas fa-venus-mars me-2"></i> Gender Selection</span>
                        {editingGender ? (
                            <div className="d-flex flex-column align-items-center gap-2 w-100">
                                <div className="btn-group w-100 shadow-sm" role="group">
                                    {['Male', 'Female', 'Other'].map(g => (
                                        <button key={g} type="button" className={`btn fw-bold btn-sm py-2 ${selectedGender === g ? 'btn-primary' : 'btn-outline-primary'}`} onClick={() => setSelectedGender(g)}>{g}</button>
                                    ))}
                                </div>
                                <div className="d-flex gap-2 w-100 mt-2">
                                    <button className="btn btn-outline-danger flex-shrink-0 rounded shadow-sm py-2 px-3" onClick={() => setEditingGender(false)} title="Cancel">
                                        <i className="fas fa-times"></i>
                                    </button>
                                    <button className="btn btn-success flex-grow-1 rounded fw-bold py-2 shadow-sm" onClick={handleSaveGender}>
                                        <i className="fas fa-check me-2"></i> Save Changes
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="d-flex align-items-center justify-content-between mt-1">
                                <span className="fw-bold text-dark fs-5">{window.renderGenderIcon(user?.gender)}{user?.gender || 'Not Set'}</span>
                                <button className="btn btn-light btn-sm rounded-pill shadow-sm px-3 fw-bold border" onClick={() => setEditingGender(true)} title={user?.gender ? "Edit (5 Credits)" : "Set Gender"}>
                                    <i className="fas fa-edit text-primary me-1"></i> Edit
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="card bg-light border-dashed rounded-4 mb-3" style={{ transition: '0.3s' }}>
                <div className="card-body p-4 text-center">
                    <i className="fas fa-heart text-danger fs-1 mb-2"></i>
                    <h5 className="fw-bold text-dark">Support DoodleDash</h5>
                    <p className="small text-muted mb-0">Donate Telegram Stars to keep the servers running and get featured on the Donators Leaderboard!</p>
                    <button className="btn btn-primary rounded-pill mt-3 px-4 fw-bold shadow-sm" onClick={handleDonateClick}>Donate via Bot</button>
                </div>
            </div>
        </div>
    );
};

const TasksView = ({ user, socket, setModal }) => {
    const [adState, setAdState] = useState({ show: false });

    const inviteCount = user?.weekly_invites || 0;
    const goal = 3;
    const isCompleted = inviteCount >= goal;
    const hasClaimed = user?.invite_claimed_this_week;

    const streakCount = user?.streak_count || 0;
    const currentDay = Math.min((user?.daily_available ? streakCount + 1 : streakCount) || 1, 7);

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

    return (
        <div className="container mt-4 pb-5">
            <h3 className="fw-bold mb-4 text-center">Tasks & Rewards</h3>

            {/* Daily Streak Claim System */}
            <div className="card bg-white rounded-4 border shadow-sm mb-3">
                <div className="card-body p-3">
                    <div className="d-flex justify-content-between align-items-start mb-3">
                        <div className="d-flex align-items-center gap-3">
                            <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '45px', height: '45px', background: 'linear-gradient(135deg, #10b981 0%, #34d399 100%)'}}>
                                <i className="fas fa-fire fs-5"></i>
                            </div>
                            <div>
                                <h6 className="fw-bold mb-1">Daily Streak <span className="badge bg-warning text-dark ms-1">Day {streakCount}</span></h6>
                                <p className="text-muted small mb-0">Claim every day to scale your reward! Miss a day, reset to Day 1.</p>
                            </div>
                        </div>
                    </div>
                    
                    <div className="d-flex justify-content-between mb-3 gap-1 px-1">
                        {[1, 2, 3, 4, 5, 6, 7].map(day => {
                            const isClaimed = day <= streakCount;
                            const isNext = day === streakCount + 1 && user?.daily_available;
                            
                            let bgClass = "bg-light text-muted border";
                            if (isClaimed) bgClass = "bg-success text-white shadow-sm border-success";
                            if (isNext) bgClass = "bg-warning text-dark shadow-sm border-warning border-2 fw-bold";
                            
                            return (
                                <div key={day} className={`d-flex flex-column align-items-center justify-content-center rounded py-1 flex-grow-1 ${bgClass}`} style={{fontSize: '0.7rem', transition: 'all 0.2s'}}>
                                    <span>D{day}</span>
                                    <span className="fw-bold mt-1">{day === 7 ? '🎁' : `+${Math.min(day, 7)}`}</span>
                                </div>
                            );
                        })}
                    </div>
                    
                    <button className={`btn w-100 rounded-pill fw-bold ${user?.daily_available ? 'btn-success shadow-sm' : 'btn-light text-muted border'}`} disabled={!user?.daily_available} onClick={() => socket.emit('claim_reward', {type: 'daily'})}>
                        {user?.daily_available ? `Claim Day ${currentDay} Reward` : 'Come back tomorrow'}
                    </button>
                </div>
            </div>

            {/* Earn Credit (Ads) */}
            <div className="card bg-white rounded-4 border shadow-sm mb-3">
                <div className="card-body p-3">
                    <div className="d-flex align-items-center gap-3 mb-3">
                        <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '45px', height: '45px', background: 'linear-gradient(135deg, #f59e0b 0%, #f43f5e 100%)'}}>
                            <i className="fas fa-tv fs-5"></i>
                        </div>
                        <div>
                            <h6 className="fw-bold mb-1">Earn Credit</h6>
                            <p className="text-muted small mb-0">Watch ads to earn Credits instantly.</p>
                        </div>
                    </div>
                    <div className="d-flex gap-2">
                        {renderAdBtn(1)}
                        {renderAdBtn(2)}
                    </div>
                </div>
            </div>

            {/* Invite Friends */}
            <div className="card bg-white rounded-4 border shadow-sm mb-3">
                <div className="card-body p-3">
                    <div className="d-flex align-items-center gap-3 mb-3">
                        <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '45px', height: '45px', background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)'}}>
                            <i className="fas fa-user-friends fs-5"></i>
                        </div>
                        <div>
                            <h6 className="fw-bold mb-1">Invite Friends</h6>
                            <p className="text-muted small mb-0">Invite 3 friends for 5 Credits!</p>
                        </div>
                    </div>
                    <div className="mb-3">
                        <div className="d-flex justify-content-between small fw-bold mb-1">
                            <span className="text-secondary">Progress</span>
                            <span className={isCompleted ? 'text-success' : 'text-primary'}>{inviteCount} / {goal}</span>
                        </div>
                        <div className="progress rounded-pill bg-light border shadow-sm" style={{height: '8px'}}>
                            <div className={`progress-bar rounded-pill ${isCompleted ? 'bg-success' : 'bg-primary'}`} style={{width: `${Math.min((inviteCount / goal) * 100, 100)}%`}}></div>
                        </div>
                    </div>
                    <div className="d-flex gap-2">
                        <button className="btn btn-primary flex-grow-1 rounded-pill fw-bold shadow-sm py-2 btn-sm" onClick={handleInvite}>
                            <i className="fas fa-paper-plane me-1"></i> Share Link
                        </button>
                        <button className={`btn flex-grow-1 rounded-pill fw-bold shadow-sm py-2 btn-sm ${isCompleted && !hasClaimed ? 'btn-success' : 'btn-light text-muted border'}`} disabled={!isCompleted || hasClaimed} onClick={handleClaim}>
                            {hasClaimed ? 'Claimed' : 'Claim 5 Credits'}
                        </button>
                    </div>
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

const LeaderboardView = ({ socket, setModal, setProfileModal }) => {
    const [activeTab, setActiveTab] = useState('inviters');
    const [inviters, setInviters] = useState([]);
    const [guessers, setGuessers] = useState([]);
    const [prevInviters, setPrevInviters] = useState([]);
    const [prevGuessers, setPrevGuessers] = useState([]);
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
                setInviters(data.inviters || []); 
                setGuessers(data.guessers || []);
                setPrevInviters(data.prevInviters || []);
                setPrevGuessers(data.prevGuessers || []);
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

    const renderList = (dataList, type, isPrevious = false) => {
        if (dataList.length === 0) return null;
        return (
            <div className={`card rounded-4 shadow-sm border overflow-hidden bg-white ${isPrevious ? 'opacity-75' : ''}`}>
                {dataList.map((l, index) => {
                    let rankStyle = "bg-primary text-white";
                    if (index === 0) rankStyle = "bg-warning text-dark";
                    if (index === 1) rankStyle = "bg-secondary text-white";
                    if (index === 2) rankStyle = "bg-danger text-white";

                    return (
                        <div key={l.tg_id} className={`d-flex align-items-center justify-content-between p-3 border-bottom ${index === 0 && !isPrevious ? 'bg-warning' : ''}`} style={{ '--bs-bg-opacity': '.1' }}>
                            <div className="d-flex align-items-center gap-2">
                                <div className={`rounded-circle d-flex align-items-center justify-content-center fw-bold shadow-sm flex-shrink-0 ${rankStyle}`} style={{width: '24px', height: '24px', fontSize: '0.75rem', zIndex: 1}}>
                                    {index + 1}
                                </div>
                                {l.avatar_url ? (
                                    <div className="flex-shrink-0 ms-2 cursor-pointer" onClick={() => setProfileModal && setProfileModal({user_id: l.tg_id, pic: l.avatar_url, gender: l.gender})}>
                                        <img src={l.avatar_url} className="rounded-circle shadow-sm border bg-white" style={{ width: '40px', height: '40px', objectFit: 'cover', borderColor: 'var(--primary)' }} alt="User"/>
                                    </div>
                                ) : (
                                    <div className="flex-shrink-0 ms-2 cursor-pointer" onClick={() => setProfileModal && setProfileModal({user_id: l.tg_id, pic: null, gender: l.gender})}>
                                        <div className="rounded-circle shadow-sm border bg-white d-flex align-items-center justify-content-center text-secondary" style={{ width: '40px', height: '40px', borderColor: 'var(--primary)' }}>
                                            <i className="fas fa-user fs-5"></i>
                                        </div>
                                    </div>
                                )}
                                <div className="d-flex flex-column ms-1" style={{minWidth: 0}}>
                                    <span className="fw-bold text-dark" style={{fontSize: '0.95rem'}}>{l.name || window.toHex(l.tg_id)}</span>
                                    {l.username && l.username !== 'unset' ? (
                                        <a href={`https://t.me/${l.username}`} target="_blank" rel="noopener noreferrer" className="text-muted text-truncate" style={{fontSize: '0.75rem', maxWidth: '120px', textDecoration: 'none'}}>
                                            @{l.username}
                                        </a>
                                    ) : null}
                                </div>
                            </div>
                            <div className="badge bg-light text-dark px-2 py-1 rounded-pill shadow-sm" style={{ fontSize: '0.85rem' }}>
                                {type === 'guessers' ? <i className="fas fa-check-circle text-success me-1"></i> : null}
                                {type === 'inviters' ? <i className="fas fa-user-plus text-primary me-1"></i> : null}
                                {type === 'donators' ? <i className="fas fa-star me-1" style={{color: '#d946ef'}}></i> : null}
                                {l.score || l.total_donated}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="container mt-4 pb-5">
            <div className="text-center mb-4">
                <i className="fas fa-trophy text-warning mb-2" style={{ fontSize: '3rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.1))' }}></i>
                <h3 className="fw-bold m-0">Leaderboard</h3>
                <p className="small text-muted">See the top players and supporters!</p>
            </div>

            <div className="lobby-tabs-wrapper mb-2 overflow-auto" style={{whiteSpace: 'nowrap'}}>
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

            <div className="alert alert-light border shadow-sm py-2 px-3 mb-4 d-flex justify-content-between align-items-center rounded-3">
                <span className="small text-muted fw-bold">
                    {activeTab === 'inviters' ? 'Current Week: Top Inviters' : (activeTab === 'guessers' ? 'Current Week: Top Guessers' : 'All-Time: Top Donators')}
                </span>
                <button className="btn btn-sm btn-link p-0 text-primary shadow-none" onClick={() => setModal({type: 'leaderboard_rules', activeTab})}>
                    <i className="fas fa-info-circle fs-5"></i>
                </button>
            </div>

            {loading ? (
                <div className="text-center mt-5">
                    <i className="fas fa-circle-notch fa-spin fs-2 text-primary"></i>
                    <p className="text-muted mt-2">Loading...</p>
                </div>
            ) : (
                <>
                {(activeTab === 'inviters' || activeTab === 'guessers') && (
                    <>
                        {(activeTab === 'inviters' ? inviters : guessers).length > 0 ? (
                            renderList(activeTab === 'inviters' ? inviters : guessers, activeTab, false)
                        ) : (
                            <div className="text-center mt-5 text-muted">
                                <i className={`fas ${activeTab === 'inviters' ? 'fa-users-slash' : 'fa-brain'} mb-3 text-secondary opacity-50`} style={{ fontSize: '3rem' }}></i>
                                <h5>No data yet this week!</h5>
                            </div>
                        )}
                        
                        {(activeTab === 'inviters' ? prevInviters : prevGuessers).length > 0 && (
                            <div className="mt-4">
                                <h6 className="fw-bold text-secondary mb-3"><i className="fas fa-history me-2"></i>Last Week's Top 5</h6>
                                {renderList(activeTab === 'inviters' ? prevInviters : prevGuessers, activeTab, true)}
                            </div>
                        )}
                    </>
                )}

                {activeTab === 'donators' && (
                    <>
                        <div className="text-center mb-3">
                            <button className="btn btn-primary rounded-pill px-4 py-2 fw-bold shadow-sm w-100 border border-primary border-2" onClick={() => window.open('https://t.me/doodledashbot?start=donate', '_blank')}>
                                <i className="fas fa-heart text-danger me-2"></i> Donate to get featured!
                            </button>
                        </div>
                        {donators.length > 0 ? (
                            renderList(donators, activeTab, false)
                        ) : (
                            <div className="text-center mt-5 text-muted">
                                <i className="fas fa-heart-broken mb-3 text-secondary opacity-50" style={{ fontSize: '3rem' }}></i>
                                <h5>No donations yet.</h5>
                                <p className="small">Be the first to support DoodleDash!</p>
                            </div>
                        )}
                    </>
                )}
                </>
            )}
        </div>
    );
};

const LobbyView = ({ user, rooms, setModal, socket, systemConfig }) => {
    const [searchId, setSearchId] = useState('');
    const [activeTab, setActiveTab] = useState('public');
    const [hideFull, setHideFull] = useState(false);
    
    const [touchStartPos, setTouchStartPos] = useState(null);

    const hasProfileSetup = !!user?.gender && !!user?.name;

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
            
            <div className="d-flex justify-content-between align-items-center mb-3">
                <h3 className="fw-bold m-0">Game Lobbies</h3>
                {!isRoomLimitReached ? (
                    <button className="btn btn-primary shadow-sm rounded-pill px-4" disabled={!hasProfileSetup} onClick={() => { if(hasProfileSetup) setModal({ type: 'create_room', title: 'Create Room' }) }}>
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
                {!hasProfileSetup && (
                    <div className="position-absolute top-0 start-0 w-100 h-100 d-flex flex-column align-items-center pt-5" style={{zIndex: 10, background: 'rgba(248, 250, 252, 0.85)', backdropFilter: 'blur(3px)', borderRadius: '16px', border: '1px solid #e2e8f0'}}>
                        <i className="fas fa-lock text-danger mb-3" style={{fontSize: '3rem'}}></i>
                        <h5 className="fw-bold text-dark">Profile Locked</h5>
                        <p className="text-muted small text-center px-4">Please set your Name and Gender in your Profile tab to enter game rooms.</p>
                    </div>
                )}

                <div className="input-group mb-4 shadow-sm rounded-pill overflow-hidden border bg-white">
                    <input type="text" className="form-control border-0 px-4 py-2" placeholder={`Search ${activeTab.replace('_', ' ')} Room...`} value={searchId} onChange={e => setSearchId(e.target.value)} disabled={!hasProfileSetup} />
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
                                            disabled={isFull || !hasProfileSetup}
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
        </div>
    );
};

window.ShopView = ShopView;
window.ProfileView = ProfileView;
window.TasksView = TasksView;
window.LeaderboardView = LeaderboardView;
window.LobbyView = LobbyView;
