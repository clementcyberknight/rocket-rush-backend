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
      lastTickScore: 0,
      lastTickSpeed: 0,
      lastTickLevel: 0,
      tickCount: 0,
      flagged: false,
    };
    this.activeSessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  public processTick(
    sessionId: string,
    score: number,
    speed: number,
    level: number,
    timestamp: number
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.flagged) return;

    const { ANTI_CHEAT: AC } = CONFIG;
    const now = Date.now();
    const deltaTime = (timestamp - session.lastTickTime) / 1000;

    if (session.tickCount > 0 && deltaTime > 0) {
      if (deltaTime > AC.TICK_INTERVAL_MAX) return;

      if (Math.abs(timestamp - now) > AC.CLOCK_DRIFT_MS) {
        session.flagged = true;
        return;
      }

      if (score < session.lastTickScore - AC.SCORE_MONOTONIC_GRACE) {
        session.flagged = true;
        return;
      }

      if (level < session.lastTickLevel) {
        session.flagged = true;
        return;
      }

      if (speed < session.lastTickSpeed - 0.02) {
        session.flagged = true;
        return;
      }

      const speedAccel = (speed - session.lastTickSpeed) / deltaTime;
      if (speedAccel > AC.SPEED_ACCEL_MAX) {
        session.flagged = true;
        return;
      }

      const maxSpeedAtLevel = AC.SPEED_BASE + level * AC.SPEED_PER_LEVEL + AC.SPEED_GRACE;
      if (speed > maxSpeedAtLevel) {
        session.flagged = true;
        return;
      }

      const expectedLevel = Math.floor(score / AC.SCORE_UNITS_PER_LEVEL);
      if (Math.abs(level - expectedLevel) > AC.LEVEL_TOLERANCE) {
        session.flagged = true;
        return;
      }
    }

    session.lastTickScore = score;
    session.lastTickSpeed = speed;
    session.lastTickLevel = level;
    session.lastTickTime = timestamp;
    session.tickCount++;
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

    if (score <= 0) {
      return { valid: false, reason: "Score must be positive" };
    }

    const { ANTI_CHEAT: AC } = CONFIG;

    if (session.tickCount >= AC.MIN_TICK_COUNT) {
      const now = Date.now();
      const timeSinceLastTick = (now - session.lastTickTime) / 1000;

      if (timeSinceLastTick <= AC.TICK_INTERVAL_MAX) {
        if (score < session.lastTickScore - AC.SCORE_MONOTONIC_GRACE) {
          session.flagged = true;
          return { valid: false, reason: "Score cannot decrease" };
        }

        const maxSpeedAtLevel = AC.SPEED_BASE + session.lastTickLevel * AC.SPEED_PER_LEVEL + AC.SPEED_GRACE;
        const maxPossibleIncrease = maxSpeedAtLevel * AC.SCORE_PER_UNIT_SPEED * Math.max(timeSinceLastTick, 0.5) * AC.SCORE_TOLERANCE;

        if (score - session.lastTickScore > maxPossibleIncrease) {
          session.flagged = true;
          return { valid: false, reason: "Score increase exceeds plausible maximum" };
        }

        const expectedLevel = Math.floor(score / AC.SCORE_UNITS_PER_LEVEL);
        if (Math.abs(session.lastTickLevel - expectedLevel) > AC.LEVEL_TOLERANCE) {
          session.flagged = true;
          return { valid: false, reason: "Level mismatch with score" };
        }
      }
    }

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
