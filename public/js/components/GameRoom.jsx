const GameRoom = ({ roomData, tgId, socket, setProfileModal, setModal, systemConfig }) => {
    const { room, members } = roomData;
    const sortedMembers = [...members].sort((a, b) => a.joined_at - b.joined_at);

    React.useEffect(() => {
        if (roomData.room.status === 'REVEAL') {
            setModal({ type: 'round_result' });
        }
    }, [roomData.room.status, setModal]);

    return (
        <div className="row pb-5">
            <div className="col-12 col-lg-8 mx-auto">
                <div className="whiteboard-wrapper">
                    
                    {(roomData.room.status === 'DRAWING' && roomData.masked_word) ? (
                    <div className="w-100 d-flex flex-column align-items-center mb-3">
                        <div className="w-100 d-flex flex-wrap justify-content-center gap-2 bg-light p-2 rounded-pill shadow-sm">
                            {roomData.masked_word.map((item, i) => (
                                <div 
                                    key={i}
                                    className={`d-flex align-items-center justify-content-center rounded shadow-sm fw-bold fs-5 ${item.revealed ? 'bg-success text-white hint-reveal' : 'bg-secondary text-white cursor-pointer'}`}
                                    style={{ width: '35px', height: '35px', transition: '0.2s' }}
                                    onClick={() => {
                                        if (!item.revealed && roomData.room.current_drawer_id !== tgId) {
                                            setModal({ type: 'confirm_buy_hint', index: item.index });
                                        }
                                    }}
                                    title={!item.revealed && roomData.room.current_drawer_id !== tgId ? "Click to reveal (1 Credit)" : ""}
                                >
                                    {item.revealed ? item.char : '?'}
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                {roomData.room.status === 'REVEAL' && (
                    <div className="reveal-leaderboard mb-4 p-4 rounded shadow text-center bg-white border border-3 border-primary animate__animated animate__fadeIn">
                        <h4 className="fw-bold text-primary mb-1 text-uppercase tracking-wider">Round Ended!</h4>
                        <h2 className="fw-bold text-dark mb-4">
                            WORD: <span className="text-success text-uppercase">{roomData.room.correct_word || roomData.room.word_to_draw || '?'}</span>
                        </h2>
                        
                        {roomData.room.round_leaderboard && roomData.room.round_leaderboard.length > 0 ? (
                            <div className="leaderboard-list d-flex flex-column gap-2 mx-auto" style={{maxWidth: '400px'}}>
                                {roomData.room.round_leaderboard.map((entry, idx) => {
                                    const displayName = window.getDisplayName(entry.user_id, roomData?.names);
                                    const photo = roomData?.photos?.[entry.user_id];
                                    const styleClass = window.getStyleClass(roomData.styles?.[entry.user_id], systemConfig) || 'text-dark';
                                    return (
                                        <div key={entry.user_id} className="d-flex align-items-center justify-content-between p-2 bg-light rounded shadow-sm border border-light">
                                            <div className="d-flex align-items-center gap-3">
                                                <div className="fw-bold text-secondary" style={{width: '20px'}}>{idx + 1}.</div>
                                                {photo ? (
                                                    <img src={photo} className="rounded-circle border" width="35" height="35" style={{objectFit: 'cover'}} alt="Player"/>
                                                ) : (
                                                    <i className="fas fa-user-circle fs-3 text-secondary bg-white rounded-circle"></i>
                                                )}
                                                <span className={`fw-bold ${styleClass}`} style={{fontSize: '1rem'}}>{displayName}</span>
                                            </div>
                                            <span className="badge bg-success rounded-pill px-3 py-2 fs-6 shadow-sm">+{entry.points} pts</span>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="p-3 bg-light rounded text-muted fw-bold">No points were awarded this round.</div>
                        )}
                    </div>
                )}

                <Whiteboard roomData={roomData} tgId={tgId} socket={socket} setModal={setModal} systemConfig={systemConfig} />

                    <div className="mt-4 w-100">
                        <h6 className="fw-bold text-secondary mb-3">Drawing Queue</h6>
                        {sortedMembers.map(m => {
                            const photo = roomData?.photos?.[m.user_id];
                            
                            const isDrawer = room.current_drawer_id === m.user_id && (room.status === 'DRAWING' || room.status === 'PRE_DRAW');
                            
                            const styleClass = window.getStyleClass(roomData.styles?.[m.user_id], systemConfig) || 'text-dark';
                            const displayName = window.getDisplayName(m.user_id, roomData?.names);

                            return (
                                <div key={m.user_id} className="d-flex align-items-center justify-content-between p-2 bg-white shadow-sm rounded mb-2 border-start border-4" style={{borderColor: isDrawer ? 'var(--primary)' : 'transparent'}}>
                                    <div className="d-flex align-items-center">
                                        <div onClick={() => setModal({
                                            type: 'profile_view', 
                                            user_id: m.user_id, 
                                            pic: photo, 
                                            gender: roomData.genders?.[m.user_id], 
                                            name: roomData.names?.[m.user_id],
                                            username: roomData.usernames?.[m.user_id],
                                            style: roomData.styles?.[m.user_id]
                                        })} className="cursor-pointer position-relative">
                                            {photo ? 
                                                <img src={photo} className="rounded-circle me-2 border" width="30" height="30" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Player"/> : 
                                                <i className="fas fa-user-circle fs-3 text-secondary me-2 bg-white rounded-circle"></i>
                                            }
                                        </div>
                                        <div className="d-flex flex-column">
                                            <div className="d-flex align-items-baseline gap-1 flex-wrap">
                                                <span className={`fw-bold ${styleClass}`} style={{fontSize: '0.85rem'}} data-name={displayName}>
                                                    {displayName}
                                                </span>
                                                {m.user_id === tgId ? <small className="text-muted" style={{fontSize: '0.7em'}}>(You)</small> : null}
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className="d-flex align-items-center gap-2">
                                        {room.is_private === 1 && room.creator_id === window.tgId && m.user_id !== window.tgId && (
                                            <button className="btn btn-sm btn-outline-danger py-0 px-1 rounded" title="Kick Player" onClick={() => setModal({type: 'kick_player', target_id: m.user_id})}><i className="fas fa-times"></i></button>
                                        )}
                                        {isDrawer ? (
                                            <span className="badge rounded-circle bg-primary shadow-sm d-flex align-items-center justify-content-center" style={{width: '22px', height: '22px', padding: 0, fontSize: '0.65rem'}} title="Drawing">
                                                <i className="fas fa-paint-brush"></i>
                                            </span>
                                        ) : m.is_ready ? (
                                            <span className="badge rounded-circle bg-success shadow-sm d-flex align-items-center justify-content-center" style={{width: '22px', height: '22px', padding: 0, fontSize: '0.65rem'}} title="Ready">
                                                <i className="fas fa-check"></i>
                                            </span>
                                        ) : (
                                            <span className="badge rounded-circle bg-secondary shadow-sm d-flex align-items-center justify-content-center" style={{width: '22px', height: '22px', padding: 0, fontSize: '0.65rem'}} title="Waiting">
                                                <i className="fas fa-hourglass-half"></i>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
};

window.GameRoom = GameRoom;