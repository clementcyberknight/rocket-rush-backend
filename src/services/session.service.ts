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
    console.log(`[SessionStart] Created session ${sessionId} for wallet: ${wallet} (${username || 'no-username'})`);
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
    if (!session) {
      console.warn(`[AntiCheat] Telemetry tick received for unknown/expired session: ${sessionId}`);
      return false;
    }

    const now = Date.now();
    const deltaTime = Math.max(
      (now - session.lastTickTime) / 1000,
      CONFIG.ANTI_CHEAT.MIN_TICK_DELTA_TIME
    );
    const deltaScore = score - session.lastScore;
    const scoreRate = deltaScore / deltaTime;

    const rateExceeded = scoreRate > CONFIG.ANTI_CHEAT.MAX_SCORE_RATE;
    const negativeScoreDelta = deltaScore < CONFIG.ANTI_CHEAT.MIN_DELTA_SCORE;

    if (rateExceeded || negativeScoreDelta) {
      session.flagged = true;
      console.warn(
        `[AntiCheat Flag] Session ${sessionId} FLAGGED! score=${score.toFixed(1)}, deltaScore=${deltaScore.toFixed(1)}, rate=${scoreRate.toFixed(1)} pts/s (Max allowed: ${CONFIG.ANTI_CHEAT.MAX_SCORE_RATE} pts/s)`
      );
    } else {
      console.log(
        `[AntiCheat Tick] Session ${sessionId} (#${session.tickCount + 1}): score=${score.toFixed(1)}, rate=${scoreRate.toFixed(1)} pts/s -> OK`
      );
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
      console.warn(`[ScoreValidation] Rejected submission for session ${sessionId}: No wallet address provided`);
      return { valid: false };
    }

    const now = Date.now();
    const duration = session ? (now - session.startTime) / 1000 : 0;
    const maxPlausibleScore =
      duration * CONFIG.ANTI_CHEAT.MAX_PLAUSIBLE_SCORE_PER_SEC +
      CONFIG.ANTI_CHEAT.MAX_PLAUSIBLE_SCORE_BASE;

    let isCheating = false;
    let reason = "";

    if (session) {
      if (session.flagged) {
        isCheating = true;
        reason = "Session was flagged during telemetry ticks (speed/score rate violation)";
      } else if (duration > 2.0 && session.tickCount === 0) {
        isCheating = true;
        reason = `No telemetry ticks received during ${duration.toFixed(1)}s game session`;
      } else if (submittedScore > maxPlausibleScore) {
        isCheating = true;
        reason = `Submitted score ${submittedScore.toFixed(1)} exceeds maximum plausible score ${maxPlausibleScore.toFixed(1)} for duration ${duration.toFixed(1)}s`;
      }
      this.activeSessions.delete(sessionId);
    }

    if (isCheating) {
      console.warn(`[ScoreValidation] REJECTED score ${submittedScore.toFixed(1)} for wallet ${wallet} (${sessionId}). Reason: ${reason}`);
    } else {
      console.log(`[ScoreValidation] PASSED score ${submittedScore.toFixed(1)} for wallet ${wallet} (${sessionId}). Duration: ${duration.toFixed(1)}s, Ticks: ${session?.tickCount ?? 0}`);
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
