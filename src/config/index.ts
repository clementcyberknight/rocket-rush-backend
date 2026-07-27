export const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000", 10),
  REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
  PREFIX: process.env.LEADERBOARD_PREFIX || "rocket-rush:leaderboard",
  KEY_USERNAMES: process.env.KEY_USERNAMES || "rocket-rush:usernames",
  TOPIC: process.env.WS_TOPIC || "leaderboard",
  WEEK_TTL: 60 * 60 * 24 * 14,
  ANTI_CHEAT: {
    MAX_SCORE_RATE: 500,
    MAX_PLAUSIBLE_SCORE_PER_SEC: 450,
    MAX_PLAUSIBLE_SCORE_BASE: 50,
    MIN_TICK_DELTA_TIME: 0.05,
    MIN_DELTA_SCORE: -5,
  },
  WEEK_CHECK_INTERVAL_MS: 60_000,
} as const;
