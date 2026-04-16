const crypto = require('crypto');
const config = require('./config');

function validateInitData(initData, token) {
    if (!initData || !token) return false;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const keys = Array.from(urlParams.keys()).sort();
        const dataCheckString = keys.map(key => `${key}=${urlParams.get(key)}`).join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

const tgApiCall = (method, data) => {
    if (!config.BOT_TOKEN) return;
    const https = require('https');
    const payload = JSON.stringify(data);
    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${config.BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };
    const request = https.request(options);
    request.on('error', console.error);
    request.write(payload);
    request.end();
};

const sendMsg = (chatId, text, replyMarkup) => {
    tgApiCall('sendMessage', { chat_id: chatId, text, reply_markup: replyMarkup });
};

// Get current ISO year-week format (e.g., "2024-W12")
function getWeekKey() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    const weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
    return `${d.getUTCFullYear()}-W${weekNo}`;
}

const toHex = (id) => id ? "0x" + Number(id).toString(16).toUpperCase().slice(-6) : '';

module.exports = { validateInitData, tgApiCall, sendMsg, getWeekKey, toHex };
