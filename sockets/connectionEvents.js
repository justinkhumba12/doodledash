const { db, redis } = require('../database');
const { validateInitData, getWeekKey } = require('../utils');
const { getRoom, saveRoom, syncRoom, broadcastRooms, checkRoomReset } = require('../roomManager');
const { getUserState } = require('../userManager');
const config = require('../config');

module.exports = (io, socket, shared) => {

    socket.on('auth', async ({ initData, photoUrl }) => {
        try {
            let currentUser;
            
            if (initData) {
                const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
                if (!isMock && config.BOT_TOKEN && !validateInitData(initData, config.BOT_TOKEN)) {
                    return socket.emit('auth_error', 'Invalid Telegram authentication payload.');
                }
                const urlParams = new URLSearchParams(initData);
                const userObjStr = urlParams.get('user');
                if (!userObjStr) return socket.emit('auth_error', 'Invalid user payload.');
                const userObj = JSON.parse(userObjStr);
                currentUser = userObj.id.toString(); 
                if (userObj.username) {
                    await redis.hset('user_usernames', currentUser, userObj.username);
                }
            } else {
                return socket.emit('auth_error', 'Access Denied: Please open via Telegram.');
            }
            
            socket.data.currentUser = currentUser;
            await redis.hdel('user_disconnects', currentUser);
            
            if (photoUrl) {
                await redis.hset('user_photos', currentUser, photoUrl);
            }

            socket.join(`user_${currentUser}`);

            const userState = await getUserState(currentUser);
            
            const activeRooms = await redis.smembers('active_rooms');
            let foundRoom = null;
            for (const id of activeRooms) {
                const room = await getRoom(id);
                if (room && room.members.some(m => String(m.user_id) === currentUser)) {
                    foundRoom = id;
                    socket.data.currentRoom = foundRoom;
                    socket.join(`room_${foundRoom}`);
                    await syncRoom(foundRoom, io);
                    break;
                }
            }

            if (!foundRoom) {
                socket.join('lobby');
            }

            const roomsList = [];
            for (const id of activeRooms) {
                const room = await getRoom(id);
                if(room) {
                    roomsList.push({
                        id: room.id, status: room.status, is_private: room.is_private, max_members: room.max_members,
                        creator_id: room.creator_id, member_count: room.members.length
                    });
                }
            }

            const maint = await redis.get('maintenance_mode');
            const maintEndTime = await redis.get('maintenance_end_time');
            const packagesRaw = await redis.get('config_gem_packages');
            const starPackagesRaw = await redis.get('config_star_packages');
            const inkConfigRaw = await redis.get('config_ink');
            const maxRoomsRaw = await redis.get('config_max_rooms');
            const roomLimitsRaw = await redis.get('config_room_limits');
            const guessRewardRaw = await redis.get('config_guess_reward');
            
            const defaultRoomLimits = { publicMax: 8, privateMax: 10, privateBaseCost: 0, timeOptions: [{ minutes: 30, cost: 1 }, { minutes: 60, cost: 2 }] };
            const roomLimits = roomLimitsRaw ? { ...defaultRoomLimits, ...JSON.parse(roomLimitsRaw) } : defaultRoomLimits;

            const [nameStyles] = await db.query('SELECT * FROM name_styles');

            const systemConfig = {
                maintenance: { active: maint === '1', end_time: maintEndTime },
                gemPackages: packagesRaw ? JSON.parse(packagesRaw) : [
                    { id: 1, gems: 1, credits: 5 }, { id: 2, gems: 3, credits: 15 },
                    { id: 3, gems: 5, credits: 25 }, { id: 4, gems: 10, credits: 50 }
                ],
                starPackages: starPackagesRaw ? JSON.parse(starPackagesRaw) : [
                    { id: 1, stars: 20, gems: 20 }, { id: 2, stars: 50, gems: 50 },
                    { id: 3, stars: 100, gems: 100 }, { id: 4, stars: 500, gems: 500 }
                ],
                inkConfig: inkConfigRaw ? JSON.parse(inkConfigRaw) : { free: 2500, extra: 2500, cost: 0.5, max_buys: 1 },
                maxRooms: maxRoomsRaw ? parseInt(maxRoomsRaw) : 1250,
                roomLimits,
                nameStyles,
                guessReward: guessRewardRaw ? JSON.parse(guessRewardRaw) : { required: 5, reward: 10 }
            };

            socket.emit('lobby_data', { user: userState, rooms: roomsList, currentRoom: socket.data.currentRoom, systemConfig });
        } catch (err) { 
            console.error('Auth Error', err); 
            socket.emit('auth_error', 'Authentication processing failed.');
        }
    });

    socket.on('buy_style', async ({ style_id, currency }) => {
        const currentUser = socket.data.currentUser;
        if (!currentUser || !style_id || !currency) return;

        const [styleRows] = await db.query('SELECT * FROM name_styles WHERE id = ?', [style_id]);
        if (styleRows.length === 0) return socket.emit('create_error', 'Style not found.');
        const style = styleRows[0];

        const [invCheck] = await db.query('SELECT * FROM user_styles_inventory WHERE tg_id = ? AND style_id = ?', [currentUser, style_id]);
        if (invCheck.length > 0) return socket.emit('create_error', 'You already own this style.');

        const [userRows] = await db.query('SELECT credits, gems FROM users WHERE tg_id = ?', [currentUser]);
        if (userRows.length === 0) return;
        const u = userRows[0];

        if (currency === 'credits') {
            if (style.is_premium) return socket.emit('create_error', 'This style can only be purchased with Gems.');
            if (u.credits < style.credit_price) return socket.emit('create_error', 'Not enough credits.');
            
            await db.query('UPDATE users SET credits = credits - ? WHERE tg_id = ?', [style.credit_price, currentUser]);
            await redis.hincrbyfloat('user_credits', currentUser, -style.credit_price);
        } else if (currency === 'gems') {
            if (u.gems < style.gem_price) return socket.emit('create_error', 'Not enough gems.');
            await db.query('UPDATE users SET gems = gems - ? WHERE tg_id = ?', [style.gem_price, currentUser]);
        } else {
            return;
        }

        await db.query('INSERT INTO user_styles_inventory (tg_id, style_id) VALUES (?, ?)', [currentUser, style_id]);
        
        socket.emit('reward_success', 'Style purchased and added to your inventory!');
        const userState = await getUserState(currentUser);
        if (userState) socket.emit('user_update', userState);
    });

    socket.on('equip_style', async ({ style_id }) => {
        const currentUser = socket.data.currentUser;
        if (!currentUser) return;

        if (!style_id) {
            await db.query('UPDATE users SET equipped_style = NULL WHERE tg_id = ?', [currentUser]);
        } else {
            const [inv] = await db.query('SELECT * FROM user_styles_inventory WHERE tg_id = ? AND style_id = ?', [currentUser, style_id]);
            if (inv.length === 0) return socket.emit('create_error', 'You do not own this style.');
            await db.query('UPDATE users SET equipped_style = ? WHERE tg_id = ?', [style_id, currentUser]);
        }

        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            await syncRoom(currentRoom, io);
        }

        socket.emit('reward_success', style_id ? 'Style equipped successfully!' : 'Style unequipped.');
        const userState = await getUserState(currentUser);
        if (userState) socket.emit('user_update', userState);
    });

    socket.on('report_user', async ({ reported_id, context, reason, snapshot_data }) => {
        const currentUser = socket.data.currentUser;
        if (!currentUser || !reported_id || !context) return;
        try {
            await db.query(
                'INSERT INTO reports (reporter_id, reported_id, context, reason, snapshot_data) VALUES (?, ?, ?, ?, ?)',
                [currentUser, reported_id, context, reason, snapshot_data || 'No snapshot']
            );
            socket.emit('reward_success', 'Report submitted successfully. Thank you for keeping our community safe.');
        } catch (e) {
            console.error('Report Error:', e);
            socket.emit('create_error', 'Failed to submit report. Try again later.');
        }
    });
    
    socket.on('exchange_gems', async ({ package_id }) => {
        const packagesRaw = await redis.get('config_gem_packages');
        const packages = packagesRaw ? JSON.parse(packagesRaw) : [
            { id: 1, gems: 1, credits: 5 }, { id: 2, gems: 3, credits: 15 },
            { id: 3, gems: 5, credits: 25 }, { id: 4, gems: 10, credits: 50 }
        ];
        const pkg = packages.find(p => p.id === package_id);
        if (!pkg) return socket.emit('create_error', 'Invalid package.');
        
        const currentUser = socket.data.currentUser;
        const [userRows] = await db.query('SELECT gems, credits FROM users WHERE tg_id = ?', [currentUser]);
        if (userRows.length === 0) return;
        if (userRows[0].gems < pkg.gems) return socket.emit('create_error', 'Not enough gems.');
        
        await db.query('UPDATE users SET gems = gems - ?, credits = credits + ? WHERE tg_id = ?', [pkg.gems, pkg.credits, currentUser]);
        await redis.hincrbyfloat('user_credits', currentUser, pkg.credits);
        
        socket.emit('reward_success', `Exchanged ${pkg.gems} Gems for ${pkg.credits} Credits!`);
        const userState = await getUserState(currentUser);
        if (userState) socket.emit('user_update', userState);
    });

    socket.on('get_leaderboard', async () => {
        try {
            const weekKey = getWeekKey();
            const currentUser = socket.data.currentUser;
            
            const [inviterRows] = await db.query(`
                SELECT s.tg_id, s.invites
                FROM user_weekly_stats s
                WHERE s.week_key = ? AND s.invites > 0 
                ORDER BY s.invites DESC, s.invites_updated_at ASC LIMIT 50
            `, [weekKey]);
            
            const [guesserRows] = await db.query(`
                SELECT s.tg_id, s.guesses
                FROM user_weekly_stats s
                WHERE s.week_key = ? AND s.guesses > 0 
                ORDER BY s.guesses DESC, s.guesses_updated_at ASC LIMIT 50
            `, [weekKey]);

            const populateProfiles = async (rows, scoreField) => {
                if (rows.length === 0) return [];
                const result = [];
                const ids = rows.map(r => r.tg_id);
                
                const [userRows] = await db.query(`SELECT tg_id, avatar_url, gender, name, equipped_style FROM users WHERE tg_id IN (?)`, [ids]);
                const avatarMap = {};
                const genderMap = {};
                const nameMap = {};
                const styleMap = {};
                userRows.forEach(u => {
                    avatarMap[u.tg_id] = u.avatar_url;
                    genderMap[u.tg_id] = u.gender;
                    nameMap[u.tg_id] = u.name;
                    styleMap[u.tg_id] = u.equipped_style;
                });

                for (const row of rows) {
                    const id = row.tg_id;
                    const username = await redis.hget('user_usernames', id) || 'unset';
                    result.push({ tg_id: id, score: row[scoreField], username, avatar_url: avatarMap[id], gender: genderMap[id], name: nameMap[id], equipped_style: styleMap[id] });
                }
                return result;
            };

            const inviters = await populateProfiles(inviterRows, 'invites');
            const guessers = await populateProfiles(guesserRows, 'guesses');
            
            const prevInvitersRaw = await redis.get('previous_week_top_inviters');
            const prevGuessersRaw = await redis.get('previous_week_top_guessers');
            const prevInvitersData = prevInvitersRaw ? JSON.parse(prevInvitersRaw) : [];
            const prevGuessersData = prevGuessersRaw ? JSON.parse(prevGuessersRaw) : [];

            const prevInviters = await populateProfiles(prevInvitersData, 'invites');
            const prevGuessers = await populateProfiles(prevGuessersData, 'guesses');

            const appendUserIfOutsideTop5 = async (list, weekKeyForQuery, scoreField) => {
                if (!currentUser) return;
                const userIndex = list.findIndex(u => String(u.tg_id) === String(currentUser));
                
                if (userIndex === -1 || userIndex >= 5) {
                    let myProfile = null;
                    let myScore = 0;
                    let myRank = 'Unranked';

                    if (userIndex !== -1) {
                        myProfile = list.splice(userIndex, 1)[0];
                        myScore = myProfile.score;
                        myRank = userIndex + 1;
                    } else {
                        if (weekKeyForQuery) {
                            const [myStats] = await db.query(`SELECT ${scoreField} FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?`, [currentUser, weekKeyForQuery]);
                            if (myStats.length > 0 && myStats[0][scoreField] > 0) {
                                myScore = myStats[0][scoreField];
                                const [rankRows] = await db.query(`SELECT COUNT(*) as higher FROM user_weekly_stats WHERE week_key = ? AND ${scoreField} > ?`, [weekKeyForQuery, myScore]);
                                myRank = rankRows[0].higher + 1;
                            }
                        }
                        const [uRows] = await db.query(`SELECT tg_id, avatar_url, gender, name, equipped_style FROM users WHERE tg_id = ?`, [currentUser]);
                        if (uRows.length > 0) {
                            const u = uRows[0];
                            const username = await redis.hget('user_usernames', currentUser) || 'unset';
                            myProfile = { tg_id: currentUser, score: myScore, username, avatar_url: u.avatar_url, gender: u.gender, name: u.name, equipped_style: u.equipped_style };
                        }
                    }

                    if (myProfile) {
                        myProfile.actualRank = myRank;
                        myProfile.isCurrentUserAppend = true;
                        list.push(myProfile);
                    }
                }
            };

            await appendUserIfOutsideTop5(inviters, weekKey, 'invites');
            await appendUserIfOutsideTop5(prevInviters, null, 'invites');

            socket.emit('leaderboard_data', { inviters, guessers, prevInviters, prevGuessers });
        } catch (err) {
            console.error('Leaderboard error:', err);
        }
    });

    socket.on('get_donators_leaderboard', async () => {
        try {
            const [rows] = await db.query(`
                SELECT d.tg_id, d.total_donated, u.avatar_url, u.gender, u.name, u.equipped_style
                FROM donations d
                LEFT JOIN users u ON d.tg_id = u.tg_id
                ORDER BY d.total_donated DESC LIMIT 50
            `);
            
            const leaderboard = [];
            for (const row of rows) {
                const username = await redis.hget('user_usernames', row.tg_id) || 'unset';
                leaderboard.push({ tg_id: row.tg_id, total_donated: row.total_donated, username, avatar_url: row.avatar_url, gender: row.gender, name: row.name, equipped_style: row.equipped_style });
            }
            socket.emit('donators_leaderboard_data', leaderboard);
        } catch (err) { console.error('Donators leaderboard error:', err); }
    });

    socket.on('claim_top_inviter_reward', async () => {
        try {
            const currentUser = socket.data.currentUser;
            if (!currentUser) return;

            const prevInvitersRaw = await redis.get('previous_week_top_inviters');
            if (!prevInvitersRaw) return socket.emit('create_error', 'No previous week data available.');
            
            const prevInvitersData = JSON.parse(prevInvitersRaw);
            const top5 = Array.isArray(prevInvitersData) ? prevInvitersData.slice(0, 5) : [];
            const inTop5 = top5.some(u => String(u.tg_id) === String(currentUser));
            
            if (!inTop5) {
                return socket.emit('create_error', 'You were not in the top 5 inviters last week.');
            }

            const weekKey = getWeekKey();
            
            const [uRows] = await db.query('SELECT last_top_inviter_claim_week FROM users WHERE tg_id = ?', [currentUser]);
            if (uRows.length === 0) return;
            
            if (uRows[0].last_top_inviter_claim_week === weekKey) {
                return socket.emit('create_error', 'You have already claimed your Top Inviter reward for last week!');
            }

            await db.query('UPDATE users SET gems = gems + 5, last_top_inviter_claim_week = ? WHERE tg_id = ?', [weekKey, currentUser]);
            
            socket.emit('reward_success', 'Claimed 5 Gems for being a Top Inviter last week! 🏆💎');
            
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);

        } catch (e) {
            console.error('claim_top_inviter_reward Error:', e);
        }
    });

    socket.on('set_gender', async ({ gender }) => {
        const currentUser = socket.data.currentUser;
        if (!currentUser || !['Male', 'Female', 'Other'].includes(gender)) return;
        try {
            const [rows] = await db.query('SELECT gender, credits FROM users WHERE tg_id = ?', [currentUser]);
            if (rows.length === 0) return;
            
            let cost = 0;
            if (rows[0].gender !== null && rows[0].gender !== '') {
                cost = 5;
                if (rows[0].credits < 5) return socket.emit('create_error', 'Not enough credits to change gender.');
            }
            
            if (cost > 0) {
                await db.query('UPDATE users SET credits = credits - ?, gender = ? WHERE tg_id = ?', [cost, gender, currentUser]);
                await redis.hset('user_credits', currentUser, rows[0].credits - cost);
            } else {
                await db.query('UPDATE users SET gender = ? WHERE tg_id = ?', [gender, currentUser]);
            }
            socket.emit('reward_success', `Gender updated to ${gender}.`);
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        } catch (err) { console.error('Set Gender Error:', err); }
    });

    socket.on('set_name', async ({ name }) => {
        const currentUser = socket.data.currentUser;
        if (!currentUser || typeof name !== 'string' || name.trim().length < 2) return;
        try {
            const [rows] = await db.query('SELECT name, credits FROM users WHERE tg_id = ?', [currentUser]);
            if (rows.length === 0) return;
            
            let cost = 0;
            if (rows[0].name !== null && rows[0].name !== '') {
                cost = 5;
                if (rows[0].credits < 5) return socket.emit('create_error', 'Not enough credits to change name.');
            }
            
            const finalName = name.trim();
            
            if (cost > 0) {
                await db.query('UPDATE users SET credits = credits - ?, name = ? WHERE tg_id = ?', [cost, finalName, currentUser]);
                await redis.hset('user_credits', currentUser, rows[0].credits - cost);
            } else {
                await db.query('UPDATE users SET name = ? WHERE tg_id = ?', [finalName, currentUser]);
            }
            socket.emit('reward_success', `Name updated to ${finalName}.`);
            const userState = await getUserState(currentUser);
            if (userState) socket.emit('user_update', userState);
        } catch (err) { console.error('Set Name Error:', err); }
    });

    socket.on('active_event', () => {
        socket.data.lastActiveEvent = Date.now();
        socket.data.idleWarned = false;
    });

    socket.on('claim_reward', async ({ type }) => {
        try {
            const currentUser = socket.data.currentUser;
            if (!currentUser) return;
            let success = false;
            let msg = '';
            let rewardAmount = 0;

            if (type === 'daily') {
                const [userRows] = await db.query(`
                    SELECT streak_count,
                    (last_streak_claim IS NOT NULL AND DATE_FORMAT(last_streak_claim, '%Y-%m-%d') = DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL 1 DAY), '%Y-%m-%d')) as streak_maintained,
                    (last_streak_claim IS NULL OR DATE_FORMAT(last_streak_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as can_claim
                    FROM users WHERE tg_id = ?
                `, [currentUser]);
                
                if (userRows.length > 0) {
                    const u = userRows[0];
                    if (u.can_claim) {
                        let newStreak = u.streak_maintained ? (u.streak_count || 0) + 1 : 1;
                        rewardAmount = Math.min(newStreak, 7); 
                        await db.query(`
                            UPDATE users SET credits = credits + ?, streak_count = ?, last_streak_claim = UTC_DATE(), last_daily_claim = UTC_DATE()
                            WHERE tg_id = ?
                        `, [rewardAmount, newStreak, currentUser]);
                        success = true;
                        msg = `Daily streak Day ${newStreak} claimed! +${rewardAmount} Credit${rewardAmount > 1 ? 's' : ''}`;
                    } else {
                        msg = 'Daily reward already claimed today.';
                    }
                }
            } 
            else if (type === 'ad' || type === 'ad2') {
                const prefix = type === 'ad' ? 'ad' : 'ad2';
                const cooldown = prefix === 'ad' ? 60 : 10;
                const maxClaims = prefix === 'ad' ? 3 : 5; 
                
                const [u] = await db.query(`SELECT
                    ${prefix}_claims_today as claims,
                    DATE_FORMAT(last_${prefix}_claim_time, '%Y-%m-%d') as last_date,
                    DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') as today,
                    TIMESTAMPDIFF(MINUTE, last_${prefix}_claim_time, UTC_TIMESTAMP()) as mins_passed
                    FROM users WHERE tg_id = ?`, [currentUser]);

                if (u.length > 0) {
                    const user = u[0];
                    const isToday = user.last_date === user.today;

                    if (!user.last_date || !isToday) {
                        rewardAmount = 1;
                        await db.query(`UPDATE users SET credits = credits + ?, ${prefix}_claims_today = 1, last_${prefix}_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, currentUser]);
                        success = true; msg = `Reward claimed! +${rewardAmount} Credit`;
                    } else if (user.claims < maxClaims && (user.mins_passed === null || user.mins_passed >= cooldown)) {
                        const newClaimCount = user.claims + 1;
                        rewardAmount = 1;
                        if (prefix === 'ad') {
                            await db.query(`UPDATE users SET credits = credits + ?, ad_claims_today = ?, last_ad_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                        } else {
                            await db.query(`UPDATE users SET credits = credits + ?, ad2_claims_today = ?, last_ad2_claim_time = UTC_TIMESTAMP() WHERE tg_id = ?`, [rewardAmount, newClaimCount, currentUser]);
                        }
                        success = true; msg = `Reward claimed! +${rewardAmount} Credit`;
                    } else {
                        msg = 'Ad reward not ready yet or max claims reached.';
                    }
                }
            } else if (type === 'invite_reward') {
                const weekKey = getWeekKey();
                
                const [statsRows] = await db.query(
                    `SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?`, 
                    [currentUser, weekKey]
                );
                
                const invitesThisWeek = statsRows.length > 0 ? statsRows[0].invites : 0;
                
                if (invitesThisWeek >= 3) {
                    rewardAmount = 5;
                    const [updateResult] = await db.query(
                        `UPDATE users SET credits = credits + ?, last_invite_claim_week = ? WHERE tg_id = ? AND (last_invite_claim_week != ? OR last_invite_claim_week IS NULL)`, 
                        [rewardAmount, weekKey, currentUser, weekKey]
                    );
                    
                    if (updateResult.affectedRows > 0) {
                        success = true; 
                        msg = 'Invite reward claimed! +5 Credits';
                    } else {
                        msg = 'Invite reward already claimed for this week.';
                    }
                } else {
                    msg = 'Invite requirement not met (requires 3 invites this week).';
                }
            } else if (type === 'daily_guess') {
                const guessRewardRaw = await redis.get('config_guess_reward');
                const guessReward = guessRewardRaw ? JSON.parse(guessRewardRaw) : { required: 5, reward: 10 };
                
                const [uRows] = await db.query(`SELECT daily_correct_guesses, 
                    (DATE_FORMAT(last_correct_guess_date, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as guess_date_is_today,
                    (DATE_FORMAT(last_guess_reward_claim, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as guess_reward_claimed_today
                    FROM users WHERE tg_id = ?`, [currentUser]);
                    
                if (uRows.length > 0) {
                    const u = uRows[0];
                    const validGuesses = u.guess_date_is_today ? u.daily_correct_guesses : 0;
                    
                    if (validGuesses >= guessReward.required && !u.guess_reward_claimed_today) {
                        rewardAmount = guessReward.reward;
                        await db.query(`UPDATE users SET credits = credits + ?, last_guess_reward_claim = UTC_DATE() WHERE tg_id = ?`, [rewardAmount, currentUser]);
                        success = true; 
                        msg = `Daily Guess Reward claimed! +${rewardAmount} Credits`;
                    } else {
                        msg = 'Requirement not met or already claimed today.';
                    }
                }
            }

            if (success) {
                await redis.hincrbyfloat('user_credits', currentUser, rewardAmount);
                socket.emit('reward_success', msg);
                const userState = await getUserState(currentUser);
                if (userState) socket.emit('user_update', userState);
            } else {
                socket.emit('create_error', msg || 'Could not claim reward.');
            }
        } catch (err) {
            console.error('Claim Error:', err);
        }
    });

    socket.on('disconnect', async () => {
        const currentUser = socket.data.currentUser;
        const currentRoom = socket.data.currentRoom;
        if (currentUser) {
            await redis.hset('user_disconnects', currentUser, Date.now());
            
            setTimeout(async () => {
                const isDisconnected = await redis.hget('user_disconnects', currentUser);
                if (isDisconnected && currentRoom) {
                    const room = await getRoom(currentRoom);
                    if (room) {
                        room.members = room.members.filter(m => m.user_id !== currentUser);
                        await saveRoom(room);
                        await checkRoomReset(currentRoom);
                        await syncRoom(currentRoom, io);
                        await broadcastRooms(io);
                    }
                    await redis.hdel('user_disconnects', currentUser);
                }
            }, 10000);
        }
    });
};