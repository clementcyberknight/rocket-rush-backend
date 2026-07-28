import { getRedis, evalLua } from "../redis/client"
import { Keys, getWeekKey } from "../redis/keys"
import { LUA_SUBMIT_SCORE } from "../redis/scripts"
import { CONFIG } from "../config"
import type { LeaderboardEntry } from "../types"
import { userService } from "./user.service"
import { usernameService } from "./username.service"

function encodeGhostBlob(points: Array<{ z: number; x: number; y: number }>, intervalMs: number): Uint8Array {
  const blob = new Uint8Array(4 + points.length * 10)
  const dv = new DataView(blob.buffer)
  dv.setUint16(0, intervalMs)
  dv.setUint16(2, points.length)
  for (let i = 0; i < points.length; i++) {
    const off = 4 + i * 10
    const p = points[i]!
    dv.setFloat32(off, p.z, true)
    dv.setInt16(off + 4, Math.max(-32768, Math.min(32767, Math.round(p.x * 109.2266))), true)
    dv.setFloat32(off + 6, p.y, true)
  }
  return blob
}

export class LeaderboardService {
  private currentWeekKey: string
  private topCache = new Map<string, { entries: LeaderboardEntry[]; ts: number }>()

  constructor() {
    this.currentWeekKey = getWeekKey()
  }

  getCurrentWeek(): string {
    return this.currentWeekKey
  }

  checkWeekChange(): boolean {
    const newWeek = getWeekKey()
    if (newWeek !== this.currentWeekKey) {
      this.currentWeekKey = newWeek
      this.topCache.clear()
      return true
    }
    return false
  }

  invalidateCache(): void {
    this.topCache.clear()
  }

  async getGhostBlob(uid: string): Promise<Uint8Array | null> {
    const redis = getRedis()
    try {
      const gkey = Keys.ghost(uid)
      const exists = await redis.exists(gkey)
      if (!exists) return null
      const raw = await redis.send("HGET", [gkey, "pb"])
      if (!raw || typeof raw !== "string") return null
      const buf = Buffer.from(raw, "binary")
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch {
      return null
    }
  }

  async submitScore(
    uid: string,
    score: number,
    sessionId?: string,
    week?: string
  ): Promise<LeaderboardEntry | null> {
    if (!uid || score <= 0) return null

    const wk = week ?? this.currentWeekKey
    const zkey = Keys.lbWeekly(wk)
    const allKey = Keys.lbAllTime()
    const redis = getRedis()

    try {
      await evalLua(
        LUA_SUBMIT_SCORE,
        1,
        zkey,
        uid,
        score.toString(),
        CONFIG.WEEK_TTL.toString()
      )

      const existingAll = (await redis.zscore(allKey, uid)) || 0
      const isPbAllTime = score > existingAll
      if (isPbAllTime) {
        await redis.zadd(allKey, score, uid)
      }

      const prevHigh = (await userService.getUser(uid))?.highScore || 0
      const isPb = score > prevHigh

      await userService.updateHighScore(uid, score)
      await userService.incrementGames(uid)

      if (isPb && sessionId) {
        const tickKey = Keys.tickList(sessionId)
        try {
          const rawTicks = await redis.lrange(tickKey, 0, -1) as string[]
          if (rawTicks && rawTicks.length > 1) {
            const points: Array<{ z: number; x: number; y: number }> = []
            for (const entry of rawTicks) {
              const parts = entry.split(",")
              if (parts.length >= 3) {
                const pz = parseFloat(parts[0]!)
                const px = parseFloat(parts[1]!)
                const py = parseFloat(parts[2]!)
                if (!isNaN(pz) && !isNaN(px) && !isNaN(py)) {
                  points.push({ z: pz, x: px, y: py })
                }
              }
            }
            if (points.length > 1) {
              const blob = encodeGhostBlob(points, CONFIG.TICK_INTERVAL_MS)
              const ghostKey = Keys.ghost(uid)
              const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
              await redis.send("HSET", [ghostKey, "pb", buf.toString("binary")])
              await redis.expire(ghostKey, CONFIG.GHOST_TTL)
            }
          }
        } catch (err) {
          console.error(`[Leaderboard] Ghost persist failed for uid=${uid}:`, err)
        }
        await redis.del(tickKey)
      } else if (sessionId) {
        await redis.del(Keys.tickList(sessionId))
      }

      this.topCache.delete(wk)
      this.topCache.delete("all")

      const rank = (await redis.zrevrank(zkey, uid)) ?? 0
      const username = await usernameService.getUsername(uid)

      return {
        rank: rank + 1,
        uid,
        username,
        score,
      }
    } catch (error) {
      console.error(`[Leaderboard] Error submitting score for uid=${uid}:`, error)
      return null
    }
  }

  async getTopScores(
    limit: number = 20,
    week?: string,
    allTime = false
  ): Promise<LeaderboardEntry[]> {
    if (limit > CONFIG.TOP_LEADERBOARD_LIMIT) {
      limit = CONFIG.TOP_LEADERBOARD_LIMIT
    }

    const cacheKey = allTime ? "all" : (week ?? this.currentWeekKey)

    const cached = this.topCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < CONFIG.LEADERBOARD_CACHE_TTL * 1000) {
      return cached.entries.slice(0, limit)
    }

    const redis = getRedis()
    const zkey = allTime ? Keys.lbAllTime() : Keys.lbWeekly(cacheKey)

    try {
      const results = await redis.zrevrange(zkey, 0, limit - 1, "WITHSCORES")
      if (!results || results.length === 0) {
        this.topCache.set(cacheKey, { entries: [], ts: Date.now() })
        return []
      }

      const entries: LeaderboardEntry[] = []
      for (let i = 0; i < results.length; i++) {
        const [uid, scoreStr] = results[i]!

        let username: string | null = null
        try {
          username = await usernameService.getUsername(uid!)
        } catch {}

        entries.push({
          rank: i + 1,
          uid: uid!,
          username,
          score: typeof scoreStr === "number" ? scoreStr : parseFloat(scoreStr as unknown as string) || 0,
        })
      }

      this.topCache.set(cacheKey, { entries, ts: Date.now() })
      return entries
    } catch (error) {
      console.error("[Leaderboard] Error fetching top scores:", error)
      return []
    }
  }

