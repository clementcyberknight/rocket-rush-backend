import type { AppServer } from "../types";
import { leaderboardService } from "../services/leaderboard.service";

export async function handleHttpRequest(
  req: Request,
  server: AppServer
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/leaderboard") {
    const data = await leaderboardService.getTopScores(100);
    return Response.json({
      leaderboard: data,
      week: leaderboardService.getCurrentWeek(),
    });
  }

  if (url.pathname === "/health") {
    return new Response("ok", { status: 200 });
  }

  if (server.upgrade(req, { data: {} })) {
    return new Response(null, { status: 101 });
  }

  return new Response("Rocket Rush Realtime Protobuf Backend", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}
