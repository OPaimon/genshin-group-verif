const { API_ID, API_HASH, BOT_TOKEN } = process.env;

if (!API_ID || !API_HASH || !BOT_TOKEN || isNaN(Number(API_ID))) {
    throw new Error("Invalid env: API_ID, API_HASH, and BOT_TOKEN are required.");
}

export const env = {
    API_ID: Number(API_ID),
    API_HASH,
    BOT_TOKEN,
};