  async getRank(uid: string, week?: string): Promise<number> {
    const redis = getRedis()
    const zkey = Keys.lbWeekly(week ?? this.currentWeekKey)
    try {
      const rank = await redis.zrevrank(zkey, uid)
      return rank !== null ? rank + 1 : 0
    } catch {
      return 0
    }
  }

  async mergeGuestToWallet(fromUid: string, toUid: string): Promise<boolean> {
    if (!fromUid || !toUid || fromUid === toUid) return false

    const redis = getRedis()

    const fromUser = await userService.getUser(fromUid)
    if (!fromUser || fromUser.identityKind !== "rush") return false

    const toUser = await userService.getUser(toUid)
    if (!toUser) return false

    try {
      const fromUsername = fromUser.username
      if (fromUsername && !toUser.username) {
        await usernameService.setUsername(toUid, fromUsername)
      }

      const lbKeys = await redis.keys(`${CONFIG.KEY_PREFIX}lb:*`)
      let merged = 0
      for (const key of lbKeys) {
        const score = await redis.zscore(key, fromUid)
        if (score && score > 0) {
          const existing = (await redis.zscore(key, toUid)) || 0
          if (score > existing) {
            await redis.zadd(key, score, toUid)
          }
          await redis.zrem(key, fromUid)
          merged++
        }
      }

      await redis.del(Keys.identityToUid(fromUser.identity))
      await redis.del(Keys.profile(fromUid))
      await redis.del(Keys.uidToUsername(fromUid))
      const oldUsername = fromUser.username
      if (oldUsername) {
        await redis.del(Keys.username(oldUsername.toLowerCase()))
      }

      this.topCache.clear()
      console.log(`[Leaderboard] Merged ${merged} scores from ${fromUid} -> ${toUid}`)
      return true
    } catch (error) {
      console.error("[Leaderboard] Error merging users:", error)
      return false
    }
  }
}

export const leaderboardService = new LeaderboardService()
