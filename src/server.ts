import { CONFIG } from "./config";
import type { AppServer, WebSocketData } from "./types";
import { handleHttpRequest } from "./handlers/http.handler";
import { createWebSocketHandler, broadcastTopLeaderboard } from "./handlers/websocket.handler";
import { leaderboardService } from "./services/leaderboard.service";

let server: AppServer;

export function startServer(): AppServer {
  server = Bun.serve<WebSocketData>({
    port: CONFIG.PORT,
    fetch(req, srv) {
      return handleHttpRequest(req, srv);
    },
    websocket: createWebSocketHandler(() => server),
    idleTimeout: 120,
  });

  setInterval(() => {
    const keyChanged = leaderboardService.checkWeekChange();
    if (keyChanged && server) {
      broadcastTopLeaderboard(server);
    }
  }, CONFIG.WEEK_CHECK_INTERVAL_MS);

  console.log(`Rocket Rush Realtime Backend running on port ${CONFIG.PORT}`);
  console.log(`Current Weekly Leaderboard Key: ${leaderboardService.getCurrentWeek()}`);

  return server;
}

export function getServer(): AppServer | undefined {
  return server;
}
