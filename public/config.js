import { Database } from "./database";

export const TWITCH_APP_ID = await Database.get("twitch_app_id");
export const TWITCH_APP_SECRET = await Database.get("twitch_app_secret");
export const TWITCH_REFRESH = await Database.get("twitch_refresh_token");
export const TWITCH_OAUTH_BOT = await Database.get("twitch_oauth_bot");

export const FIREBASE_SECRET = env.FIREBASE_SECRET;
export const FIREBASE_URL = env.FIREBASE_URL;

