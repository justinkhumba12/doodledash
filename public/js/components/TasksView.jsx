const { useState, useEffect } = React;
const ProfileLockedOverlay = window.ProfileLockedOverlay;

const TasksView = ({ user, socket, setModal, systemConfig }) => {
    const hasProfileSetup = !!user?.gender && !!user?.name;
    const [adState, setAdState] = useState({ show: false });

    const inviteCount = user?.weekly_invites || 0;
    const goal = 3;
    const isCompleted = inviteCount >= goal;
    const hasClaimed = user?.invite_claimed_this_week;

    const streakCount = user?.streak_count || 0;
    const currentDay = Math.min((user?.daily_available ? streakCount + 1 : streakCount) || 1, 7);

    const guessConfig = systemConfig?.guessReward || { required: 5, reward: 10 };
    const dailyGuesses = user?.daily_correct_guesses || 0;
    const guessGoal = guessConfig.required;
    const guessCompleted = dailyGuesses >= guessGoal;
    const guessClaimed = user?.guess_reward_claimed_today;

    const handleInvite = () => {
        if (!hasProfileSetup) return;
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
        if (socket && isCompleted && !hasClaimed && hasProfileSetup) {
            socket.emit('claim_reward', { type: 'invite_reward' });
        }
    };

    const triggerAd = (adNum, prefix) => {
        if (!hasProfileSetup) return;
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
        let disabled = !hasProfileSetup;
        
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
        <div className="container mt-4 pb-5 position-relative">
            {!hasProfileSetup && <ProfileLockedOverlay />}
            
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
                    
                    <button className={`btn w-100 rounded-pill fw-bold ${user?.daily_available && hasProfileSetup ? 'btn-success shadow-sm' : 'btn-light text-muted border'}`} disabled={!user?.daily_available || !hasProfileSetup} onClick={() => { if(hasProfileSetup) socket.emit('claim_reward', {type: 'daily'})}}>
                        {user?.daily_available ? `Claim Day ${currentDay} Reward` : 'Come back tomorrow'}
                    </button>
                </div>
            </div>

            {/* Daily Guesser */}
            <div className="card bg-white rounded-4 border shadow-sm mb-3">
                <div className="card-body p-3">
                    <div className="d-flex align-items-center gap-3 mb-3">
                        <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '45px', height: '45px', background: 'linear-gradient(135deg, #3b82f6 0%, #0ea5e9 100%)'}}>
                            <i className="fas fa-lightbulb fs-5"></i>
                        </div>
                        <div>
                            <h6 className="fw-bold mb-1">Daily Guesser</h6>
                            <p className="text-muted small mb-0">Correctly guess {guessGoal} words today for {guessConfig.reward} Credits!</p>
                        </div>
                    </div>
                    <div className="mb-3">
                        <div className="d-flex justify-content-between small fw-bold mb-1">
                            <span className="text-secondary">Progress</span>
                            <span className={guessCompleted ? 'text-success' : 'text-primary'}>{dailyGuesses} / {guessGoal}</span>
                        </div>
                        <div className="progress rounded-pill bg-light border shadow-sm" style={{height: '8px'}}>
                            <div className={`progress-bar rounded-pill ${guessCompleted ? 'bg-success' : 'bg-primary'}`} style={{width: `${Math.min((dailyGuesses / guessGoal) * 100, 100)}%`}}></div>
                        </div>
                    </div>
                    <div className="d-flex gap-2">
                        <button className={`btn w-100 rounded-pill fw-bold shadow-sm py-2 btn-sm ${guessCompleted && !guessClaimed && hasProfileSetup ? 'btn-success' : 'btn-light text-muted border'}`} disabled={!guessCompleted || guessClaimed || !hasProfileSetup} onClick={() => { if(guessCompleted && !guessClaimed && hasProfileSetup) socket.emit('claim_reward', {type: 'daily_guess'}) }}>
                            {guessClaimed ? 'Claimed' : `Claim ${guessConfig.reward} Credits`}
                        </button>
                    </div>
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
                        <button className="btn btn-primary flex-grow-1 rounded-pill fw-bold shadow-sm py-2 btn-sm" disabled={!hasProfileSetup} onClick={handleInvite}>
                            <i className="fas fa-paper-plane me-1"></i> Share Link
                        </button>
                        <button className={`btn flex-grow-1 rounded-pill fw-bold shadow-sm py-2 btn-sm ${isCompleted && !hasClaimed && hasProfileSetup ? 'btn-success' : 'btn-light text-muted border'}`} disabled={!isCompleted || hasClaimed || !hasProfileSetup} onClick={handleClaim}>
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

window.TasksView = TasksView;