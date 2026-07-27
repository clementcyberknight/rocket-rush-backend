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

export class LeaderboardService {
  private currentWeekKey: string;

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
      throw error;
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

    let usernames: (string | null)[] = [];
    try {
      const res = (await redis.send("HMGET", [
        CONFIG.KEY_USERNAMES,
        ...wallets,
      ])) as unknown[] | null;

      usernames = Array.isArray(res)
        ? res.map(u => {
            const str = toStr(u).trim();
            return str.length > 0 ? str : null;
          })
        : new Array(wallets.length).fill(null);
    } catch (error) {
      console.error("[LeaderboardService] Failed to fetch usernames via HMGET:", error);
      usernames = new Array(wallets.length).fill(null);
    }

    return wallets.map((wallet, i) => ({
      rank: i + 1,
      wallet,
      username: usernames[i] ?? null,
      score: scoreMap.get(wallet) ?? 0,
    }));
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

    if (username && typeof username === "string") {
      try {
        await redis.send("HSET", [CONFIG.KEY_USERNAMES, wallet, username]);
      } catch (error) {
        console.error(`[LeaderboardService] Error setting username for wallet ${wallet}:`, error);
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
