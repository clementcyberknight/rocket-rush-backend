import { redis } from "bun";
import { CONFIG } from "../config";
import type { LeaderboardEntry } from "../types";

function toStr(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return new TextDecoder().decode(val);
  }
  return String(val);
}

function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  const str = toStr(val);
  const parsed = parseFloat(str);
  return isNaN(parsed) ? 0 : parsed;
}

const profanityList: ReadonlySet<string> = new Set([
  "fuck", "shit", "ass", "bitch", "dick", "cock", "cunt", "piss",
  "slut", "whore", "bastard", "nigger", "fag", "retard", "twat",
]);

export class LeaderboardService {
  private currentWeekKey: string;
  private rateLimitMap = new Map<string, number>();
  private rateLimitMaxPerSecond = 3;

  constructor() {
    this.currentWeekKey = this.getWeekKey();
  }

  public getWeekKey(date?: Date): string {
    const d = date ?? new Date();
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 +
        yearStart.getUTCDay() +
        1) /
        7
    );
    return `${CONFIG.PREFIX}:${d.getUTCFullYear()}-W${week}`;
  }

  public getCurrentWeek(): string {
    return this.currentWeekKey;
  }

  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const windowStart = now - 1000;
    const last = this.rateLimitMap.get(key);
    if (last && last > windowStart) {
      return false;
    }
    this.rateLimitMap.set(key, now);
    return true;
  }

  public validateUsernameFormat(username: string): { valid: boolean; error?: string } {
    const { MIN_LENGTH, MAX_LENGTH, PATTERN } = CONFIG.USERNAME;
    if (!username || typeof username !== "string" || username.trim().length === 0) {
      return { valid: false, error: "Username cannot be empty" };
    }
    const clean = username.trim();
    if (clean.length < MIN_LENGTH) {
      return { valid: false, error: `Username must be at least ${MIN_LENGTH} characters` };
    }
    if (clean.length > MAX_LENGTH) {
      return { valid: false, error: `Username must be at most ${MAX_LENGTH} characters` };
    }
    if (!PATTERN.test(clean)) {
      return { valid: false, error: "Username can only contain letters, numbers, underscores, and hyphens (must start and end with letter/number)" };
    }
    const lower = clean.toLowerCase();
    for (const bad of profanityList) {
      if (lower.includes(bad)) {
        return { valid: false, error: "Username contains inappropriate content" };
      }
    }
    return { valid: true };
  }

  public async checkUsernameAvailability(
    username: string,
    wallet: string
  ): Promise<{ available: boolean; error?: string }> {
    if (!this.checkRateLimit(`check:${wallet}`)) {
      return { available: false, error: "Rate limited. Please wait a moment." };
    }

    const validation = this.validateUsernameFormat(username);
    if (!validation.valid) {
      return { available: false, error: validation.error };
    }

    const clean = username.trim();
    const lower = clean.toLowerCase();

    try {
      const owner = toStr(
        await redis.send("HGET", [CONFIG.KEY_USERNAMES_REVERSE, lower])
      );

      if (owner && owner !== wallet) {
        return { available: false, error: `"${clean}" is already taken` };
      }

      return { available: true };
    } catch (error) {
      console.error("[LeaderboardService] Error checking username availability:", error);
      return { available: false, error: "Server error checking username" };
    }
  }

  public async mergeGuestScores(
    fromWallet: string,
    toWallet: string
  ): Promise<void> {
    if (!fromWallet || !toWallet || fromWallet === toWallet) return;
    if (!fromWallet.startsWith("user_") && !fromWallet.startsWith("guest_")) return;
    if (!this.checkRateLimit(`merge:${toWallet}`)) return;

    try {
      const allWeekKeys = await redis.send("KEYS", [
        `${CONFIG.PREFIX}:*`,
      ]);

      if (!Array.isArray(allWeekKeys)) return;

      let mergedCount = 0;

      for (const key of allWeekKeys) {
        const keyStr = toStr(key);
        if (!keyStr.startsWith(`${CONFIG.PREFIX}:`)) continue;

        const guestScore = toNum(
          await redis.send("ZSCORE", [keyStr, fromWallet])
        );

        if (guestScore > 0) {
          const existing = toNum(
            await redis.send("ZSCORE", [keyStr, toWallet])
          );

          if (guestScore > existing) {
            await redis.send("ZADD", [
              keyStr,
              guestScore.toString(),
              toWallet,
            ]);
            mergedCount++;
          }

          await redis.send("ZREM", [keyStr, fromWallet]);
        }
      }

      const guestUsername = toStr(
        await redis.send("HGET", [CONFIG.KEY_USERNAMES, fromWallet])
      );
      if (guestUsername) {
        const guestLower = guestUsername.toLowerCase();
        const existingUsername = toStr(
          await redis.send("HGET", [CONFIG.KEY_USERNAMES, toWallet])
        );
        if (!existingUsername) {
          await redis.send("HSET", [
            CONFIG.KEY_USERNAMES,
            toWallet,
            guestUsername,
          ]);
          await redis.send("HSET", [
            CONFIG.KEY_USERNAMES_REVERSE,
            guestLower,
            toWallet,
          ]);
        } else {
          await redis.send("HDEL", [
            CONFIG.KEY_USERNAMES_REVERSE,
            guestLower,
          ]);
        }
        await redis.send("HDEL", [CONFIG.KEY_USERNAMES, fromWallet]);
      }

      console.log(
        `[LeaderboardService] Merged ${mergedCount} scores from ${fromWallet} -> ${toWallet}`
      );
    } catch (error) {
      console.error("[LeaderboardService] Error merging guest scores:", error);
    }
  }

  public async getTopScores(
    limit: number = 20,
    week?: string
  ): Promise<LeaderboardEntry[]> {
    const key = week ?? this.currentWeekKey;
    let raw: unknown[] | null = null;
    try {
      raw = (await redis.send("ZREVRANGE", [
        key,
        "0",
        (limit - 1).toString(),
        "WITHSCORES",
      ])) as unknown[] | null;
    } catch (error) {
      console.error(`[LeaderboardService] Error fetching top scores for key ${key}:`, error);
      return [];
    }

    if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

    const wallets: string[] = [];
    const scoreMap = new Map<string, number>();

    for (let i = 0; i < raw.length; i += 2) {
      const walletStr = toStr(raw[i]).trim();
      const scoreNum = toNum(raw[i + 1]);

      if (walletStr.length > 0) {
        wallets.push(walletStr);
        scoreMap.set(walletStr, scoreNum);
      }
    }

    if (wallets.length === 0) return [];

    // Fetch usernames individually (more reliable than HMGET in Bun)
    let usernames: (string | null)[] = [];
    try {
      const results = await Promise.all(
        wallets.map(async (w) => {
          try {
            const val = await redis.send("HGET", [CONFIG.KEY_USERNAMES, w]);
            const str = toStr(val).trim();
            return str.length > 0 ? str : null;
          } catch {
            return null;
          }
        })
      );
      usernames = results;
    } catch (error) {
      console.error("[LeaderboardService] Failed to fetch usernames:", error);
      usernames = new Array(wallets.length).fill(null);
    }

    return wallets.map((wallet, i) => {
      const resolvedUsername = (usernames[i] && usernames[i].length > 0) ? usernames[i] : null;
      return {
        rank: i + 1,
        wallet,
        username: resolvedUsername,
        score: scoreMap.get(wallet) ?? 0,
      };
    });
  }

  public async getRank(wallet: string, week?: string): Promise<number> {
    if (!wallet || typeof wallet !== "string") return 0;
    const targetWeek = week ?? this.currentWeekKey;
    try {
      const res = await redis.send("ZREVRANK", [targetWeek, wallet]);
      if (res === null || res === undefined) return 0;
      const rankNum = typeof res === "number" ? res : parseInt(toStr(res), 10);
      return !isNaN(rankNum) ? rankNum + 1 : 0;
    } catch (error) {
      console.error(`[LeaderboardService] Error fetching rank for wallet ${wallet}:`, error);
      return 0;
    }
  }

  public async submitScore(
    wallet: string,
    score: number,
    username?: string,
    week?: string
  ): Promise<{ finalRank: number; finalScore: number }> {
    if (!wallet || typeof wallet !== "string") {
      return { finalRank: 0, finalScore: score };
    }

    const targetWeek = week ?? this.currentWeekKey;

    let existingScore = 0;
    try {
      const res = await redis.send("ZSCORE", [targetWeek, wallet]);
      existingScore = toNum(res);
    } catch (error) {
      console.error(`[LeaderboardService] Error fetching ZSCORE for wallet ${wallet}:`, error);
      existingScore = 0;
    }

    if (wallet !== "anonymous" && username && typeof username === "string" && username.trim().length > 0) {
      const existingUsername = toStr(
        await redis.send("HGET", [CONFIG.KEY_USERNAMES, wallet])
      );
      if (!existingUsername) {
        const validation = this.validateUsernameFormat(username);
        if (validation.valid) {
          try {
            const clean = username.trim();
            const lower = clean.toLowerCase();
            const existingOwner = toStr(
              await redis.send("HGET", [CONFIG.KEY_USERNAMES_REVERSE, lower])
            );
            if (!existingOwner || existingOwner === wallet) {
              await redis.send("HSET", [CONFIG.KEY_USERNAMES, wallet, clean]);
              await redis.send("HSET", [CONFIG.KEY_USERNAMES_REVERSE, lower, wallet]);
            }
          } catch (error) {
            console.error(`[LeaderboardService] Error setting username for wallet ${wallet}:`, error);
          }
        }
      }
    }

    if (score > existingScore) {
      try {
        await redis.send("ZADD", [targetWeek, score.toString(), wallet]);
        await redis.send("EXPIRE", [targetWeek, CONFIG.WEEK_TTL.toString()]);
      } catch (error) {
        console.error(`[LeaderboardService] Critical Redis error saving score for wallet ${wallet}:`, error);
        throw error;
      }
    }

    const finalRank = await this.getRank(wallet, targetWeek);
    const finalScore = Math.max(score, existingScore);

    return { finalRank, finalScore };
  }

  public async updateUsername(
    wallet: string,
    username: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!wallet || typeof wallet !== "string" || wallet === "anonymous") {
      return { success: false, error: "Invalid wallet" };
    }

    const validation = this.validateUsernameFormat(username);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    if (!this.checkRateLimit(`update:${wallet}`)) {
      return { success: false, error: "Rate limited. Please wait a moment." };
    }

    const clean = username.trim();
    const lower = clean.toLowerCase();

    try {
      const existingOwner = toStr(
        await redis.send("HGET", [CONFIG.KEY_USERNAMES_REVERSE, lower])
      );

      if (existingOwner && existingOwner !== wallet) {
        return { success: false, error: `"${clean}" is already taken by another pilot` };
      }

      const currentUsername = toStr(
        await redis.send("HGET", [CONFIG.KEY_USERNAMES, wallet])
      );
      if (currentUsername) {
        const currentLower = currentUsername.toLowerCase();
        if (currentLower !== lower) {
          await redis.send("HDEL", [
            CONFIG.KEY_USERNAMES_REVERSE,
            currentLower,
          ]);
        }
      }

      const hsetRes = await redis.send("HSET", [CONFIG.KEY_USERNAMES, wallet, clean]);
      await redis.send("HSET", [CONFIG.KEY_USERNAMES_REVERSE, lower, wallet]);

      // Verify the write persisted
      const verifyVal = toStr(await redis.send("HGET", [CONFIG.KEY_USERNAMES, wallet]));
      console.log(`[LeaderboardService] Updated username for wallet ${wallet} -> "${clean}" | key=${CONFIG.KEY_USERNAMES} reverse=${CONFIG.KEY_USERNAMES_REVERSE} | HSET returned=${JSON.stringify(hsetRes)} | HGET verify="${verifyVal}"`);

      if (verifyVal !== clean) {
        console.error(`[LeaderboardService] CRITICAL: HGET verification failed! Expected "${clean}" got "${verifyVal}"`);
      }
      return { success: true };
    } catch (error) {
      console.error(`[LeaderboardService] Error updating username for wallet ${wallet}:`, error);
      return { success: false, error: "Server error" };
    }
  }

  public checkWeekChange(): boolean {
    const newWeek = this.getWeekKey();
    if (newWeek !== this.currentWeekKey) {
      this.currentWeekKey = newWeek;
      return true;
    }
    return false;
  }
}

export const leaderboardService = new LeaderboardService();
