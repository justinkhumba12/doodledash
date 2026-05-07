const { useState, useEffect, useRef, useCallback } = React;

const ShopView = ({ userState, onBuyItem, onEquipItem, shopItems, isGuest, onLoginClick }) => {
    const [activeCategory, setActiveCategory] = useState('avatars');
    
    const categories = [
        { id: 'avatars', name: 'Avatars', icon: 'fa-user-circle' },
        { id: 'banners', name: 'Banners', icon: 'fa-image' },
        { id: 'titles', name: 'Titles', icon: 'fa-tag' }
    ];

    const filteredItems = shopItems ? shopItems.filter(item => item.type === activeCategory) : [];

    const isItemOwned = (itemId) => {
        return userState?.inventory?.includes(itemId);
    };

    const isItemEquipped = (itemId) => {
        if (!userState?.equipped) return false;
        return Object.values(userState.equipped).includes(itemId);
    };

    return (
        <div className="h-full flex flex-col bg-gray-800 rounded-lg overflow-hidden relative">
            {isGuest && <window.ProfileLockedOverlay onLoginClick={onLoginClick} />}
            
            <div className="p-4 border-b border-gray-700 bg-gray-800 flex justify-between items-center">
                <h2 className="text-xl font-bold text-white"><i className="fas fa-store mr-2 text-indigo-400"></i>Item Shop</h2>
                <div className="flex items-center bg-gray-900 rounded-full px-4 py-1">
                    <i className="fas fa-coins text-yellow-400 mr-2"></i>
                    <span className="font-bold">{userState?.coins || 0}</span>
                </div>
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
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {filteredItems.map(item => {
                        const owned = isItemOwned(item.id);
                        const equipped = isItemEquipped(item.id);
                        const canAfford = (userState?.coins || 0) >= item.price;

                        return (
                            <div key={item.id} className="bg-gray-700 rounded-lg overflow-hidden flex flex-col shadow-lg border border-gray-600 transition-transform hover:scale-105">
                                <div className="h-24 bg-gray-900 flex items-center justify-center p-2 relative group">
                                    {item.type === 'avatars' && <img src={item.url} alt={item.name} className="w-16 h-16 rounded-full object-cover border-2 border-transparent group-hover:border-indigo-400 transition-colors" />}
                                    {item.type === 'banners' && <div className="w-full h-full bg-cover bg-center rounded" style={{ backgroundImage: `url(${item.url})` }}></div>}
                                    {item.type === 'titles' && <div className="font-bold text-lg text-center" style={{ color: item.color || '#fff' }}>{item.name}</div>}
                                    {owned && <span className="absolute top-1 right-1 bg-green-500 text-xs px-2 py-0.5 rounded-full font-bold shadow">Owned</span>}
                                </div>
                                <div className="p-3 flex-1 flex flex-col justify-between">
                                    <div className="mb-2">
                                        <h3 className="text-white font-bold text-sm truncate">{item.name}</h3>
                                        <p className={`text-xs capitalize font-semibold ${item.rarity === 'legendary' ? 'text-yellow-400' : item.rarity === 'epic' ? 'text-purple-400' : item.rarity === 'rare' ? 'text-blue-400' : 'text-gray-400'}`}>
                                            {item.rarity || 'common'}
                                        </p>
                                    </div>
                                    {owned ? (
                                        <button 
                                            onClick={() => onEquipItem(item.id)}
                                            className={`w-full py-1.5 rounded text-sm font-bold transition-colors ${equipped ? 'bg-green-600 text-white cursor-default' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
                                        >
                                            {equipped ? 'Equipped' : 'Equip'}
                                        </button>
                                    ) : (
                                        <button 
                                            onClick={() => canAfford && onBuyItem(item.id, item.price)}
                                            disabled={!canAfford}
                                            className={`w-full py-1.5 rounded flex items-center justify-center gap-1 text-sm font-bold transition-colors ${canAfford ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'bg-gray-600 text-gray-400 cursor-not-allowed'}`}
                                        >
                                            <i className="fas fa-coins text-xs"></i> {item.price}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
                {filteredItems.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <i className="fas fa-box-open text-4xl mb-3"></i>
                        <p>No items found in this category.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

window.ShopView = ShopView;