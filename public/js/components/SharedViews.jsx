const { useState, useEffect } = React;

const ProfileLockedOverlay = ({ text = "Please set your Name and Gender in your Profile tab to unlock features." }) => (
    <div className="position-absolute top-0 start-0 w-100 h-100 d-flex flex-column align-items-center pt-5 mt-2" style={{zIndex: 50, background: 'rgba(248, 250, 252, 0.9)', backdropFilter: 'blur(4px)', borderRadius: '16px', border: '1px solid #e2e8f0'}}>
        <i className="fas fa-lock text-danger mb-3" style={{fontSize: '3rem'}}></i>
        <h5 className="fw-bold text-dark">Profile Locked</h5>
        <p className="text-muted small text-center px-4">{text}</p>
    </div>
);

// Attach to window so other separated components can access it
window.ProfileLockedOverlay = ProfileLockedOverlay;