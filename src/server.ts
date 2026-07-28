import { CONFIG } from "./config"
import type { AppServer, WebSocketData } from "./types"
import { handleHttpRequest } from "./handlers/http.handler"
import { createWebSocketHandler, broadcastTopLeaderboard } from "./handlers/ws.handler"
import { leaderboardService } from "./services/leaderboard.service"

let server: AppServer

export function startServer(): AppServer {
  server = Bun.serve<WebSocketData>({
    port: CONFIG.PORT,
    fetch(req, srv) {
      return handleHttpRequest(req, srv)
    },
    websocket: createWebSocketHandler(() => server),
    idleTimeout: 120,
  })

  setInterval(() => {
    const keyChanged = leaderboardService.checkWeekChange()
    if (keyChanged && server) {
      broadcastTopLeaderboard(server)
    }
  }, CONFIG.WEEK_CHECK_INTERVAL_MS)

  console.log(`Rocket Rush Backend running on port ${CONFIG.PORT}`)
  console.log(`Redis: ${CONFIG.REDIS_URL}`)
  console.log(`Current week: ${leaderboardService.getCurrentWeek()}`)

  return server
}
//deploy

export function getServer(): AppServer | undefined {
  return server
}
