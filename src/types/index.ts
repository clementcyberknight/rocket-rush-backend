import type { Server, ServerWebSocket } from "bun";

export interface ActiveSession {
  sessionId: string;
  wallet: string;
  username?: string;
  startTime: number;
  lastTickTime: number;
  lastScore: number;
  tickCount: number;
  flagged: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  username: string | null;
  score: number;
}

export interface WebSocketData {
  subscribedAt?: number;
}

export type AppWebSocket = ServerWebSocket<WebSocketData>;
export type AppServer = Server<WebSocketData>;

export interface ScoreSubmissionResult {
  score: number;
  rank: number;
  valid: boolean;
}
