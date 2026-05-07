const { useState, useEffect, useRef, useCallback } = React;

const ProfileLockedOverlay = ({ onLoginClick }) => {
    return (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-900/80 backdrop-blur-sm rounded-lg p-6 text-center">
            <div className="bg-gray-800 p-6 rounded-xl shadow-2xl max-w-md w-full border border-gray-700">
                <div className="mb-4">
                    <i className="fas fa-lock text-5xl text-yellow-500 mb-4 drop-shadow-lg"></i>
                </div>
                <h2 className="text-2xl font-bold text-white mb-2 font-display tracking-wide">Account Required</h2>
                <p className="text-gray-300 mb-6 font-medium">
                    Log in or create an account to unlock this feature and track your progress!
                </p>
                <button
                    onClick={onLoginClick}
                    className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold py-3 px-6 rounded-lg transition-all duration-200 transform hover:scale-105 shadow-lg flex items-center justify-center gap-2"
                >
                    <i className="fas fa-sign-in-alt"></i>
                    <span>Log In / Sign Up</span>
                </button>
            </div>
        </div>
    );
};

// Expose to window so other components can use it
window.ProfileLockedOverlay = ProfileLockedOverlay;