import { redis } from "bun";
import { CONFIG } from "../config";
import type { LeaderboardEntry } from "../types";

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
    let raw: string[] | null = null;
    try {
      raw = (await redis.send("ZREVRANGE", [
        key,
        "0",
        (limit - 1).toString(),
        "WITHSCORES",
      ])) as string[] | null;
    } catch (error) {
      console.error(`[LeaderboardService] Error fetching top scores for key ${key}:`, error);
      throw error;
    }

    if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

    const wallets: string[] = [];
    const scoreMap = new Map<string, number>();
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i];
      const scoreStr = raw[i + 1];
      if (typeof wallet === "string" && wallet.trim().length > 0) {
        const score = scoreStr ? parseFloat(scoreStr) : 0;
        wallets.push(wallet);
        scoreMap.set(wallet, score);
      }
    }

    if (wallets.length === 0) return [];

    let usernames: (string | null)[] = [];
    try {
      const res = (await redis.send("HMGET", [
        CONFIG.KEY_USERNAMES,
        ...wallets,
      ])) as (string | null)[];
      usernames = Array.isArray(res) ? res : new Array(wallets.length).fill(null);
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
      const rank = (await redis.send("ZREVRANK", [
        targetWeek,
        wallet,
      ])) as number | null;
      return rank !== null && rank !== undefined ? rank + 1 : 0;
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
      const currentScoreStr = (await redis.send("ZSCORE", [
        targetWeek,
        wallet,
      ])) as string | null;
      existingScore = currentScoreStr ? parseFloat(currentScoreStr) : 0;
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
