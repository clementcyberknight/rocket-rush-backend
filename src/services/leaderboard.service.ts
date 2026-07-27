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
    limit: number = 10,
    week?: string
  ): Promise<LeaderboardEntry[]> {
    const key = week ?? this.currentWeekKey;
    const raw = (await redis.send("ZREVRANGE", [
      key,
      "0",
      (limit - 1).toString(),
      "WITHSCORES",
    ])) as string[] | null;

    if (!raw || raw.length === 0) return [];

    const wallets: string[] = [];
    const scoreMap = new Map<string, number>();
    for (let i = 0; i < raw.length; i += 2) {
      const wallet = raw[i]!;
      const score = parseFloat(raw[i + 1]!);
      wallets.push(wallet);
      scoreMap.set(wallet, score);
    }

    const usernames = (await redis.send("HMGET", [
      CONFIG.KEY_USERNAMES,
      ...wallets,
    ])) as (string | null)[];

    return wallets.map((wallet, i) => ({
      rank: i + 1,
      wallet,
      username: usernames[i] ?? null,
      score: scoreMap.get(wallet)!,
    }));
  }

  public async getRank(wallet: string, week?: string): Promise<number> {
    const targetWeek = week ?? this.currentWeekKey;
    const rank = (await redis.send("ZREVRANK", [
      targetWeek,
      wallet,
    ])) as number | null;
    return rank !== null ? rank + 1 : 0;
  }

  public async submitScore(
    wallet: string,
    score: number,
    username?: string,
    week?: string
  ): Promise<{ finalRank: number; finalScore: number }> {
    const targetWeek = week ?? this.currentWeekKey;

    const currentScoreStr = (await redis.send("ZSCORE", [
      targetWeek,
      wallet,
    ])) as string | null;

    const existingScore = currentScoreStr ? parseFloat(currentScoreStr) : 0;

    if (username) {
      await redis.send("HSET", [CONFIG.KEY_USERNAMES, wallet, username]);
    }

    if (score > existingScore) {
      await redis.send("ZADD", [targetWeek, score.toString(), wallet]);
      await redis.send("EXPIRE", [targetWeek, CONFIG.WEEK_TTL.toString()]);
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
