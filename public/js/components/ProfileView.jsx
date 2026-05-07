const { useState, useEffect, useRef, useCallback } = React;

const ProfileView = ({ userState, isGuest, onLoginClick }) => {
    if (isGuest) {
        return (
            <div className="h-full relative bg-gray-800 rounded-lg">
                <window.ProfileLockedOverlay onLoginClick={onLoginClick} />
            </div>
        );
    }

    if (!userState) return <div className="p-4 text-white flex justify-center items-center h-full"><i className="fas fa-spinner fa-spin text-2xl"></i></div>;

    const xp = userState.xp || 0;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    const currentLevelXp = Math.pow(level - 1, 2) * 100;
    const nextLevelXp = Math.pow(level, 2) * 100;
    const progress = ((xp - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100;

    return (
        <div className="h-full flex flex-col bg-gray-800 rounded-lg p-6 overflow-y-auto custom-scrollbar">
            <div className="flex items-center gap-6 mb-8 bg-gray-900 p-6 rounded-xl border border-gray-700 shadow-lg relative overflow-hidden">
                <div className="relative z-10">
                    <img 
                        src={userState.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${userState.username}`} 
                        alt="Profile" 
                        className="w-24 h-24 rounded-full border-4 border-indigo-500 object-cover bg-gray-800 shadow-lg"
                    />
                    <div className="absolute -bottom-2 -right-2 bg-indigo-600 text-white text-xs font-bold px-2 py-1 rounded-full border-2 border-gray-900">
                        Lvl {level}
                    </div>
                </div>
                <div className="flex-1 z-10">
                    <h2 className="text-3xl font-bold text-white mb-1">{userState.username}</h2>
                    <div className="text-indigo-400 font-semibold mb-4">{userState.title || 'Beginner Artist'}</div>
                    
                    <div className="w-full bg-gray-700 rounded-full h-3 mb-1 overflow-hidden shadow-inner">
                        <div className="bg-gradient-to-r from-indigo-500 to-purple-500 h-3 rounded-full transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}></div>
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 font-medium">
                        <span>{xp} XP</span>
                        <span>{nextLevelXp} XP to next</span>
                    </div>
                </div>
            </div>

            <h3 className="text-xl font-bold text-white mb-4 border-b border-gray-700 pb-2 flex items-center gap-2">
                <i className="fas fa-chart-bar text-indigo-400"></i> Statistics
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-gray-900 p-4 rounded-xl border border-gray-700 text-center shadow-md hover:border-blue-500 transition-colors">
                    <i className="fas fa-gamepad text-2xl text-blue-400 mb-2"></i>
                    <div className="text-gray-400 text-sm font-semibold">Games Played</div>
                    <div className="text-2xl font-bold text-white">{userState.stats?.gamesPlayed || 0}</div>
                </div>
                <div className="bg-gray-900 p-4 rounded-xl border border-gray-700 text-center shadow-md hover:border-yellow-500 transition-colors">
                    <i className="fas fa-trophy text-2xl text-yellow-400 mb-2"></i>
                    <div className="text-gray-400 text-sm font-semibold">Games Won</div>
                    <div className="text-2xl font-bold text-white">{userState.stats?.gamesWon || 0}</div>
                </div>
                <div className="bg-gray-900 p-4 rounded-xl border border-gray-700 text-center shadow-md hover:border-green-500 transition-colors">
                    <i className="fas fa-paint-brush text-2xl text-green-400 mb-2"></i>
                    <div className="text-gray-400 text-sm font-semibold">Drawings</div>
                    <div className="text-2xl font-bold text-white">{userState.stats?.drawingsCompleted || 0}</div>
                </div>
                <div className="bg-gray-900 p-4 rounded-xl border border-gray-700 text-center shadow-md hover:border-purple-500 transition-colors">
                    <i className="fas fa-star text-2xl text-purple-400 mb-2"></i>
                    <div className="text-gray-400 text-sm font-semibold">Total Score</div>
                    <div className="text-2xl font-bold text-white">{userState.stats?.totalScore || 0}</div>
                </div>
            </div>
        </div>
    );
};

window.ProfileView = ProfileView;