const { useState, useEffect, useRef } = React;

const ChatBox = ({ chats, socket, tgId, user, roomData, setModal, systemConfig }) => {
    const [input, setInput] = useState('');
    const messagesEndRef = useRef(null);
    const isCreator = Boolean(roomData.room.is_private) && roomData.room.creator_id === tgId;
    
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chats]);

    const handleUnmute = () => {
        const botLink = `https://t.me/doodledashbot?start=unmute`;
        if (window.tg && window.tg.openTelegramLink) {
            try {
                window.tg.openTelegramLink(botLink);
                setTimeout(() => window.tg.close(), 300);
            } catch (e) {
                window.open(botLink, '_blank');
            }
        } else {
            window.open(botLink, '_blank');
        }
    };

    return (
        <div className="d-flex flex-column h-100" style={{overflow: 'hidden'}}>
            <div className="panel-body flex-grow-1" style={{overflowY: 'auto'}}>
                {chats.map(c => {
                    const photo = roomData?.photos?.[c.user_id];
                    const isDeleted = c.message === '[Deleted by admin]' || c.message === '[Deleted by room creator]';
                    
                    const isSystemOld = c.user_id === 'System';
                    const isSystemAction = c.is_system;
                    
                    const displayName = isSystemOld ? 'System' : window.getDisplayName(c.user_id, roomData?.names);
                    
                    if (isSystemAction) {
                        let sysColor = '#6c757d'; 
                        if (c.action_type === 'join' || c.action_type === 'hint') sysColor = '#3b82f6'; 
                        else if (c.action_type === 'left' || c.action_type === 'kicked') sysColor = '#ef4444'; 
                        else if (c.action_type === 'correct_guess') sysColor = '#10b981'; 

                        return (
                            <div key={c.id} className="text-center my-1" style={{ fontSize: '0.85rem' }}>
                                <span style={{ color: sysColor }}>
                                    <span className="fw-bold">{displayName}</span> {c.message}
                                </span>
                            </div>
                        );
                    }
                    
                    const styleClass = isSystemOld ? '' : window.getStyleClass(c.equipped_style || roomData?.styles?.[c.user_id], systemConfig);
                    
                    return (
                        <div key={c.id} 
                             className={`msg-box d-flex gap-2 ${isSystemOld ? 'sys' : ''}`} 
                             style={{ 
                                 borderLeft: c.user_id === tgId && !isSystemAction ? '4px solid var(--primary)' : '', 
                                 cursor: (!isSystemOld && !isDeleted) ? 'pointer' : 'default'
                             }}
                             onClick={() => {
                                 if (isSystemOld || isDeleted) return;
                                 if (setModal) {
                                     if (c.user_id !== tgId || isCreator) {
                                         setModal({ type: 'chat_action', message: c, isCreator });
                                     }
                                 }
                             }}>
                            {!isSystemOld && (
                                photo ? 
                                    <img src={photo} className="rounded-circle flex-shrink-0 border" width="28" height="28" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="User"/> : 
                                    <i className="fas fa-user-circle fs-4 text-secondary flex-shrink-0 mt-1 bg-white rounded-circle"></i>
                            )}
                            <div className="d-flex flex-column w-100">
                                <small className={`fw-bold ${styleClass || ''}`} 
                                       style={styleClass ? {fontSize: '0.85rem'} : {fontSize: '0.75rem', color: (c.user_id === tgId || isSystemOld) ? 'var(--primary)' : '#64748b', lineHeight: '1'}}
                                       data-name={displayName}>
                                    {displayName}
                                </small>
                                <span style={{
                                    marginTop: '2px', 
                                    fontStyle: isDeleted ? 'italic' : 'normal', 
                                    color: isDeleted ? '#94a3b8' : 'inherit',
                                    fontWeight: 'normal'
                                }}>
                                    {c.message}
                                </span>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
                
                {isCreator && chats.length > 0 && (
                    <div className="text-center mt-3 mb-2">
                        <button className="btn btn-sm btn-outline-danger rounded-pill shadow-sm" onClick={() => setModal({ type: 'confirm_clear_chat' })}>
                            <i className="fas fa-trash-alt"></i> Clear All Messages
                        </button>
                    </div>
                )}
            </div>
            
            <div className="chat-input-wrapper d-flex align-items-end mt-auto gap-2" style={{padding: '10px 15px', backgroundColor: 'white', borderTop: '1px solid #e2e8f0'}}>
                {user?.status === 'mute' ? (
                    <button 
                        className="btn btn-danger w-100 rounded-pill fw-bold shadow-sm d-flex align-items-center justify-content-center gap-2"
                        style={{ height: '45px' }}
                        onClick={handleUnmute}
                    >
                        <i className="fas fa-volume-mute"></i> Unmute in Bot
                    </button>
                ) : (
                    <>
                        <textarea
                            className="form-control bg-light border-0"
                            style={{ resize: 'none', minHeight: '40px', maxHeight: '80px', borderRadius: '20px', padding: '10px 15px', overflowY: 'auto' }}
                            rows={1}
                            value={input}
                            maxLength={200}
                            placeholder="Type message..."
                            onChange={(e) => {
                                setInput(e.target.value);
                                e.target.style.height = 'auto';
                                e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    if (input.trim()) {
                                        socket.emit('chat', {message: input.trim()});
                                        setInput('');
                                        e.target.style.height = 'auto';
                                    }
                                }
                            }}
                        />
                        <button
                            className="btn btn-primary rounded-circle flex-shrink-0 shadow-sm"
                            style={{width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
                            onClick={() => {
                                if (input.trim()) {
                                    socket.emit('chat', {message: input.trim()});
                                    setInput('');
                                    const ta = document.querySelector('.chat-input-wrapper textarea');
                                    if (ta) ta.style.height = 'auto';
                                }
                            }}>
                            <i className="fas fa-paper-plane"></i>
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

window.ChatBox = ChatBox;