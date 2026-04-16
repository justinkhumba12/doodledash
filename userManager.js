const { db, redis } = require('./database');
const { getWeekKey } = require('./utils');

async function getUserState(tg_id) {
    const weekKey = getWeekKey();
    
    const [statsRows] = await db.query('SELECT invites FROM user_weekly_stats WHERE tg_id = ? AND week_key = ?', [tg_id, weekKey]);
    const weeklyInvites = statsRows.length > 0 ? statsRows[0].invites : 0;

    const [rows] = await db.query(`
        SELECT *,
        (last_daily_claim IS NULL OR DATE_FORMAT(last_daily_claim, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as daily_available,
        (last_ad_claim_time IS NULL OR DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad_claims_today < 3 AND TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()) >= 60)) as ad1_available,
        (last_ad2_claim_time IS NULL OR DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') != DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') OR (ad2_claims_today < 5 AND TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()) >= 10)) as ad2_available,
        GREATEST(0, 60 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad_claim_time, UTC_TIMESTAMP()), 60)) as ad1_wait_mins,
        GREATEST(0, 10 - IFNULL(TIMESTAMPDIFF(MINUTE, last_ad2_claim_time, UTC_TIMESTAMP()), 10)) as ad2_wait_mins,
        (DATE_FORMAT(last_ad_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad1_is_today,
        (DATE_FORMAT(last_ad2_claim_time, '%Y-%m-%d') = DATE_FORMAT(UTC_DATE(), '%Y-%m-%d')) as ad2_is_today,
        (last_invite_claim_week = ?) as invite_claimed_this_week
        FROM users WHERE tg_id = ?
    `, [weekKey, tg_id]);

    if (rows.length === 0) return null;
    let u = rows[0];
    
    // Attach DB weekly invites
    u.weekly_invites = weeklyInvites;

    await redis.hset('user_credits', tg_id, u.credits);
    
    if (!u.ad1_is_today) u.ad_claims_today = 0;
    if (!u.ad2_is_today) u.ad2_claims_today = 0;
    return u;
}

module.exports = { getUserState };
