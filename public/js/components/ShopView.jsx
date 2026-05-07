const { useState, useEffect } = React;
const ProfileLockedOverlay = window.ProfileLockedOverlay;

const ShopView = ({ user, socket, setModal, systemConfig }) => {
    const hasProfileSetup = !!user?.gender && !!user?.name;
    const gemPackages = systemConfig?.gemPackages || [];
    const starPackages = systemConfig?.starPackages || [];
    const nameStyles = systemConfig?.nameStyles || [];
    const ownedStyleIds = user?.owned_styles || [];

    return (
        <div className="container mt-4 pb-5 text-center position-relative">
            {!hasProfileSetup && <ProfileLockedOverlay />}
            
            {/* Inline styles for horizontal scrollable UI */}
            <style dangerouslySetInnerHTML={{__html: `
                .scrollable-row::-webkit-scrollbar { display: none; }
                .scrollable-row { -ms-overflow-style: none; scrollbar-width: none; scroll-snap-type: x mandatory; }
                .shop-pkg-card { min-width: 120px; transition: transform 0.2s; scroll-snap-align: center; }
                .shop-pkg-card:active { transform: scale(0.95); }
                .shop-pkg-card h4 { font-size: 1.25rem; }
                .shop-pkg-card small { font-size: 0.75rem; }
                .shop-pkg-card .btn { font-size: 0.75rem; white-space: nowrap; padding: 6px 0; }
                .shop-pkg-icon { width: 40px; height: 40px; font-size: 1.25rem; }
                .btn-vibrant-gradient { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; border: none; transition: all 0.3s ease; box-shadow: 0 4px 10px rgba(99, 102, 241, 0.3); }
                .btn-vibrant-gradient:hover { background: linear-gradient(135deg, #4f46e5 0%, #4338ca 100%); transform: translateY(-2px); box-shadow: 0 6px 15px rgba(99, 102, 241, 0.4); }
                .btn-success-gradient { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; transition: all 0.3s ease; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.3); }
                .btn-success-gradient:hover { background: linear-gradient(135deg, #059669 0%, #047857 100%); transform: translateY(-2px); box-shadow: 0 6px 15px rgba(16, 185, 129, 0.4); }
                .btn-disabled-style { background: #cbd5e1; color: #64748b; border: none; cursor: not-allowed; }
            `}} />

            <i className="fas fa-store text-primary mb-3" style={{fontSize: '4rem'}}></i>
            <h3 className="fw-bold mb-2">Item Shop</h3>
            <p className="text-muted">Get Gems, exchange for Credits, and buy custom Name Styles!</p>
            
            <div className="row g-3 mt-3 text-start">
                <div className="col-12">
                    <div className="card bg-white rounded-4 border shadow-sm p-3 p-md-4 h-100">
                        <h5 className="fw-bold mb-1"><i className="fas fa-paint-brush text-primary me-2"></i> Username Styles</h5>
                        <p className="small text-muted mb-3">Customize your display name to stand out in the chat and leaderboards!</p>
                        
                        <div className="d-flex flex-row gap-3 overflow-auto pb-3 scrollable-row w-100 px-1 pt-2">
                            {nameStyles.map(style => {
                                const isOwned = ownedStyleIds.includes(style.id);
                                return (
                                    <div key={style.id} className="shop-pkg-card card bg-light rounded-4 shadow border-0 flex-shrink-0" style={{ width: '240px' }}>
                                        <div className="card-body p-3 d-flex flex-column h-100">
                                            <div className="text-center p-3 mb-3 bg-white rounded border overflow-hidden d-flex align-items-center justify-content-center shadow-sm" style={{minHeight: '90px'}}>
                                                <span className={style.class_name} data-name={user?.name || (user?.tg_id ? window.toHex(user.tg_id) : "DoodleDash")}>{user?.name || (user?.tg_id ? window.toHex(user.tg_id) : "DoodleDash")}</span>
                                            </div>
                                            <div className="d-flex justify-content-between align-items-center mb-3 px-1">
                                                <h6 className="fw-bold text-dark m-0">Style</h6>
                                                {style.is_premium ? <span className="badge bg-warning text-dark shadow-sm"><i className="fas fa-star me-1"></i>Premium</span> : <span className="badge bg-secondary shadow-sm">Standard</span>}
                                            </div>
                                            
                                            <div className="mt-auto d-flex flex-column gap-2">
                                                {isOwned ? (
                                                    <button className="btn btn-secondary rounded-pill w-100 fw-bold" disabled>
                                                        <i className="fas fa-check me-1"></i> Owned
                                                    </button>
                                                ) : (
                                                    <>
                                                        {style.is_premium ? (
                                                            <button className="btn btn-info text-white rounded-pill w-100 fw-bold shadow-sm hover-up" disabled={!hasProfileSetup} onClick={(e) => { e.stopPropagation(); if(hasProfileSetup) socket.emit('buy_style', { style_id: style.id, currency: 'gems' }); }}>
                                                                <i className="fas fa-gem me-1"></i> {style.gem_price} Gems
                                                            </button>
                                                        ) : (
                                                            <button className="btn btn-warning text-dark rounded-pill w-100 fw-bold shadow-sm hover-up" disabled={!hasProfileSetup} onClick={(e) => { e.stopPropagation(); if(hasProfileSetup) socket.emit('buy_style', { style_id: style.id, currency: 'credits' }); }}>
                                                                <i className="fas fa-coins me-1"></i> {style.credit_price} Credits
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                            {nameStyles.length === 0 && <span className="text-muted small w-100 text-center py-4">No styles available right now.</span>}
                        </div>
                    </div>
                </div>
                
                <div className="col-12">
                    <div className="card bg-white rounded-4 border shadow-sm p-3 p-md-4 h-100">
                        <h5 className="fw-bold mb-1"><i className="fas fa-gem text-info me-2"></i> Buy Gems</h5>
                        <p className="small text-muted mb-3">Purchase Gems securely using Telegram Stars.</p>
                        
                        <div className="d-flex flex-row gap-3 overflow-auto pb-3 scrollable-row w-100 px-1 pt-2">
                            {starPackages.map(pkg => (
                                <div key={pkg.id} className={`shop-pkg-card card bg-light rounded-4 shadow border-0 text-center flex-shrink-0 ${hasProfileSetup ? 'cursor-pointer' : ''}`} onClick={() => { if(hasProfileSetup) setModal({ type: 'item_description', itemType: 'gems', pkg }) }} style={{ width: '130px' }}>
                                    <div className="card-body p-2 d-flex flex-column align-items-center justify-content-center h-100">
                                        <div className="bg-info bg-opacity-10 rounded-circle d-flex align-items-center justify-content-center mb-2 shop-pkg-icon">
                                            <i className="fas fa-gem text-info"></i>
                                        </div>
                                        <h4 className="fw-bold mb-0 text-dark">{pkg.gems}</h4>
                                        <small className="text-muted mb-2 fw-bold">Gems</small>
                                        <button className="btn btn-vibrant-gradient rounded-pill w-100 fw-bold mt-auto d-flex justify-content-center align-items-center gap-1" disabled={!hasProfileSetup} onClick={(e) => { e.stopPropagation(); if(hasProfileSetup) setModal({ type: 'confirm_buy_gems', pkg }); }}>
                                            <i className="fas fa-star" style={{color: '#fef08a'}}></i> {pkg.stars} Stars
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {starPackages.length === 0 && <span className="text-muted small w-100 text-center py-4">No gem packages configured.</span>}
                        </div>
                    </div>
                </div>
                
                <div className="col-12">
                    <div className="card bg-white rounded-4 border shadow-sm p-3 p-md-4 h-100 mt-2">
                        <h5 className="fw-bold mb-1"><i className="fas fa-exchange-alt text-warning me-2"></i> Exchange Gems</h5>
                        <p className="small text-muted mb-3">Convert your Gems into Credits instantly!</p>
                        
                        <div className="d-flex flex-row gap-3 overflow-auto pb-3 scrollable-row w-100 px-1 pt-2">
                            {gemPackages.map(pkg => {
                                const canAfford = user?.gems >= pkg.gems;
                                return (
                                    <div key={pkg.id} className={`shop-pkg-card card rounded-4 shadow border-0 text-center flex-shrink-0 ${canAfford && hasProfileSetup ? 'bg-light cursor-pointer' : 'bg-light opacity-50'}`} onClick={() => { if(hasProfileSetup) setModal({ type: 'item_description', itemType: 'credits', pkg, canAfford }) }} style={{ width: '130px' }}>
                                        <div className="card-body p-2 d-flex flex-column align-items-center justify-content-center h-100">
                                            <div className="bg-warning bg-opacity-10 rounded-circle d-flex align-items-center justify-content-center mb-2 shop-pkg-icon">
                                                <i className="fas fa-coins text-warning"></i>
                                            </div>
                                            <h4 className="fw-bold mb-0 text-dark">{pkg.credits}</h4>
                                            <small className="text-muted mb-2 fw-bold">Credits</small>
                                            <button className={`btn rounded-pill w-100 fw-bold mt-auto d-flex justify-content-center align-items-center gap-1 ${canAfford && hasProfileSetup ? 'btn-success-gradient' : 'btn-disabled-style opacity-50'}`} disabled={!canAfford || !hasProfileSetup} onClick={(e) => { e.stopPropagation(); if(canAfford && hasProfileSetup) setModal({ type: 'confirm_exchange_gems', pkg }); }}>
                                                <i className="fas fa-gem" style={{color: canAfford ? '#cffafe' : '#94a3b8'}}></i> {pkg.gems} Gems
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                            {gemPackages.length === 0 && <span className="text-muted small w-100 text-center py-4">No exchange packages available.</span>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

window.ShopView = ShopView;