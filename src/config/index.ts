export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  PREFIX: process.env.LEADERBOARD_PREFIX || "rocket-rush:leaderboard",
  KEY_USERNAMES: process.env.KEY_USERNAMES || "rocket-rush:usernames",
  KEY_USERNAME_INDEX: process.env.KEY_USERNAME_INDEX || "rocket-rush:username:index",
  KEY_USERNAMES_REVERSE: process.env.KEY_USERNAMES_REVERSE || "rocket-rush:usernames:reverse",
  KEY_UUID_INDEX: process.env.KEY_UUID_INDEX || "rocket-rush:uuid:index",
  TOPIC: process.env.WS_TOPIC || "leaderboard",
  WEEK_TTL: 60 * 60 * 24 * 14,
  USERNAME_RESERVATION_TTL: 300,
  USERNAME: {
    MIN_LENGTH: 3,
    MAX_LENGTH: 16,
    PATTERN: /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/,
  },
  WEEK_CHECK_INTERVAL_MS: 60_000,
} as const;
