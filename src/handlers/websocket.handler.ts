import { CONFIG } from "../config";
import type { AppWebSocket, AppServer } from "../types";
import {
  decodeClientMessage,
  encodeServerMessage,
  ClientMessageType,
  ServerMessageType,
  type ServerMessagePayload,
} from "../protocol/protoCodec";
import { sessionService } from "../services/session.service";
import { leaderboardService } from "../services/leaderboard.service";

export function sendBinary(ws: AppWebSocket, msg: ServerMessagePayload): void {
  const bytes = encodeServerMessage(msg);
  ws.send(bytes);
}

export function broadcastBinary(server: AppServer, msg: ServerMessagePayload): void {
  const bytes = encodeServerMessage(msg);
  server.publish(CONFIG.TOPIC, bytes);
}

export async function broadcastTopLeaderboard(server: AppServer): Promise<void> {
  try {
    const leaderboard = await leaderboardService.getTopScores(20);
    broadcastBinary(server, {
      type: ServerMessageType.LEADERBOARD,
      week: leaderboardService.getCurrentWeek(),
      entries: leaderboard,
    });
  } catch (error) {
    console.error("[WebSocketHandler] Failed to broadcast top leaderboard:", error);
  }
}

export function createWebSocketHandler(serverGetter: () => AppServer) {
  return {
    async open(ws: AppWebSocket) {
      try {
        ws.subscribe(CONFIG.TOPIC);
        const topScores = await leaderboardService.getTopScores(20);
        sendBinary(ws, {
          type: ServerMessageType.LEADERBOARD,
          week: leaderboardService.getCurrentWeek(),
          entries: topScores,
        });
      } catch (error) {
        console.error("[WebSocketHandler] Error handling socket open:", error);
      }
    },

    async message(ws: AppWebSocket, raw: string | Buffer | Uint8Array) {
      try {
        const buffer =
          typeof raw === "string"
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw);

        const msg = decodeClientMessage(buffer);
        if (!msg) {
          return sendBinary(ws, {
            type: ServerMessageType.ERROR,
            message: "Invalid Protobuf packet",
          });
        }

        switch (msg.type) {
          case ClientMessageType.START_SESSION: {
            const session = sessionService.startSession(msg.wallet, msg.username);
            sendBinary(ws, {
              type: ServerMessageType.SESSION_STARTED,
              sessionId: session.sessionId,
            });
            break;
          }

          case ClientMessageType.GAME_TICK: {
            sessionService.processGameTick(msg.sessionId, msg.score);
            break;
          }

          case ClientMessageType.SUBMIT_SCORE: {
            const validation = sessionService.validateScoreSubmission(
              msg.sessionId,
              msg.wallet,
              msg.score
            );

            if (!validation.valid || !validation.wallet) {
              sendBinary(ws, {
                type: ServerMessageType.SCORE_SUBMITTED,
                score: msg.score,
                rank: 0,
                valid: false,
              });
              break;
            }

            const { finalRank, finalScore } = await leaderboardService.submitScore(
              validation.wallet,
              msg.score,
              msg.username
            );

            sendBinary(ws, {
              type: ServerMessageType.SCORE_SUBMITTED,
              score: finalScore,
              rank: finalRank,
              valid: true,
            });

            await broadcastTopLeaderboard(serverGetter());
            break;
          }

          case ClientMessageType.GET_LEADERBOARD: {
            const entries = await leaderboardService.getTopScores(
              msg.limit || 20,
              msg.week
            );
            sendBinary(ws, {
              type: ServerMessageType.LEADERBOARD,
              week: msg.week ?? leaderboardService.getCurrentWeek(),
              entries,
            });
            break;
          }
        }
      } catch (error) {
        console.error("[WebSocketHandler] Error processing message packet:", error);
        sendBinary(ws, {
          type: ServerMessageType.ERROR,
          message: "Internal server processing error",
        });
      }
    },

    close(ws: AppWebSocket) {
      try {
        ws.unsubscribe(CONFIG.TOPIC);
      } catch (error) {
        console.error("[WebSocketHandler] Error closing socket:", error);
      }
    },
  };
}
