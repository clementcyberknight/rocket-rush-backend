import { CONFIG } from "../config"
import type { AppWebSocket, AppServer, LeaderboardEntry } from "../types"
import {
  decodeClientMessage,
  encodeServerMessage,
  ClientMessageType,
  ServerMessageType,
  type ServerMessagePayload,
} from "../protocol/protoCodec"
import { userService, generateRushId } from "../services/user.service"
import { usernameService } from "../services/username.service"
import { leaderboardService } from "../services/leaderboard.service"
import { sessionService } from "../services/session.service"

export function sendBinary(ws: AppWebSocket, msg: ServerMessagePayload): void {
  const bytes = encodeServerMessage(msg)
  ws.send(bytes)
}

function broadcastBinary(server: AppServer, msg: ServerMessagePayload): void {
  const bytes = encodeServerMessage(msg)
  server.publish(CONFIG.TOPIC_LEADERBOARD, bytes)
}

export async function broadcastTopLeaderboard(server: AppServer): Promise<void> {
  try {
    const leaderboard = await leaderboardService.getTopScores(20)
    broadcastBinary(server, {
      type: ServerMessageType.LEADERBOARD,
      week: leaderboardService.getCurrentWeek(),
      entries: leaderboard.map(entryToServerEntry),
    })
  } catch (error) {
    console.error("[WS] Failed to broadcast leaderboard:", error)
  }
}

function entryToServerEntry(e: LeaderboardEntry): {
  rank: number
  wallet: string
  username: string | null
  score: number
} {
  return {
    rank: e.rank,
    wallet: e.uid,
    username: e.username,
    score: e.score,
  }
}

