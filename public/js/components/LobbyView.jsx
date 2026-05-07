const { useState, useEffect, useRef, useCallback } = React;

const LobbyView = ({ rooms, onJoinRoom, onCreateRoom, isGuest }) => {
    const [searchTerm, setSearchTerm] = useState('');

    const filteredRooms = rooms.filter(room => 
        room.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
        (room.settings?.customWords?.length > 0 ? 'custom' : 'standard').includes(searchTerm.toLowerCase())
    );

    return (
        <div className="h-full flex flex-col">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-6 gap-4">
                <h2 className="text-3xl font-bold text-white font-display">Active Rooms</h2>
                <button 
                    onClick={onCreateRoom}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-bold shadow-lg transition-transform hover:scale-105 flex items-center justify-center gap-2"
                >
                    <i className="fas fa-plus"></i> Create Room
                </button>
            </div>

            <div className="mb-6 relative">
                <i className="fas fa-search absolute left-4 top-3.5 text-gray-400"></i>
                <input 
                    type="text" 
                    placeholder="Search rooms by ID or keywords..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full bg-gray-800 border-2 border-gray-700 text-white rounded-xl pl-12 pr-4 py-3 focus:outline-none focus:border-indigo-500 transition-colors shadow-inner"
                />
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {filteredRooms.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400 bg-gray-800/50 rounded-xl border-2 border-dashed border-gray-700 p-8">
                        <i className="fas fa-door-open text-6xl mb-4 opacity-50"></i>
                        <h3 className="text-xl font-bold mb-2 text-white">No rooms found</h3>
                        <p className="text-center font-medium">Create a new room to start playing with friends!</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
                        {filteredRooms.map(room => {
                            const isFull = room.players?.length >= (room.settings?.maxPlayers || 8);
                            const isPlaying = room.status === 'playing';

                            return (
                                <div key={room.id} className="bg-gray-800 border-2 border-gray-700 rounded-xl p-5 flex flex-col shadow-lg hover:border-indigo-500 transition-all hover:-translate-y-1 group">
                                    <div className="flex justify-between items-start mb-4">
                                        <div>
                                            <h3 className="text-xl font-bold text-white group-hover:text-indigo-400 transition-colors flex items-center gap-2">
                                                <i className="fas fa-hashtag text-gray-500 text-sm"></i>
                                                {room.id.substring(0, 6)}
                                            </h3>
                                            <div className="text-xs text-gray-400 mt-2 flex flex-wrap gap-2">
                                                <span className="bg-gray-700 px-2 py-1 rounded-md text-gray-300 font-semibold flex items-center gap-1">
                                                    <i className="fas fa-globe"></i> Public
                                                </span>
                                                {room.settings?.customWords?.length > 0 && (
                                                    <span className="bg-indigo-900/60 text-indigo-300 px-2 py-1 rounded-md font-semibold flex items-center gap-1">
                                                        <i className="fas fa-pen-nib"></i> Custom
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className={`px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider ${isPlaying ? 'bg-yellow-900/60 text-yellow-400 border border-yellow-700/50' : 'bg-green-900/60 text-green-400 border border-green-700/50'}`}>
                                            {isPlaying ? 'In Game' : 'Waiting'}
                                        </div>
                                    </div>
                                    
                                    <div className="flex justify-between items-center mt-auto pt-4 border-t border-gray-700">
                                        <div className="flex items-center text-gray-300 text-sm font-bold bg-gray-900 px-3 py-1.5 rounded-lg shadow-inner">
                                            <i className="fas fa-users mr-2 text-gray-500"></i>
                                            {room.players?.length || 0} / {room.settings?.maxPlayers || 8}
                                        </div>
                                        <button 
                                            onClick={() => onJoinRoom(room.id)}
                                            disabled={isFull}
                                            className={`px-5 py-2 rounded-lg font-bold transition-all shadow-md ${isFull ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white hover:shadow-lg hover:scale-105 transform'}`}
                                        >
                                            {isFull ? 'Full' : 'Join Room'}
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

window.LobbyView = LobbyView;