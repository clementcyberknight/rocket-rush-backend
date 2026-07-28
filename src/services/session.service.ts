import type { ActiveSession } from "../types";
import { CONFIG } from "../config";

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

  public validateScoreSubmission(
    sessionId: string,
    wallet: string,
    score: number
  ): { valid: boolean; reason?: string } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return { valid: false, reason: "Session not found" };
    }

    if (session.flagged) {
      return { valid: false, reason: "Session flagged" };
    }

    if (session.wallet !== wallet) {
      session.flagged = true;
      return { valid: false, reason: "Wallet mismatch" };
    }

    const { ANTI_CHEAT: AC } = CONFIG;

    if (score > AC.MAX_SCORE_RATE) {
      session.flagged = true;
      return { valid: false, reason: `Score exceeds maximum (${score} > ${AC.MAX_SCORE_RATE})` };
    }

    const deltaScore = score - session.lastScore;
    if (deltaScore < AC.MIN_DELTA_SCORE) {
      session.flagged = true;
      return { valid: false, reason: `Negative score delta (${deltaScore} < ${AC.MIN_DELTA_SCORE})` };
    }

    const deltaTime = (Date.now() - session.lastTickTime) / 1000;
    if (deltaTime < AC.MIN_TICK_DELTA_TIME && deltaScore > 0) {
      session.flagged = true;
      return { valid: false, reason: `Tick too fast (${deltaTime.toFixed(3)}s < ${AC.MIN_TICK_DELTA_TIME}s)` };
    }

    const scorePerSec = deltaTime > 0 ? deltaScore / deltaTime : 0;
    if (scorePerSec > AC.MAX_PLAUSIBLE_SCORE_PER_SEC && session.tickCount > 5) {
      session.flagged = true;
      return { valid: false, reason: `Implausible score rate (${Math.round(scorePerSec)}/s > ${AC.MAX_PLAUSIBLE_SCORE_PER_SEC}/s)` };
    }

    if (score > AC.MAX_PLAUSIBLE_SCORE_BASE && deltaTime < 1 && deltaScore > AC.MAX_PLAUSIBLE_SCORE_BASE / 2) {
      session.flagged = true;
      return { valid: false, reason: `Suspicious score jump (${score} > ${AC.MAX_PLAUSIBLE_SCORE_BASE})` };
    }

    session.lastScore = score;
    session.lastTickTime = Date.now();
    session.tickCount++;

    return { valid: true };
  }

  public deleteSession(sessionId: string): boolean {
    return this.activeSessions.delete(sessionId);
  }

  public clearAll(): void {
    this.activeSessions.clear();
  }
}

export const sessionService = new SessionService();
