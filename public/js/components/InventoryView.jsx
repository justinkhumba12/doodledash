const { useState, useEffect, useRef, useCallback } = React;

const InventoryView = ({ userState, shopItems, onEquipItem, isGuest, onLoginClick }) => {
    const [activeCategory, setActiveCategory] = useState('avatars');
    
    if (isGuest) {
        return (
            <div className="h-full relative bg-gray-800 rounded-lg">
                <window.ProfileLockedOverlay onLoginClick={onLoginClick} />
            </div>
        );
    }

    const categories = [
        { id: 'avatars', name: 'Avatars', icon: 'fa-user-circle' },
        { id: 'banners', name: 'Banners', icon: 'fa-image' },
        { id: 'titles', name: 'Titles', icon: 'fa-tag' }
    ];

    // Filter for only owned items
    const ownedItemIds = userState?.inventory || [];
    const inventoryItems = (shopItems || []).filter(item => 
        ownedItemIds.includes(item.id) && item.type === activeCategory
    );

    const isItemEquipped = (itemId) => {
        if (!userState?.equipped) return false;
        return Object.values(userState.equipped).includes(itemId);
    };

    return (
        <div className="h-full flex flex-col bg-gray-800 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-gray-700 bg-gray-800 flex justify-between items-center">
                <h2 className="text-xl font-bold text-white"><i className="fas fa-box-open mr-2 text-indigo-400"></i>Inventory</h2>
                <div className="text-sm text-gray-400 font-medium">Items Owned: {ownedItemIds.length}</div>
            </div>
            
            <div className="flex bg-gray-900 p-2 gap-2 overflow-x-auto hide-scrollbar">
                {categories.map(cat => (
                    <button
                        key={cat.id}
                        onClick={() => setActiveCategory(cat.id)}
                        className={`flex items-center px-4 py-2 rounded-md font-semibold transition-colors whitespace-nowrap ${
                            activeCategory === cat.id ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                        }`}
                    >
                        <i className={`fas ${cat.icon} mr-2`}></i>{cat.name}
                    </button>
                ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                {inventoryItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <i className="fas fa-ghost text-5xl mb-4 opacity-50"></i>
                        <p className="text-lg font-medium">You don't own any {activeCategory} yet.</p>
                        <p className="text-sm mt-2 text-gray-500">Visit the Shop to buy some!</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                        {inventoryItems.map(item => {
                            const equipped = isItemEquipped(item.id);

                            return (
                                <div key={item.id} className={`bg-gray-700 rounded-lg overflow-hidden flex flex-col shadow-lg border transition-all hover:scale-105 ${equipped ? 'border-green-500 shadow-green-900/20' : 'border-gray-600'}`}>
                                    <div className="h-24 bg-gray-900 flex items-center justify-center p-2 relative">
                                        {item.type === 'avatars' && <img src={item.url} alt={item.name} className="w-16 h-16 rounded-full object-cover" />}
                                        {item.type === 'banners' && <div className="w-full h-full bg-cover bg-center rounded" style={{ backgroundImage: `url(${item.url})` }}></div>}
                                        {item.type === 'titles' && <div className="font-bold text-lg text-center" style={{ color: item.color || '#fff' }}>{item.name}</div>}
                                        {equipped && <span className="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full font-bold shadow-md"><i className="fas fa-check mr-1"></i>Equipped</span>}
                                    </div>
                                    <div className="p-3 flex-1 flex flex-col justify-between">
                                        <div className="mb-3 text-center">
                                            <h3 className="text-white font-bold text-sm truncate">{item.name}</h3>
                                            <p className={`text-[10px] font-bold uppercase tracking-wider ${item.rarity === 'legendary' ? 'text-yellow-400' : item.rarity === 'epic' ? 'text-purple-400' : item.rarity === 'rare' ? 'text-blue-400' : 'text-gray-400'}`}>
                                                {item.rarity || 'common'}
                                            </p>
                                        </div>
                                        <button 
                                            onClick={() => !equipped && onEquipItem(item.id)}
                                            disabled={equipped}
                                            className={`w-full py-2 rounded text-sm font-bold transition-all ${equipped ? 'bg-green-600 text-white opacity-80 cursor-default' : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md'}`}
                                        >
                                            {equipped ? 'Equipped' : 'Equip Item'}
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

window.InventoryView = InventoryView;