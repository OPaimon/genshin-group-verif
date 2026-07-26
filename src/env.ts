const { API_ID, API_HASH, BOT_TOKEN, LOG_PEER, ADMIN_IDS, AD_LIST_URL } = process.env

if (!API_ID || !API_HASH || !BOT_TOKEN || !LOG_PEER || Number.isNaN(Number(API_ID)) || Number.isNaN(Number(LOG_PEER))) {
    throw new Error('Invalid env: API_ID, API_HASH, BOT_TOKEN, and LOG_PEER are required.')
}

const adminIds = (ADMIN_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(Number)

if (adminIds.some(Number.isNaN)) {
    throw new Error('Invalid env: ADMIN_IDS must be a comma-separated list of numeric user IDs.')
}

export const env = {
    API_ID: Number(API_ID),
    API_HASH,
    BOT_TOKEN,
    LOG_PEER: Number(LOG_PEER),
    // Users allowed to run privileged commands (/reload). Empty = disabled.
    ADMIN_IDS: adminIds,
    // Ad block appended to verification messages. Unset = default link;
    // set to an empty string to disable the ad entirely.
    AD_LIST_URL: AD_LIST_URL ?? 'https://t.me/addlist/UEpWJGzDD6A1Y2I1',
}
