const { useState, useEffect } = React;
const ProfileLockedOverlay = window.ProfileLockedOverlay;

const LeaderboardView = ({ user, socket, setModal, setProfileModal, systemConfig }) => {
    const hasProfileSetup = !!user?.gender && !!user?.name;
    const [activeTab, setActiveTab] = useState('inviters');
    const [inviters, setInviters] = useState([]);
    const [guessers, setGuessers] = useState([]);
    const [prevInviters, setPrevInviters] = useState([]);
    const [prevGuessers, setPrevGuessers] = useState([]);
    const [donators, setDonators] = useState([]);
    const [loading, setLoading] = useState(true);

    const [touchStartPos, setTouchStartPos] = useState(null);
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
            if (activeTab === 'inviters') setActiveTab('guessers');
            else if (activeTab === 'guessers') setActiveTab('donators');
        } else if (diffX < -50) {
            if (activeTab === 'donators') setActiveTab('guessers');
            else if (activeTab === 'guessers') setActiveTab('inviters');
        }
        setTouchStartPos(null);
    };

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
        let displayList = dataList;

        if (isPrevious) {
            displayList = dataList.filter(l => !l.isCurrentUserAppend);
            if (displayList.length === 0) {
                return (
                    <div className="card rounded-4 shadow-sm border bg-white text-center p-4 mt-2 opacity-75">
                        <i className="fas fa-history fs-3 mb-2 text-secondary opacity-50"></i>
                        <p className="small mb-0 text-muted">No data is available for last week.</p>
                    </div>
                );
            }
        }

        const mainList = displayList.filter(l => !l.isCurrentUserAppend);
        const appendedUser = displayList.find(l => l.isCurrentUserAppend);

        const renderRow = (l, index, isAppended) => {
            const styleClass = window.getStyleClass(l.equipped_style, systemConfig);
            const displayScore = (l.score !== undefined && l.score !== null) ? l.score : ((l.total_donated !== undefined && l.total_donated !== null) ? l.total_donated : 0);
            
            const rowUserId = l.tg_id || l.user_id || l.id;
            const currentUserId = user?.tg_id || user?.id;
            const isCurrentUser = isAppended || l.isCurrentUserAppend || (currentUserId && rowUserId && String(rowUserId) === String(currentUserId));

            return (
                <div key={(rowUserId || index) + (isAppended ? '-appended' : '')} className={`d-flex align-items-center justify-content-between p-3 ${!isAppended && index < mainList.length - 1 ? 'border-bottom' : ''} ${index === 0 && !isPrevious && !isAppended ? 'bg-warning' : ''} ${isAppended ? 'bg-light' : ''}`} style={(!isAppended && index === 0 && !isPrevious) ? { '--bs-bg-opacity': '.1' } : {}}>
                    <div className="d-flex align-items-center gap-2">
                        {l.avatar_url ? (
                            <div className="flex-shrink-0 ms-2 cursor-pointer" onClick={() => setModal({type: 'profile_view', user_id: rowUserId, pic: l.avatar_url, gender: l.gender, name: l.name, username: l.username, style: l.equipped_style})}>
                                <img src={l.avatar_url} className="rounded-circle shadow-sm border bg-white" style={{ width: '40px', height: '40px', objectFit: 'cover', borderColor: 'var(--primary)' }} alt="User"/>
                            </div>
                        ) : (
                            <div className="flex-shrink-0 ms-2 cursor-pointer" onClick={() => setModal({type: 'profile_view', user_id: rowUserId, pic: null, gender: l.gender, name: l.name, username: l.username, style: l.equipped_style})}>
                                <div className="rounded-circle shadow-sm border bg-white d-flex align-items-center justify-content-center text-secondary" style={{ width: '40px', height: '40px', borderColor: 'var(--primary)' }}>
                                    <i className="fas fa-user fs-5"></i>
                                </div>
                            </div>
                        )}
                        <div className="d-flex flex-column ms-1" style={{minWidth: 0}}>
                            <div className="d-flex align-items-center">
                                <span className={`fw-bold ${styleClass ? styleClass : (isAppended ? 'text-primary' : 'text-dark')}`} data-name={l.name || window.toHex(rowUserId)} style={{fontSize: '0.95rem'}}>
                                    {l.name || window.toHex(rowUserId)}
                                </span>
                                {isCurrentUser && (
                                    <span className="badge bg-primary text-white ms-2 rounded-pill shadow-sm" style={{fontSize:'0.55rem', padding:'0.35em 0.6em'}}>YOU</span>
                                )}
                            </div>
                            {l.username && l.username !== 'unset' ? (
                                <a href={`https://t.me/${l.username}`} target="_blank" rel="noopener noreferrer" className="text-muted text-truncate" style={{fontSize: '0.75rem', maxWidth: '120px', textDecoration: 'none'}}>
                                    @{l.username}
                                </a>
                            ) : null}
                        </div>
                    </div>
                    <div className="badge bg-white text-dark border px-2 py-1 rounded-pill shadow-sm d-flex align-items-center gap-1" style={{ fontSize: '0.75rem' }}>
                        {type === 'guessers' ? <i className="fas fa-check-circle text-dark" style={{fontSize: '0.6rem'}}></i> : null}
                        {type === 'inviters' ? <i className="fas fa-user-plus text-dark" style={{fontSize: '0.6rem'}}></i> : null}
                        {type === 'donators' ? <i className="fas fa-star" style={{color: '#d946ef', fontSize: '0.6rem'}}></i> : null}
                        <span className="text-dark fw-bold">{displayScore}</span>
                    </div>
                </div>
            );
        };

        return (
            <div className={`d-flex flex-column ${isPrevious ? 'opacity-75' : ''}`}>
                {mainList.length > 0 && (
                    <div className="card rounded-4 shadow-sm border overflow-hidden bg-white">
                        {mainList.map((l, index) => renderRow(l, index, false))}
                    </div>
                )}
                {appendedUser && (
                    <div className={`card rounded-4 shadow-sm border overflow-hidden bg-white border-2 border-primary ${mainList.length > 0 ? 'mt-3' : ''}`}>
                        {renderRow(appendedUser, 0, true)}
                    </div>
                )}
            </div>
        );
    };

    const isEligibleForInviterReward = prevInviters.some(p => p.tg_id === user?.tg_id);
    const hasClaimedInviterReward = user?.top_inviter_claimed;

    let rewardCardStyle = {};
    let rewardIconClass = "fas fa-box-open";
    let rewardIconColor = "text-success";
    let titleColor = "text-dark";
    let subtitleText = "Finished in last week's Top 5? Click to claim 5 Gems!";

    if (hasClaimedInviterReward) {
        rewardCardStyle = { background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)', borderColor: '#bbf7d0', opacity: 0.7, cursor: 'default' };
        rewardIconColor = "text-success opacity-50";
        titleColor = "text-success";
        subtitleText = "You have already claimed this reward!";
    } else if (!isEligibleForInviterReward) {
        rewardCardStyle = { background: '#f8f9fa', borderColor: '#dee2e6', cursor: 'default' };
        rewardIconColor = "text-secondary opacity-50";
        titleColor = "text-muted";
        subtitleText = "Reach Top 5 next week to claim this reward!";
    } else {
        rewardCardStyle = { background: 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)', borderColor: '#bbf7d0', cursor: 'pointer' };
        rewardIconColor = "text-success";
    }

    return (
        <div className="container mt-4 pb-5 position-relative" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} style={{ minHeight: '80vh' }}>
            {!hasProfileSetup && <ProfileLockedOverlay />}
            
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
                                
                                {activeTab === 'inviters' && (
                                    <div className={`card rounded-4 shadow-sm border mt-3 text-center p-3 ${isEligibleForInviterReward && !hasClaimedInviterReward && hasProfileSetup ? 'hover-up cursor-pointer' : ''}`} onClick={() => { if(isEligibleForInviterReward && !hasClaimedInviterReward && hasProfileSetup) socket.emit('claim_top_inviter_reward'); }} style={rewardCardStyle}>
                                        <div className="d-flex flex-column align-items-center justify-content-center py-2">
                                            <div className="position-relative mb-2">
                                                <i className={`${rewardIconClass} ${rewardIconColor}`} style={{ fontSize: '3rem', filter: isEligibleForInviterReward && !hasClaimedInviterReward ? 'drop-shadow(0 4px 6px rgba(0,0,0,0.15))' : 'none' }}></i>
                                                {(!hasClaimedInviterReward && isEligibleForInviterReward) && (
                                                    <i className="fas fa-gem position-absolute top-0 start-100 translate-middle text-info" style={{ fontSize: '1.5rem', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))' }}></i>
                                                )}
                                            </div>
                                            <h6 className={`fw-bold mb-1 ${titleColor}`}>Weekly Top Inviter Reward</h6>
                                            <p className={`small mb-0 ${hasClaimedInviterReward ? 'text-success opacity-75' : 'text-muted'}`}>{subtitleText}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}

                {activeTab === 'donators' && (
                    <>
                        <div className="text-center mb-3">
                            <button className="btn btn-primary rounded-pill px-4 py-2 fw-bold shadow-sm w-100 border border-primary border-2" disabled={!hasProfileSetup} onClick={() => { if(hasProfileSetup) window.open('https://t.me/doodledashbot?start=donate', '_blank')}}>
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

window.LeaderboardView = LeaderboardView;