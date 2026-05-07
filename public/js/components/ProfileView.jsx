const { useState, useEffect } = React;

const ProfileView = ({ user, socket, setModal, systemConfig, setMainPageTab }) => {
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

    const styleClass = window.getStyleClass(user?.equipped_style, systemConfig);

    return (
        <div className="container mt-4 pb-5">
            <div className="text-center mb-4 d-flex flex-column align-items-center">
                {window.profilePic ? (
                    <img src={window.profilePic} className="rounded-circle shadow-lg mb-3 border" width="120" height="120" style={{objectFit: 'cover', borderColor: 'var(--primary)'}} alt="Profile" />
                ) : (
                    <i className="fas fa-user-circle text-secondary mb-3 shadow-sm rounded-circle bg-white" style={{fontSize: '120px', color: 'var(--primary)'}}></i>
                )}
                
                <div className="d-flex flex-column align-items-center justify-content-center">
                    <h3 className={`fw-bold mb-1 ${styleClass || 'text-dark'}`} data-name={user?.name || window.toHex(user?.tg_id)}>{user?.name || window.toHex(user?.tg_id)}</h3>
                    {window.username !== 'unset' && <p className="text-muted small">@{window.username}</p>}
                </div>
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

            <div className="card bg-white rounded-4 border shadow-sm mb-4 cursor-pointer hover-up" onClick={() => setMainPageTab('inventory')}>
                <div className="card-body p-3 d-flex align-items-center justify-content-between">
                    <div className="d-flex align-items-center gap-3">
                        <div className="text-white rounded-circle d-flex align-items-center justify-content-center shadow-sm flex-shrink-0" style={{width: '45px', height: '45px', background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'}}>
                            <i className="fas fa-box-open fs-5"></i>
                        </div>
                        <div>
                            <h6 className="fw-bold text-dark mb-0">My Inventory</h6>
                            <p className="text-muted small mb-0">View & equip purchased items</p>
                        </div>
                    </div>
                    <i className="fas fa-chevron-right text-muted"></i>
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

window.ProfileView = ProfileView;