export function createWebSocketHandler(serverGetter: () => AppServer) {
  return {
    async open(ws: AppWebSocket) {
      try {
        ws.subscribe(CONFIG.TOPIC_LEADERBOARD)
        const topScores = await leaderboardService.getTopScores(20)
        sendBinary(ws, {
          type: ServerMessageType.LEADERBOARD,
          week: leaderboardService.getCurrentWeek(),
          entries: topScores.map(entryToServerEntry),
        })
      } catch (error) {
        console.error("[WS] Error handling socket open:", error)
      }
    },

    async message(ws: AppWebSocket, raw: string | Buffer | Uint8Array) {
      try {
        const buffer =
          typeof raw === "string"
            ? new TextEncoder().encode(raw)
            : new Uint8Array(raw)

        const msg = decodeClientMessage(buffer)
        if (!msg) {
          return sendBinary(ws, {
            type: ServerMessageType.ERROR,
            message: "Invalid Protobuf packet",
          })
        }

        switch (msg.type) {
          case ClientMessageType.START_SESSION: {
            const rawIdentity = (msg.wallet || "").trim()
            let identity = rawIdentity

            if (!identity || identity.length === 0) {
              identity = generateRushId()
            } else if (identity.includes("@")) {
              identity = identity.toLowerCase()
            }

            const user = await userService.resolveUser(identity)
            ws.data.uid = user.uid

            const ghost = await leaderboardService.getGhostBlob(user.uid)

            const session = await sessionService.createSession(user.uid)
            sendBinary(ws, {
              type: ServerMessageType.SESSION_STARTED,
              sessionId: session.sessionId,
              uid: user.uid,
              ghost: ghost ?? undefined,
            })
            break
          }

          case ClientMessageType.GAME_TICK: {
            if (!msg.sessionId) break
            await sessionService.processTick(
              msg.sessionId,
              Math.max(0, msg.score || 0),
              Math.max(0, msg.speed || 0),
              Math.max(0, msg.level || 0),
              msg.timestamp || Date.now(),
              msg.x || 0,
              msg.y || 0,
              msg.z || 0
            )
            break
          }

          case ClientMessageType.SUBMIT_SCORE: {
            const rawIdentity = (msg.wallet || "").trim()
            const isEmail = rawIdentity.includes("@")
            let identity = rawIdentity
            if (!identity || identity.length === 0) {
              identity = generateRushId()
            }

            const user = await userService.resolveUser(identity)
            ws.data.uid = user.uid
            const score = Math.max(0, msg.score || 0)

            let desiredUsername = msg.username
            if (!desiredUsername && isEmail) {
              desiredUsername = rawIdentity.split("@")[0]
            }

            if (desiredUsername && desiredUsername.trim().length > 0 && !user.username) {
              const unameValid = userService.validateUsernameFormat(desiredUsername)
              if (unameValid.valid) {
                await usernameService.setUsername(user.uid, desiredUsername.trim())
              }
            }

            const validation = await sessionService.validateScore(
              msg.sessionId || "",
              user.uid,
              score
            )

            if (!validation.valid) {
              console.log(`[Score REJECTED] uid=${user.uid} reason=${validation.reason}`)
              sendBinary(ws, {
                type: ServerMessageType.SCORE_SUBMITTED,
                score: 0,
                rank: 0,
                valid: false,
              })
              sendBinary(ws, {
                type: ServerMessageType.ERROR,
                message: validation.reason ?? "Score rejected",
              })
              break
            }

            const entry = await leaderboardService.submitScore(user.uid, score, msg.sessionId)

            if (entry) {
              sendBinary(ws, {
                type: ServerMessageType.SCORE_SUBMITTED,
                score: entry.score,
                rank: entry.rank,
                valid: true,
              })

              const fresh = await leaderboardService.getTopScores(20)
              const entries = fresh.map(entryToServerEntry)

              sendBinary(ws, {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
              broadcastBinary(serverGetter(), {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
            }

            await sessionService.endSession(msg.sessionId || "")
            break
          }

          case ClientMessageType.GET_LEADERBOARD: {
            const entries = await leaderboardService.getTopScores(
              msg.limit || 20,
              msg.week
            )
            sendBinary(ws, {
              type: ServerMessageType.LEADERBOARD,
              week: msg.week ?? leaderboardService.getCurrentWeek(),
              entries: entries.map(entryToServerEntry),
            })
            break
          }

          case ClientMessageType.UPDATE_USERNAME: {
            const rawIdentity = (msg.wallet || "").trim()
            if (!rawIdentity || !msg.username) break

            const user = await userService.resolveUser(rawIdentity)

            const result = await usernameService.setUsername(user.uid, msg.username)
            sendBinary(ws, {
              type: ServerMessageType.USERNAME_UPDATED,
              success: result.success,
              message: result.success ? "Callsign updated!" : (result.error || "Update failed"),
              username: result.success ? msg.username.trim() : undefined,
            })

            if (result.success) {
              leaderboardService.invalidateCache()
              const fresh = await leaderboardService.getTopScores(20)
              const entries = fresh.map(entryToServerEntry)
              sendBinary(ws, {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
              broadcastBinary(serverGetter(), {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
            }
            break
          }

          case ClientMessageType.MERGE_GUEST: {
            const fromIdentity = (msg.fromWallet || "").trim()
            const toIdentity = (msg.toWallet || "").trim()
            if (!fromIdentity || !toIdentity) break

            const fromUser = await userService.getUserByIdentity(fromIdentity)
            const toUser = await userService.getUserByIdentity(toIdentity)

            if (fromUser && toUser) {
              await leaderboardService.mergeGuestToWallet(fromUser.uid, toUser.uid)
              leaderboardService.invalidateCache()

              const fresh = await leaderboardService.getTopScores(20)
              const entries = fresh.map(entryToServerEntry)
              sendBinary(ws, {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
              broadcastBinary(serverGetter(), {
                type: ServerMessageType.LEADERBOARD,
                week: leaderboardService.getCurrentWeek(),
                entries,
              })
            }
            break
          }

          case ClientMessageType.CHECK_USERNAME: {
            if (!msg.username) break

            let user = ws.data.uid ? await userService.getUser(ws.data.uid) : null
            if (!user && msg.wallet) {
              user = await userService.resolveUser((msg.wallet || "").trim())
              ws.data.uid = user.uid
            }

            const uid = user?.uid || ""
            const result = await usernameService.checkAvailability(msg.username, uid)
            sendBinary(ws, {
              type: ServerMessageType.USERNAME_CHECKED,
              available: result.available,
              error: result.error,
            })
            break
          }
        }
      } catch (error) {
        console.error("[WS] Error processing message:", error)
        sendBinary(ws, {
          type: ServerMessageType.ERROR,
          message: "Internal server error",
        })
      }
    },

    close(ws: AppWebSocket) {
      try {
        ws.unsubscribe(CONFIG.TOPIC_LEADERBOARD)
      } catch (error) {
        console.error("[WS] Error closing socket:", error)
      }
    },
  }
}
