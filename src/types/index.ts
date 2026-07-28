import type { Server, ServerWebSocket } from "bun"

export type IdentityKind = "wallet" | "rush"

export interface UserRecord {
  uid: string
  username: string | null
  identityKind: IdentityKind
  identity: string
  createdAt: number
  updatedAt: number
  lastSeen: number
  highScore: number
  totalGames: number
}

export interface LeaderboardEntry {
  rank: number
  uid: string
  username: string | null
  score: number
}

export interface GameSession {
  sessionId: string
  uid: string
  startTime: number
  lastTickScore: number
  lastTickSpeed: number
  lastTickLevel: number
  lastTickTime: number
  tickCount: number
  flagged: boolean
}

export interface WebSocketData {
  uid?: string
}

export type AppWebSocket = ServerWebSocket<WebSocketData>
export type AppServer = Server<WebSocketData>
