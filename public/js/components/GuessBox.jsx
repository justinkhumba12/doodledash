const { useState, useEffect, useRef } = React;

const GuessBox = ({ guesses, tgId, roomData, socket, setModal, systemConfig }) => {
    const [rawInput, setRawInput] = useState('');
    const isDrawer = roomData.room.current_drawer_id === tgId;
    const messagesEndRef = useRef(null);

    const myGuessesCount = guesses.filter(g => g.user_id === tgId).length;
    const myMemberData = roomData.members.find(m => m.user_id === tgId);
    
    const purchasedGuesses = myMemberData?.purchased_guesses || 0;
    const totalGuessesAllowed = 4 + purchasedGuesses;
    const guessesLeft = Math.max(0, totalGuessesAllowed - myGuessesCount);
    const hasGivenUp = myMemberData?.has_given_up;

    const totalGuessers = Math.max(0, roomData.members.length - 1);
    const givenUpCount = roomData.members.filter(m => m.user_id !== roomData.room.current_drawer_id && m.has_given_up).length;

    const wordData = (roomData.room.status === 'DRAWING' && roomData.masked_word) ? roomData.masked_word : null;
    const wordLength = wordData ? wordData.length : 10;
    const unrevealedCount = wordData ? wordData.filter(w => !w.revealed).length : wordLength;

    useEffect(() => {
        if (rawInput.length > unrevealedCount) {
            setRawInput(rawInput.slice(0, unrevealedCount));
        }
    }, [unrevealedCount, rawInput]);

    const reconstructGuess = () => {
        if (!wordData) return rawInput;
        let result = '';
        let rawIdx = 0;
        for (const item of wordData) {
            if (item.revealed) {
                result += item.char;
            } else {
                result += rawInput[rawIdx] || ' ';
                rawIdx++;
            }
        }
        return result;
    };

    const handleGuessSubmit = () => {
        if (guessesLeft <= 0) return;
        if (rawInput.length !== unrevealedCount) {
            setModal({ type: 'error', title: 'Invalid Guess', content: `Please fill in all ${unrevealedCount} missing letters.`});
            return;
        }
        
        const fullGuess = reconstructGuess();
        if (socket) socket.emit('guess', {guess: fullGuess});
        setRawInput('');
    };

    const handleInputChange = (e) => {
        const val = e.target.value.toUpperCase();
        if (val.length <= unrevealedCount) {
            setRawInput(val);
        }
    };

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [guesses]);
    
    // Convert to a strict boolean so React doesn't render a truthy/falsy numeric value (like 0)
    const showGiveUpButton = Boolean(isDrawer || guessesLeft <= 0 || hasGivenUp);

    return (
        <div className="d-flex flex-column h-100" style={{overflow: 'hidden'}}>
            <div className="panel-body flex-grow-1" style={{overflowY: 'auto'}}>
                {guesses.map(g => {
                    const photo = roomData?.photos?.[g.user_id];
                    const displayName = window.getDisplayName(g.user_id, roomData?.names);
                    const styleClass = window.getStyleClass(g.equipped_style || roomData?.styles?.[g.user_id], systemConfig);
                    
                    return (
                        <div key={g.id} className={`msg-box d-flex gap-2 ${g.is_correct ? 'guess-correct' : 'bg-light'}`} style={{ borderLeft: g.user_id === tgId && !g.is_correct ? '4px solid var(--primary)' : '' }}>
                            {photo ? 
                                <img src={photo} className="rounded-circle flex-shrink-0 border" width="28" height="28" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="User"/> : 
                                <i className="fas fa-user-circle fs-4 text-secondary flex-shrink-0 mt-1 bg-white rounded-circle"></i>
                            }
                            <div className="d-flex flex-column w-100">
                                <small className={`fw-bold ${styleClass || ''}`} 
                                       style={styleClass ? {fontSize: '0.85rem'} : {fontSize: '0.75rem', color: g.user_id === tgId ? 'var(--primary)' : '#64748b', lineHeight: '1'}}
                                       data-name={displayName}>
                                    {displayName}
                                </small>
                                <span style={{marginTop: '2px'}}>{g.guess_text}</span>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>
            
            {roomData.room.status === 'DRAWING' || roomData.room.status === 'PRE_DRAW' ? (
                <div className="chat-input-wrapper d-flex flex-column mt-auto pb-3">
                    
                    {showGiveUpButton && (
                        <button 
                            className={`btn mb-2 rounded-pill shadow-sm fw-bold ${hasGivenUp ? 'btn-secondary text-light' : 'btn-warning text-dark'}`} 
                            onClick={() => {
                                setModal({ type: isDrawer ? 'confirm_drawer_give_up' : 'confirm_guesser_give_up', title: 'Confirm Give Up' });
                            }}
                            disabled={!isDrawer && hasGivenUp}
                        >
                            <i className="fas fa-flag"></i> 
                            {isDrawer ? 'Give Up Turn' : (hasGivenUp ? `Voted Give Up (${givenUpCount}/${totalGuessers})` : 'Give Up Round')}
                        </button>
                    )}

                    {roomData.room.status === 'DRAWING' && (!isDrawer && !hasGivenUp) ? (
                        guessesLeft > 0 ? (
                            <div className="d-flex w-100 align-items-center bg-light rounded-pill p-1 shadow-sm position-relative border" style={{height: '42px'}}>
                                <div className="flex-grow-1 position-relative d-flex justify-content-center align-items-center h-100" style={{overflow: 'hidden'}}>
                                    
                                    <div className="d-flex gap-1 h-100 position-absolute pointer-events-none w-100 px-2 justify-content-center" style={{zIndex: 1, pointerEvents: 'none'}}>
                                        {wordData ? (
                                            (() => {
                                                let rawIdx = 0;
                                                return wordData.map((item, i) => {
                                                    let displayChar = '';
                                                    let isHint = item.revealed;
                                                    let showCursor = false;
                                                    if (isHint) {
                                                        displayChar = item.char;
                                                    } else {
                                                        displayChar = rawInput[rawIdx] || '';
                                                        if (rawIdx === rawInput.length) showCursor = true;
                                                        rawIdx++;
                                                    }
                                                    return (
                                                        <div key={i} className={`d-flex align-items-center justify-content-center fw-bold fs-5 bg-white border rounded shadow-sm position-relative ${isHint ? 'text-success bg-light' : 'text-dark'}`} style={{width: '32px', height: '100%', borderColor: '#cbd5e1'}}>
                                                            {displayChar}
                                                            {showCursor && <span className="position-absolute" style={{ animation: 'blink 1s step-end infinite', borderRight: '2px solid #1e293b', height: '60%' }}></span>}
                                                        </div>
                                                    );
                                                })
                                            })()
                                        ) : (
                                            Array.from({length: wordLength}).map((_, i) => {
                                                const showCursor = (i === rawInput.length);
                                                return (
                                                    <div key={i} className="d-flex align-items-center justify-content-center fw-bold fs-5 bg-white border rounded shadow-sm position-relative" style={{width: '32px', height: '100%', borderColor: '#cbd5e1', color: '#1e293b'}}>
                                                        {rawInput[i] || ''}
                                                        {showCursor && <span className="position-absolute" style={{ animation: 'blink 1s step-end infinite', borderRight: '2px solid #1e293b', height: '60%' }}></span>}
                                                    </div>
                                                );
                                            })
                                        )}
                                    </div>
                                    
                                    <input type="text"
                                        className="form-control position-absolute w-100 h-100 border-0 bg-transparent text-transparent"
                                        style={{opacity: 0, zIndex: 10, cursor: 'text'}}
                                        value={rawInput}
                                        onChange={handleInputChange}
                                        onKeyPress={e => e.key === 'Enter' && handleGuessSubmit()}
                                        maxLength={unrevealedCount}
                                        autoComplete="off"
                                        autoCorrect="off"
                                        spellCheck="false"
                                    />
                                </div>
                                <button className="btn btn-primary rounded-pill ms-2 px-3 h-100" style={{zIndex: 11}} onClick={handleGuessSubmit} disabled={rawInput.length !== unrevealedCount}>
                                    <i className="fas fa-paper-plane"></i>
                                </button>
                            </div>
                        ) : (
                            <button className="btn btn-success w-100 rounded-pill shadow-sm fw-bold d-flex align-items-center justify-content-center gap-2 mt-1" style={{height: '42px'}} onClick={() => socket && socket.emit('buy_guesses')}>
                                <i className="fas fa-lock"></i> Buy 2 Guesses for 1 Credit
                            </button>
                        )
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

window.GuessBox = GuessBox;