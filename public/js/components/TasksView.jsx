const { useState, useEffect, useRef, useCallback } = React;

const TasksView = ({ userState, tasks, onClaimTask, isGuest, onLoginClick }) => {
    if (isGuest) {
        return (
            <div className="h-full relative bg-gray-800 rounded-lg">
                <window.ProfileLockedOverlay onLoginClick={onLoginClick} />
            </div>
        );
    }

    const userTasks = userState?.tasks || {};

    return (
        <div className="h-full flex flex-col bg-gray-800 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-gray-700 bg-gray-800 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white"><i className="fas fa-clipboard-list mr-2 text-indigo-400"></i>Daily Tasks</h2>
                    <p className="text-sm text-gray-400 mt-1 font-medium">Complete tasks to earn coins and XP. Resets daily.</p>
                </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
                {(!tasks || tasks.length === 0) ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <i className="fas fa-clipboard-check text-5xl mb-4 opacity-50"></i>
                        <p className="text-lg font-medium">No tasks available right now.</p>
                        <p className="text-sm">Check back later for new challenges!</p>
                    </div>
                ) : (
                    tasks.map(task => {
                        const progress = userTasks[task.id]?.progress || 0;
                        const isCompleted = progress >= task.requirement;
                        const isClaimed = userTasks[task.id]?.claimed || false;
                        const percent = Math.min(100, (progress / task.requirement) * 100);

                        return (
                            <div key={task.id} className={`p-4 rounded-xl border flex flex-col sm:flex-row items-center gap-4 transition-all shadow-md ${isClaimed ? 'bg-gray-800/50 border-gray-700 opacity-75' : isCompleted ? 'bg-gray-700 border-green-500/50 shadow-green-900/10' : 'bg-gray-700 border-gray-600 hover:border-indigo-400'}`}>
                                <div className="flex-1 w-full">
                                    <div className="flex justify-between items-center mb-2">
                                        <h3 className="font-bold text-white text-lg">{task.description}</h3>
                                        <span className="text-sm font-bold text-gray-300 bg-gray-900 px-2 py-1 rounded">
                                            {progress} / {task.requirement}
                                        </span>
                                    </div>
                                    <div className="w-full bg-gray-900 rounded-full h-3 overflow-hidden shadow-inner mb-3">
                                        <div className={`h-3 rounded-full transition-all duration-500 ${isCompleted ? 'bg-green-500' : 'bg-gradient-to-r from-indigo-500 to-purple-500'}`} style={{ width: `${percent}%` }}></div>
                                    </div>
                                    <div className="flex gap-4 text-sm font-bold">
                                        <span className="flex items-center text-yellow-400 bg-yellow-900/20 px-2 py-1 rounded">
                                            <i className="fas fa-coins mr-1.5"></i>{task.rewardCoins}
                                        </span>
                                        <span className="flex items-center text-blue-400 bg-blue-900/20 px-2 py-1 rounded">
                                            <i className="fas fa-star mr-1.5"></i>{task.rewardXp} XP
                                        </span>
                                    </div>
                                </div>
                                <div className="w-full sm:w-auto flex justify-end">
                                    {isClaimed ? (
                                        <button disabled className="w-full sm:w-32 py-2.5 bg-gray-800 text-gray-500 font-bold rounded-lg border border-gray-700 cursor-not-allowed flex justify-center items-center gap-2">
                                            <i className="fas fa-check-circle"></i>Claimed
                                        </button>
                                    ) : isCompleted ? (
                                        <button 
                                            onClick={() => onClaimTask(task.id)}
                                            className="w-full sm:w-32 py-2.5 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow-lg transition-transform hover:scale-105 flex justify-center items-center gap-2 animate-pulse-slow"
                                        >
                                            <i className="fas fa-gift"></i>Claim
                                        </button>
                                    ) : (
                                        <button disabled className="w-full sm:w-32 py-2.5 bg-gray-600 text-gray-400 font-bold rounded-lg border border-gray-500 cursor-not-allowed">
                                            In Progress
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
};

window.TasksView = TasksView;