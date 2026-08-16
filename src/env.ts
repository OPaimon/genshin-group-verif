const { API_ID, API_HASH, BOT_TOKEN, LOG_PEER, ADMIN_IDS, AD_LIST_URL, STATE_BACKEND, STATE_SQLITE_PATH, SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_LOG_LEVEL } = process.env

if (!API_ID || !API_HASH || !BOT_TOKEN || !LOG_PEER || Number.isNaN(Number(API_ID)) || Number.isNaN(Number(LOG_PEER))) {
    throw new Error('Invalid env: API_ID, API_HASH, BOT_TOKEN, and LOG_PEER are required.')
}

const stateBackend = STATE_BACKEND ?? 'memory'
if (stateBackend !== 'memory' && stateBackend !== 'sqlite') {
    throw new Error('Invalid env: STATE_BACKEND must be one of "memory", "sqlite".')
}

const adminIds = (ADMIN_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(Number)

if (adminIds.some(Number.isNaN)) {
    throw new Error('Invalid env: ADMIN_IDS must be a comma-separated list of numeric user IDs.')
}

const logLevel = SENTRY_LOG_LEVEL ?? 'info'
if (logLevel !== 'debug' && logLevel !== 'info' && logLevel !== 'warn' && logLevel !== 'error') {
    throw new Error('Invalid env: SENTRY_LOG_LEVEL must be one of "debug", "info", "warn", "error".')
}

export const env = {
    API_ID: Number(API_ID),
    API_HASH,
    BOT_TOKEN,
    LOG_PEER: Number(LOG_PEER),
    // Sentry error monitoring. Empty/absent = Sentry is completely disabled
    // (the local-dev default). Set to a project DSN to enable reporting.
    SENTRY_DSN: SENTRY_DSN ?? '',
    // Tag attached to Sentry events. Defaults to production in the built
    // bundle (NODE_ENV is defined there) and development everywhere else.
    SENTRY_ENVIRONMENT: SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV === 'production' ? 'production' : 'development'),
    // Minimum console level forwarded to Sentry Logs. Defaults to info
    // (debug stays local unless explicitly requested).
    SENTRY_LOG_LEVEL: logLevel as 'debug' | 'info' | 'warn' | 'error',
    // Users allowed to run privileged commands (/reload). Empty = disabled.
    ADMIN_IDS: adminIds,
    // Ad block appended to verification messages. Unset = default link;
    // set to an empty string to disable the ad entirely.
    AD_LIST_URL: AD_LIST_URL ?? 'https://t.me/addlist/UEpWJGzDD6A1Y2I1',
    // Verification-state storage backend. memory = volatile (default);
    // sqlite survives restarts (main.ts re-arms timeout observers on boot).
    STATE_BACKEND: stateBackend,
    STATE_SQLITE_PATH: STATE_SQLITE_PATH ?? 'bot-data/state.db',
}
