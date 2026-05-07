const { useState, useEffect, useRef, useCallback } = React;

const LeaderboardView = () => {
    const [leaderboard, setLeaderboard] = useState([]);
    const [loading, setLoading] = useState(true);
    const [period, setPeriod] = useState('allTime');

    useEffect(() => {
        fetchLeaderboard();
    }, [period]);

    const fetchLeaderboard = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/leaderboard?period=${period}`);
            if (res.ok) {
                const data = await res.json();
                setLeaderboard(data.leaderboard || []);
            }
        } catch (err) {
            console.error("Failed to fetch leaderboard", err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="h-full flex flex-col bg-gray-800 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-gray-700 bg-gray-800 flex justify-between items-center">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                    <i className="fas fa-trophy text-yellow-400"></i>Leaderboard
                </h2>
                <div className="flex bg-gray-900 rounded-lg p-1 shadow-inner border border-gray-700">
                    <button 
                        onClick={() => setPeriod('weekly')}
                        className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${period === 'weekly' ? 'bg-indigo-600 text-white shadow' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    >
                        Weekly
                    </button>
                    <button 
                        onClick={() => setPeriod('allTime')}
                        className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${period === 'allTime' ? 'bg-indigo-600 text-white shadow' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                    >
                        All Time
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                {loading ? (
                    <div className="flex justify-center items-center h-full">
                        <i className="fas fa-circle-notch fa-spin text-4xl text-indigo-500"></i>
                    </div>
                ) : leaderboard.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <i className="fas fa-medal text-5xl mb-4 opacity-50"></i>
                        <p className="text-lg font-medium">No ranking data available yet.</p>
                        <p className="text-sm mt-2">Play games to climb the ranks!</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {leaderboard.map((player, index) => (
                            <div key={player.id || index} className={`flex items-center p-4 rounded-xl border shadow-sm transition-transform hover:-translate-y-1 ${
                                index === 0 ? 'bg-yellow-900/30 border-yellow-600/50' : 
                                index === 1 ? 'bg-gray-300/10 border-gray-400/50' : 
                                index === 2 ? 'bg-yellow-700/20 border-yellow-800/50' : 
                                'bg-gray-700 border-gray-600 hover:border-gray-500'
                            }`}>
                                <div className="w-10 text-center font-bold text-xl mr-2">
                                    {index === 0 ? <i className="fas fa-crown text-yellow-400 drop-shadow"></i> : 
                                     index === 1 ? <i className="fas fa-medal text-gray-300 drop-shadow"></i> : 
                                     index === 2 ? <i className="fas fa-medal text-yellow-600 drop-shadow"></i> : 
                                     <span className="text-gray-400">#{index + 1}</span>}
                                </div>
                                <img 
                                    src={player.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${player.username}`} 
                                    alt={player.username} 
                                    className={`w-12 h-12 rounded-full mr-4 bg-gray-800 object-cover border-2 ${
                                        index === 0 ? 'border-yellow-400' : index === 1 ? 'border-gray-300' : index === 2 ? 'border-yellow-600' : 'border-transparent'
                                    }`} 
                                />
                                <div className="flex-1">
                                    <div className="font-bold text-white text-lg">{player.username}</div>
                                    <div className="text-xs text-indigo-300 font-semibold uppercase tracking-wide">
                                        Level {Math.floor(Math.sqrt((player.xp || 0) / 100)) + 1}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="font-bold text-white text-lg bg-gray-900 px-3 py-1 rounded-lg border border-gray-700">
                                        {player.score || player.xp || 0} <span className="text-xs text-gray-400 font-normal">pts</span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

window.LeaderboardView = LeaderboardView;