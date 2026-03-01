const { API_ID, API_HASH, BOT_TOKEN, LOG_PEER } = process.env;

if (!API_ID || !API_HASH || !BOT_TOKEN || !LOG_PEER || isNaN(Number(API_ID)) || isNaN(Number(LOG_PEER))) {
    throw new Error("Invalid env: API_ID, API_HASH, BOT_TOKEN, and LOG_PEER are required.");
}

export const env = {
    API_ID: Number(API_ID),
    API_HASH,
    BOT_TOKEN,
    LOG_PEER: Number(LOG_PEER),
};
