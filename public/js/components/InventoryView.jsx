const { useState, useEffect } = React;
const ProfileLockedOverlay = window.ProfileLockedOverlay;

const InventoryView = ({ user, socket, setModal, systemConfig, setMainPageTab }) => {
    const hasProfileSetup = !!user?.gender && !!user?.name;
    const ownedStyleIds = user?.owned_styles || [];
    const nameStyles = systemConfig?.nameStyles || [];
    const ownedStyles = nameStyles.filter(s => ownedStyleIds.includes(s.id));
    const equippedStyle = user?.equipped_style;

    return (
        <div className="container mt-4 pb-5 position-relative">
            {!hasProfileSetup && <ProfileLockedOverlay />}
            
            <div className="d-flex align-items-center mb-4">
                <button className="btn btn-light rounded-circle shadow-sm me-3 border" onClick={() => setMainPageTab('profile')}><i className="fas fa-arrow-left"></i></button>
                <h3 className="fw-bold mb-0">Inventory</h3>
            </div>

            <div className="row g-3">
                <div className="col-12">
                    <div className="d-flex align-items-center gap-2 mb-3">
                        <i className="fas fa-paint-brush fs-4 text-primary"></i>
                        <h5 className="fw-bold text-secondary mb-0">Username Styles ({ownedStyles.length})</h5>
                    </div>
                    
                    {ownedStyles.length === 0 ? (
                        <div className="text-center p-5 bg-white rounded-4 border shadow-sm">
                            <i className="fas fa-box-open text-muted opacity-50 mb-3" style={{fontSize: '3rem'}}></i>
                            <p className="text-muted fw-bold">Your inventory is empty.</p>
                            <button className="btn btn-primary rounded-pill fw-bold shadow-sm mt-2" onClick={() => setMainPageTab('shop')}>Visit Shop</button>
                        </div>
                    ) : (
                        <div className="row g-3">
                            {ownedStyles.map(s => {
                                const isEquipped = equippedStyle === s.id;
                                return (
                                    <div key={s.id} className="col-12 col-md-6">
                                        <div className={`card rounded-4 border shadow-sm p-3 h-100 ${isEquipped ? 'border-primary bg-primary bg-opacity-10' : 'bg-white'}`}>
                                            <div className="d-flex flex-column h-100">
                                                <div className="text-center p-3 mb-3 rounded border flex-grow-1 d-flex align-items-center justify-content-center overflow-hidden" style={{minHeight: '80px', backgroundColor: '#f3f4f8'}}>
                                                    <span className={s.class_name} data-name={user?.name || 'Preview'}>{user?.name || 'Preview'}</span>
                                                </div>
                                                <div className="d-flex justify-content-between align-items-center mt-auto">
                                                    <span className="small fw-bold text-muted">{s.is_premium ? 'Premium' : 'Standard'} Style</span>
                                                    <button 
                                                        className={`btn rounded-pill fw-bold px-4 btn-sm shadow-sm ${isEquipped ? 'btn-danger' : 'btn-success'}`}
                                                        disabled={!hasProfileSetup}
                                                        onClick={() => { if(hasProfileSetup) socket.emit('equip_style', { style_id: isEquipped ? null : s.id }) }}
                                                    >
                                                        {isEquipped ? <><i className="fas fa-times me-1"></i> Unequip</> : <><i className="fas fa-check me-1"></i> Equip</>}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

window.InventoryView = InventoryView;