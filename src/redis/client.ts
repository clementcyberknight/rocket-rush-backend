import { RedisClient } from "bun"
import { CONFIG } from "../config"

let redis: RedisClient | null = null

export function getRedis(): RedisClient {
  if (!redis) {
    redis = new RedisClient(CONFIG.REDIS_URL, {
      connectionTimeout: 10000,
      idleTimeout: 0,
      autoReconnect: true,
      maxRetries: 10,
      enableOfflineQueue: true,
      enableAutoPipelining: true,
    })
    redis.onclose = (err) => {
      console.error(`[Redis] Connection closed: ${err.message}`)
    }
  }
  return redis
}

export async function evalLua(script: string, numKeys: number, ...args: string[]): Promise<unknown> {
  const r = getRedis()
  return r.send("EVAL", [script, numKeys.toString(), ...args])
}
