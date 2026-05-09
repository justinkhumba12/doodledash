const GameRoom = ({ roomData, tgId, socket, setProfileModal, setModal, systemConfig }) => {
    const { room, members } = roomData;
    const sortedMembers = [...members].sort((a, b) => a.joined_at - b.joined_at);

    const prevStatusRef = React.useRef(room.status);
    const [hintCooldown, setHintCooldown] = React.useState(false);
    const [cooldownTimeLeft, setCooldownTimeLeft] = React.useState(0);
    
    React.useEffect(() => {
        if (room.status === 'REVEAL' && prevStatusRef.current !== 'REVEAL') {
            setModal({
                type: 'round_reveal',
                round_leaderboard: room.round_leaderboard,
                correct_word: room.correct_word || room.word_to_draw
            });
        }
        prevStatusRef.current = room.status;
    }, [room.status, room.round_leaderboard, room.correct_word, room.word_to_draw, setModal]);

    React.useEffect(() => {
        let interval;
        if (room.status === 'DRAWING' && room.drawing_start_time) {
            const checkCooldown = () => {
                const elapsed = Date.now() - new Date(room.drawing_start_time).getTime();
                if (elapsed < 15000) {
                    setHintCooldown(true);
                    setCooldownTimeLeft(Math.ceil((15000 - elapsed) / 1000));
                } else {
                    setHintCooldown(false);
                    setCooldownTimeLeft(0);
                }
            };
            checkCooldown();
            interval = setInterval(checkCooldown, 1000);
        } else {
            setHintCooldown(false);
            setCooldownTimeLeft(0);
        }
        return () => clearInterval(interval);
    }, [room.status, room.drawing_start_time]);

    return (
        <div className="row pb-5">
            <div className="col-12 col-lg-8 mx-auto">
                <div className="whiteboard-wrapper">
                    
                    {(roomData.room.status === 'DRAWING' && roomData.masked_word) ? (
                    <div className="word-hint-container w-100 d-flex flex-nowrap align-items-center justify-content-between gap-3 mb-3">
                        <div className="masked-word-box d-flex flex-wrap justify-content-center gap-2 rounded shadow-sm">
                            {roomData.masked_word.map((item, i) => {
                                const isDrawer = roomData.room.current_drawer_id === tgId;
                                const showChar = isDrawer || item.revealed;
                                const isRevealedToAll = item.revealed;
                                const isSpace = item.char === ' ';

                                let boxClass = 'hidden-letter';
                                if (isSpace) {
                                    boxClass = 'space-box';
                                } else if (isRevealedToAll) {
                                    boxClass = 'revealed-letter hint-reveal';
                                } else if (isDrawer) {
                                    boxClass = 'drawer-hidden-letter';
                                }

                                return (
                                    <div 
                                        key={i}
                                        className={`letter-box d-flex align-items-center justify-content-center rounded shadow-sm fw-bold ${boxClass}`}
                                    >
                                        {showChar && !isSpace ? item.char : ''}
                                    </div>
                                );
                            })}
                        </div>
                        {roomData.room.current_drawer_id !== tgId && (
                            <button
                                className={`hint-btn btn rounded-circle shadow d-flex align-items-center justify-content-center ${hintCooldown ? 'opacity-75' : ''}`}
                                onClick={() => {
                                    if (hintCooldown) return;
                                    setModal({ type: 'confirm_buy_hint' });
                                }}
                                title={hintCooldown ? `Hints available in ${cooldownTimeLeft}s` : "Get a Hint (1 Credit)"}
                                disabled={hintCooldown}
                            >
                                <i className="fas fa-lightbulb"></i>
                                {hintCooldown && <span className="cooldown-text">{cooldownTimeLeft}s</span>}
                            </button>
                        )}
                    </div>
                ) : null}

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