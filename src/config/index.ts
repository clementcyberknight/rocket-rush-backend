export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  PREFIX: process.env.LEADERBOARD_PREFIX || "rocket-rush:leaderboard",
  KEY_USERNAMES: process.env.KEY_USERNAMES || "rocket-rush:usernames",
  KEY_USERNAME_INDEX: process.env.KEY_USERNAME_INDEX || "rocket-rush:username:index",
  TOPIC: process.env.WS_TOPIC || "leaderboard",
  WEEK_TTL: 60 * 60 * 24 * 14,
  WEEK_CHECK_INTERVAL_MS: 60_000,
} as const;
