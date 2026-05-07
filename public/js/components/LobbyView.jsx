const { useState, useEffect } = React;
const ProfileLockedOverlay = window.ProfileLockedOverlay;

const LobbyView = ({ user, rooms, setModal, socket, systemConfig }) => {
    const hasProfileSetup = !!user?.gender && !!user?.name;
    const [searchId, setSearchId] = useState('');
    const [activeTab, setActiveTab] = useState('public');
    const [hideFull, setHideFull] = useState(false);

    const [touchStartPos, setTouchStartPos] = useState(null);

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
    const isRoomLimitReached = totalRooms >= (systemConfig?.maxRooms || 1250);

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
                {isRoomLimitReached && (
                    <div className="text-muted small fw-bold text-end">
                        <i className="fas fa-ban text-danger"></i> Server Full.
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
                {!hasProfileSetup && <ProfileLockedOverlay text="Please set your Name and Gender in your Profile tab to enter game rooms." />}

                <div className="input-group mb-4 shadow-sm rounded-pill overflow-hidden border bg-white">
                    <input type="text" className="form-control border-0 px-4 py-2" placeholder={`Search ${activeTab.replace('_', ' ')} Room...`} value={searchId} onChange={e => setSearchId(e.target.value)} disabled={!hasProfileSetup} />
                </div>

                {activeTab === 'public' && (
                    <div className="mb-4">
                        <div className="card bg-white border-0 shadow-sm rounded-4 overflow-hidden position-relative">
                            <div className="position-absolute top-0 start-0 w-100 h-100" style={{background: 'linear-gradient(135deg, rgba(16,185,129,0.1) 0%, rgba(5,150,105,0.05) 100%)', zIndex: 0}}></div>
                            <div className="card-body p-4 text-center position-relative" style={{zIndex: 1}}>
                                <h5 className="fw-bold text-dark mb-2">Ready to Dash?</h5>
                                <p className="text-muted small mb-3">Jump right into the action with a random public lobby!</p>
                                <button
                                    className="btn rounded-pill fw-bold shadow-sm px-4 py-2 hover-up"
                                    style={{ background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', color: 'white', border: 'none' }}
                                    onClick={() => socket.emit('join_random_public')}
                                    disabled={!hasProfileSetup}
                                >
                                    <i className="fas fa-play me-2"></i> Play Now
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'private' && (
                    <div className="mb-4">
                        <div className="card bg-white border-0 shadow-sm rounded-4 overflow-hidden position-relative">
                            <div className="position-absolute top-0 start-0 w-100 h-100" style={{background: 'linear-gradient(135deg, rgba(244,63,94,0.1) 0%, rgba(225,29,72,0.05) 100%)', zIndex: 0}}></div>
                            <div className="card-body p-4 text-center position-relative" style={{zIndex: 1}}>
                                <h5 className="fw-bold text-dark mb-2">Host a Game</h5>
                                <p className="text-muted small mb-3">Create a private room to play with your friends.</p>
                                <button
                                    className="btn rounded-pill fw-bold shadow-sm px-4 py-2 hover-up"
                                    style={{ background: 'linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)', color: 'white', border: 'none' }}
                                    onClick={() => setModal({ type: 'create_room', title: 'Create Room' })}
                                    disabled={!hasProfileSetup || isRoomLimitReached}
                                >
                                    <i className="fas fa-user-friends me-2"></i> Play with Friends
                                </button>
                            </div>
                        </div>
                    </div>
                )}

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

window.LobbyView = LobbyView;