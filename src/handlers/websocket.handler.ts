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

function generateRandomId(): string {
  return "user_" + Math.random().toString(36).substring(2, 10) + "_" + Date.now().toString(36);
}

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
    console.log(`[LeaderboardBroadcast] Broadcasting top ${leaderboard.length} entries to all clients`);
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
        console.log(`[WebSocketConnect] Client connected. Sending ${topScores.length} top leaderboard entries`);
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
            break;
          }

          case ClientMessageType.SUBMIT_SCORE: {
            const rawWallet = msg.wallet ? msg.wallet.trim() : "";
            const isEmail = rawWallet.includes("@");
            const wallet = rawWallet.length > 0 ? rawWallet : generateRandomId();
            const score = Math.max(0, msg.score || 0);

            let username = msg.username;
            if (!username && isEmail) {
              username = rawWallet.split("@")[0];
            }

            const sessionValidation = sessionService.validateScoreSubmission(
              msg.sessionId,
              wallet,
              score
            );
            const valid = sessionValidation.valid;

            console.log(`[ScoreSubmit] Wallet: ${wallet}, Score: ${score}, Username: "${username || ""}", Valid: ${valid}`);

            if (!valid) {
              sendBinary(ws, {
                type: ServerMessageType.SCORE_SUBMITTED,
                score: 0,
                rank: 0,
                valid: false,
              });
              sendBinary(ws, {
                type: ServerMessageType.ERROR,
                message: "Score rejected by anti-cheat validation",
              });
              break;
            }

            const { finalRank, finalScore } = await leaderboardService.submitScore(
              wallet,
              score,
              username
            );

            console.log(`[ScoreSubmit SUCCESS] Wallet: ${wallet}, Submitted: ${score}, FinalScore: ${finalScore}, Rank: #${finalRank}`);

            sendBinary(ws, {
              type: ServerMessageType.SCORE_SUBMITTED,
              score: finalScore,
              rank: finalRank,
              valid: true,
            });

            const freshLeaderboard = await leaderboardService.getTopScores(20);

            sendBinary(ws, {
              type: ServerMessageType.LEADERBOARD,
              week: leaderboardService.getCurrentWeek(),
              entries: freshLeaderboard,
            });

            broadcastBinary(serverGetter(), {
              type: ServerMessageType.LEADERBOARD,
              week: leaderboardService.getCurrentWeek(),
              entries: freshLeaderboard,
            });
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

          case ClientMessageType.UPDATE_USERNAME: {
            if (!msg.wallet || !msg.username) break;
            console.log(`[UsernameUpdate] Wallet ${msg.wallet} updating username to "${msg.username}"`);
            const result = await leaderboardService.updateUsername(msg.wallet, msg.username);

            sendBinary(ws, {
              type: ServerMessageType.USERNAME_UPDATED,
              success: result.success,
              message: result.success ? "Callsign updated!" : (result.error || "Update failed"),
            });

            if (result.success) {
              const freshLeaderboard = await leaderboardService.getTopScores(20);
              sendBinary(ws, {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries: freshLeaderboard,
              });
              broadcastBinary(serverGetter(), {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries: freshLeaderboard,
              });
            }
            break;
          }

          case ClientMessageType.MERGE_GUEST: {
            if (!msg.fromWallet || !msg.toWallet) break;
            console.log(`[MergeGuest] Merging ${msg.fromWallet} -> ${msg.toWallet}`);
            await leaderboardService.mergeGuestScores(msg.fromWallet, msg.toWallet);

            const freshLeaderboard = await leaderboardService.getTopScores(20);
            sendBinary(ws, {
              type: ServerMessageType.LEADERBOARD,
              week: leaderboardService.getCurrentWeek(),
              entries: freshLeaderboard,
            });
            broadcastBinary(serverGetter(), {
              type: ServerMessageType.LEADERBOARD,
              week: leaderboardService.getCurrentWeek(),
              entries: freshLeaderboard,
            });
            break;
          }

          case ClientMessageType.CHECK_USERNAME: {
            if (!msg.username || !msg.wallet) break;
            const result = await leaderboardService.checkUsernameAvailability(
              msg.username,
              msg.wallet
            );
            sendBinary(ws, {
              type: ServerMessageType.USERNAME_CHECKED,
              available: result.available,
              error: result.error,
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
