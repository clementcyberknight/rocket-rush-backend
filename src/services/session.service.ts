import { CONFIG } from "../config";
import type { ActiveSession } from "../types";

export class SessionService {
  private activeSessions = new Map<string, ActiveSession>();

  public startSession(wallet: string, username?: string): ActiveSession {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();
    const session: ActiveSession = {
      sessionId,
      wallet,
      username,
      startTime: now,
      lastTickTime: now,
      lastScore: 0,
      tickCount: 0,
      flagged: false,
    };
    this.activeSessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  public deleteSession(sessionId: string): boolean {
    return this.activeSessions.delete(sessionId);
  }

  public processGameTick(sessionId: string, score: number): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;

    const now = Date.now();
    const deltaTime = Math.max(
      (now - session.lastTickTime) / 1000,
      CONFIG.ANTI_CHEAT.MIN_TICK_DELTA_TIME
    );
    const deltaScore = score - session.lastScore;
    const scoreRate = deltaScore / deltaTime;

    if (
      deltaScore < CONFIG.ANTI_CHEAT.MIN_DELTA_SCORE ||
      scoreRate > CONFIG.ANTI_CHEAT.MAX_SCORE_RATE
    ) {
      session.flagged = true;
    }

    session.lastScore = score;
    session.lastTickTime = now;
    session.tickCount++;
    return true;
  }

  public validateScoreSubmission(
    sessionId: string,
    submittedWallet?: string,
    submittedScore: number = 0
  ): { valid: boolean; wallet?: string } {
    const session = this.activeSessions.get(sessionId);
    const wallet = submittedWallet || session?.wallet;

    if (!wallet) {
      return { valid: false };
    }

    const now = Date.now();
    const duration = session ? (now - session.startTime) / 1000 : 0;
    const maxPlausibleScore =
      duration * CONFIG.ANTI_CHEAT.MAX_PLAUSIBLE_SCORE_PER_SEC +
      CONFIG.ANTI_CHEAT.MAX_PLAUSIBLE_SCORE_BASE;

    let isCheating = false;
    if (session) {
      if (
        session.flagged ||
        session.tickCount === 0 ||
        submittedScore > maxPlausibleScore
      ) {
        isCheating = true;
      }
      this.activeSessions.delete(sessionId);
    }

    return {
      valid: !isCheating,
      wallet,
    };
  }

  public clearAll(): void {
    this.activeSessions.clear();
  }
}

export const sessionService = new SessionService();
