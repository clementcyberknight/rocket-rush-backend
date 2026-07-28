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

  public clearAll(): void {
    this.activeSessions.clear();
  }
}

export const sessionService = new SessionService();
