const rateLimit = require('express-rate-limit');
const { db, redis } = require('./database');
const { validateInitData, tgApiCall, sendMsg, getWeekKey } = require('./utils');
const { getUserState } = require('./userManager');
const config = require('./config');

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100, 
    message: { error: 'Too many authentication requests from this IP, please try again after 15 minutes.' },
    standardHeaders: true, 
    legacyHeaders: false,
});

module.exports = (app, io) => {
    app.get('/sw.js', (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.send(`
            const CACHE_NAME = 'doodledash-cache-v5'; 
            const urlsToCache = [
                '/audio/mgs_notification.mp3',
                '/audio/guess_notification.mp3',
                'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
                'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
                'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap'
            ];
            
            self.addEventListener('install', event => {
                self.skipWaiting();
                event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
            });

            self.addEventListener('activate', event => {
                event.waitUntil(
                    caches.keys().then(cacheNames => {
                        return Promise.all(
                            cacheNames.map(cacheName => {
                                if (cacheName !== CACHE_NAME) {
                                    return caches.delete(cacheName);
                                }
                            })
                        );
                    })
                );
                return self.clients.claim();
            });

            self.addEventListener('fetch', event => {
                if (event.request.mode === 'navigate' || event.request.url.includes('index.html')) {
                    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
                } else {
                    event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
                }
            });
        `);
    });

    app.get('/postback', async (req, res) => {
        const { ymid, event_type, reward_event_type, estimated_price, zone } = req.query;
        if (reward_event_type === 'valued' && ymid) {
            try {
                console.log(`[Monetag Postback] User ${ymid} successfully completed ad for Zone: ${zone}. Revenue: ${estimated_price}`);
            } catch (err) {
                console.error('[Monetag Postback DB Error]', err);
            }
        }
        res.sendStatus(200); 
    });

    app.post('/api/authenticate', authLimiter, async (req, res) => {
        const { initData } = req.body;
        if (!initData) return res.status(400).json({ error: 'Missing initData' });

        const isMock = process.env.NODE_ENV !== 'production' && initData.includes('mock_web_auth=true');
        
        if (!isMock && config.BOT_TOKEN && !validateInitData(initData, config.BOT_TOKEN)) {
            return res.status(403).json({ error: 'Invalid authentication payload.' });
        }

        try {
            const urlParams = new URLSearchParams(initData);
            const userObjStr = urlParams.get('user');
            
            if (!userObjStr) return res.status(400).json({ error: 'No user data in payload.' });
            
            let userObj;
            try {
                userObj = JSON.parse(userObjStr);
            } catch (e) {
                return res.status(400).json({ error: 'Malformed user data format.' });
            }

            const tgId = userObj.id.toString();
            const photoUrl = userObj.photo_url || null;

            if (userObj.username) {
                await redis.hset('user_usernames', tgId, userObj.username);
            }

            if (photoUrl) {
                await db.query(`UPDATE users SET avatar_url = ? WHERE tg_id = ?`, [photoUrl, tgId]);
            }

            const [rows] = await db.query(`SELECT status, DATE_FORMAT(ban_until, '%Y-%m-%d') as ban_until_str FROM users WHERE tg_id = ?`, [tgId]);
            
            if (rows.length === 0) {
                return res.json({ success: false, error: 'not_registered' });
            }
            
            const user = rows[0];
            if (user.status === 'ban' && user.ban_until_str) {
                const todayStr = new Date().toISOString().split('T')[0];
                if (user.ban_until_str >= todayStr) {
                    sendMsg(tgId, `🛑 You are currently banned until ${user.ban_until_str}.\n\nYou can lift this ban immediately for 50 Telegram Stars.`, {
                        inline_keyboard: [[{ text: '🔓 Unban (50 ⭐️)', callback_data: 'unban_action' }]]
                    });
                    return res.json({ success: false, error: 'banned' });
                } else {
                    await db.query(`UPDATE users SET status = 'active', ban_until = NULL WHERE tg_id = ?`, [tgId]);
                }
            }

            await db.query(`UPDATE users SET last_active = UTC_TIMESTAMP() WHERE tg_id = ?`, [tgId]);

            res.json({ success: true, userId: tgId });
        } catch (err) {
            console.error('/api/authenticate error:', err);
            res.status(500).json({ error: 'Internal server error during authentication.' });
        }
    });

    app.post('/webhook', async (req, res) => {
        const secretToken = req.headers['x-telegram-bot-api-secret-token'];
        if (config.WEBHOOK_SECRET && secretToken !== config.WEBHOOK_SECRET) {
            return res.status(403).send('Unauthorized');
        }

        const update = req.body;
        res.sendStatus(200); 

        if (!config.BOT_TOKEN) return;

        if (update?.message?.from?.username) {
            redis.hset('user_usernames', update.message.from.id.toString(), update.message.from.username);
        }
        if (update?.callback_query?.from?.username) {
            redis.hset('user_usernames', update.callback_query.from.id.toString(), update.callback_query.from.username);
        }

        const host = req.get('host');
        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const fallbackUrl = `${protocol}://${host}/`;
        const webAppUrl = process.env.WEBAPP_URL || fallbackUrl; 

        if (update?.pre_checkout_query) {
            tgApiCall('answerPreCheckoutQuery', { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
            return;
        }

        if (update?.message?.successful_payment) {
            try {
                const payload = JSON.parse(update.message.successful_payment.invoice_payload);
                const buyerId = payload.tgId;
                const type = payload.type || 'credits'; 
                
                if (type === 'gems') {
                    await db.query('UPDATE users SET gems = gems + ? WHERE tg_id = ?', [payload.amount, buyerId]);
                    sendMsg(update.message.chat.id, `✅ Successfully purchased ${payload.amount} Gems!`);
                    const userState = await getUserState(buyerId);
                    if (userState) io.to(`user_${buyerId}`).emit('user_update', userState);
                } else if (type === 'credits') {
                    const addedCredits = payload.amount * config.CREDITS_PER_STAR;
                    const currentCredits = parseFloat(await redis.hget('user_credits', buyerId)) || 0;
                    await redis.hset('user_credits', buyerId, currentCredits + addedCredits);
                    
                    await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [addedCredits, buyerId]);
                    sendMsg(update.message.chat.id, `✅ Successfully purchased ${addedCredits} Credits! Your balance has been updated.`);
                    
                    const userState = await getUserState(buyerId);
                    if (userState) io.to(`user_${buyerId}`).emit('user_update', userState);
                } else if (type === 'unban') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(ban_until, '%Y-%m-%d') as ban_until_str FROM users WHERE tg_id = ?`, [buyerId]);
                    let alreadyActive = false;
                    if (rows.length > 0) {
                        const u = rows[0];
                        if (u.status !== 'ban' || !u.ban_until_str) alreadyActive = true;
                        else if (u.ban_until_str < new Date().toISOString().split('T')[0]) alreadyActive = true;
                    } else { alreadyActive = true; }

                    if (alreadyActive) {
                        const refundCredits = 50 * config.CREDITS_PER_STAR;
                        await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [refundCredits, buyerId]);
                        await redis.hincrbyfloat('user_credits', buyerId, refundCredits);
                        sendMsg(update.message.chat.id, `✅ You were already unbanned! Your payment of 50 stars has been converted to ${refundCredits} Credits.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', ban_until = NULL WHERE tg_id = ?`, [buyerId]);
                        sendMsg(buyerId, "✅ Your account has been successfully unbanned! You can now access the app.");
                    }
                } else if (type === 'unmute') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [buyerId]);
                    let alreadyActive = false;
                    if (rows.length > 0) {
                        const u = rows[0];
                        if (u.status !== 'mute' || !u.mute_until_str) alreadyActive = true;
                        else if (u.mute_until_str < new Date().toISOString().split('T')[0]) alreadyActive = true;
                    } else { alreadyActive = true; }

                    if (alreadyActive) {
                        const refundCredits = 25 * config.CREDITS_PER_STAR;
                        await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [refundCredits, buyerId]);
                        await redis.hincrbyfloat('user_credits', buyerId, refundCredits);
                        sendMsg(update.message.chat.id, `✅ You were already unmuted! Your payment of 25 stars has been converted to ${refundCredits} Credits.`);
                    } else {
                        await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [buyerId]);
                        sendMsg(buyerId, "✅ You have been unmuted! You can now chat in rooms.");
                    }
                } else if (type === 'donate') {
                    const donAmount = payload.amount;
                    await db.query('INSERT INTO donations (tg_id, total_donated) VALUES (?, ?) ON DUPLICATE KEY UPDATE total_donated = total_donated + ?', [buyerId, donAmount, donAmount]);
                    await redis.del('donators_leaderboard'); 
                    sendMsg(buyerId, `💖 Thank you for donating ${donAmount} Stars! Your support keeps DoodleDash alive.`);
                }
            } catch(e) { console.error('Payment processing error:', e); }
            return;
        }

        // --- ADMIN PANEL WEBHOOK INTEGRATION ---
        const adminModule = require('./adminBackend');
        if (await adminModule.handleAdminWebhook(update)) return;
        // ---------------------------------------

        if (update?.message?.text && update.message.text.startsWith('/start')) {
            const chatId = update.message.chat.id;
            const tgId = update.message.from.id.toString();
            const text = update.message.text;
            
            try {
                if (text === '/start unmute') {
                    const [rows] = await db.query(`SELECT status, DATE_FORMAT(mute_until, '%Y-%m-%d') as mute_until_str FROM users WHERE tg_id = ?`, [tgId]);
                    if (rows.length > 0 && rows[0].status === 'mute' && rows[0].mute_until_str) {
                        const todayStr = new Date().toISOString().split('T')[0];
                        if (rows[0].mute_until_str >= todayStr) {
                            sendMsg(chatId, `🔇 You are currently muted until ${rows[0].mute_until_str}.\n\nYou can lift this mute immediately for 25 Telegram Stars.`, {
                                inline_keyboard: [[{ text: '🔊 Unmute (25 ⭐️)', callback_data: 'unmute_action' }]]
                            });
                            return;
                        } else {
                            await db.query(`UPDATE users SET status = 'active', mute_until = NULL WHERE tg_id = ?`, [tgId]);
                        }
                    }
                    sendMsg(chatId, "You are not currently muted.");
                    return;
                }

                if (text.startsWith('/start buygems_')) {
                    const gems = parseInt(text.split('_')[1]);
                    if (!isNaN(gems)) {
                        const payload = JSON.stringify({ tgId, type: 'gems', amount: gems });
                        tgApiCall('sendInvoice', {
                            chat_id: chatId,
                            title: `${gems} Gems`,
                            description: `Purchase ${gems} Gems to exchange for credits.`,
                            payload: payload,
                            provider_token: "", 
                            currency: "XTR",
                            prices: [{ label: `${gems} Gems`, amount: gems }] // Simple scaling assuming 1 gem = 1 star
                        });
                    }
                    return;
                }
                
                if (text === '/start donate') {
                    sendMsg(chatId, "💖 Support DoodleDash!\nSelect an amount to donate in Telegram Stars:", {
                        inline_keyboard: [
                            [{ text: 'Donate 1 ⭐️', callback_data: 'donate_1' }, { text: 'Donate 5 ⭐️', callback_data: 'donate_5' }],
                            [{ text: 'Donate 10 ⭐️', callback_data: 'donate_10' }, { text: 'Donate 20 ⭐️', callback_data: 'donate_20' }],
                            [{ text: 'Donate 50 ⭐️', callback_data: 'donate_50' }, { text: 'Donate 100 ⭐️', callback_data: 'donate_100' }]
                        ]
                    });
                    return;
                }

                const [userRows] = await db.query('SELECT accepted_policy FROM users WHERE tg_id = ?', [tgId]);
                const hasAccepted = userRows.length > 0 && userRows[0].accepted_policy;

                if (!hasAccepted) {
                    let inviterId = 'none';
                    const parts = text.split(' ');
                    if (parts.length > 1 && parts[1].startsWith('invite_')) {
                        inviterId = parts[1].replace('invite_', '');
                    }
                    sendMsg(chatId, "📜 *Welcome to DoodleDash!*\n\nPlease read and accept our Privacy Policy to start playing, earning rewards, and inviting friends.", {
                        inline_keyboard: [[{ text: "✅ I've read and accept", callback_data: `accept_policy_${inviterId}` }]]
                    });
                    return;
                }

                // Normal app start
                const urlWithParams = `${webAppUrl}`;
                sendMsg(chatId, 'Welcome back to DoodleDash! Click below to play.', {
                    inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: urlWithParams } }]]
                });

            } catch (e) {
                console.error('Webhook DB Error:', e);
            }
        } else if (update?.callback_query) {
            const query = update.callback_query;
            const chatId = query.message.chat.id;
            const tgId = query.from.id.toString();

            if (query.data.startsWith('claim_weekly_')) {
                const parts = query.data.split('_');
                const week = parts[2];
                const amount = parseInt(parts[3]);
                
                const lockKey = `claimed_weekly_${week}_${tgId}`;
                const locked = await redis.set(lockKey, '1', 'EX', 86400 * 30, 'NX'); 
                if (locked) {
                    await db.query('UPDATE users SET credits = credits + ? WHERE tg_id = ?', [amount, tgId]);
                    await redis.hincrbyfloat('user_credits', tgId, amount);
                    
                    tgApiCall('deleteMessage', { chat_id: chatId, message_id: query.message.message_id });
                    sendMsg(chatId, `✅ You successfully claimed ${amount} credits for the weekly challenge!`);
                    
                    const userState = await getUserState(tgId);
                    if (userState) io.to(`user_${tgId}`).emit('user_update', userState);
                } else {
                    tgApiCall('answerCallbackQuery', { callback_query_id: query.id, text: "Already claimed!", show_alert: true });
                }
                return;
            }

            if (query.data.startsWith('accept_policy_')) {
                const inviterId = query.data.replace('accept_policy_', '');

                try {
                    await db.query(`
                        INSERT INTO users (tg_id, credits, accepted_policy, status, last_active) 
                        VALUES (?, 5, TRUE, 'active', UTC_TIMESTAMP()) 
                        ON DUPLICATE KEY UPDATE accepted_policy = TRUE, last_active = UTC_TIMESTAMP()
                    `, [tgId]);

                    if (inviterId && inviterId !== 'none' && inviterId !== tgId) {
                        const [res] = await db.query('INSERT IGNORE INTO referrals (inviter_id, invited_id) VALUES (?, ?)', [inviterId, tgId]);
                        if (res.affectedRows > 0) {
                            const weekKey = getWeekKey();
                            await db.query(`
                                INSERT INTO user_weekly_stats (tg_id, week_key, invites, invites_updated_at)
                                VALUES (?, ?, 1, UTC_TIMESTAMP())
                                ON DUPLICATE KEY UPDATE invites = invites + 1, invites_updated_at = UTC_TIMESTAMP()
                            `, [inviterId, weekKey]);
                            
                            sendMsg(inviterId, "🎉 A new user joined via your link! Check your Tasks to track your weekly progress and claim credits.");
                            
                            const userState = await getUserState(inviterId);
                            if (userState) io.to(`user_${inviterId}`).emit('user_update', userState);
                        }
                    }

                    tgApiCall('editMessageText', {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        text: "✅ Privacy Policy Accepted!\n\nWelcome to DoodleDash. Click below to play.",
                        reply_markup: {
                            inline_keyboard: [[{ text: '🎮 Play Now', web_app: { url: `${webAppUrl}` } }]]
                        }
                    });
                    tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
                } catch(e) { console.error('Policy Accept Error:', e); }
                return;
            }

            if (query.data.startsWith('donate_')) {
                const amount = parseInt(query.data.split('_')[1]);
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'donate', amount: amount });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Donate to DoodleDash`,
                    description: `Support DoodleDash with a donation of ${amount} Stars!`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Donation`, amount: amount }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            } else if (query.data === 'unban_action') {
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'unban' });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Unban Account`,
                    description: `Lift your ban immediately and regain access to DoodleDash.`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Unban Fee`, amount: 50 }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            } else if (query.data === 'unmute_action') {
                const payload = JSON.stringify({ tgId: tgId.toString(), type: 'unmute' });
                tgApiCall('sendInvoice', {
                    chat_id: chatId,
                    title: `Unmute Account`,
                    description: `Lift your chat mute immediately and regain chatting privileges.`,
                    payload: payload,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: `Unmute Fee`, amount: 25 }]
                });
                tgApiCall('answerCallbackQuery', { callback_query_id: query.id });
            }
        }
    });
};
