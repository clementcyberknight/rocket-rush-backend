import { getRedis } from "../redis/client"
import { Keys } from "../redis/keys"
import { CONFIG } from "../config"
import type { GameSession } from "../types"

export class SessionService {
  async createSession(uid: string): Promise<GameSession> {
    const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`
    const now = Date.now()
    const redis = getRedis()

    const session: GameSession = {
      sessionId,
      uid,
      startTime: now,
      lastTickScore: 0,
      lastTickSpeed: 0,
      lastTickLevel: 0,
      lastTickTime: now,
      tickCount: 0,
      flagged: false,
    }

    await redis.hset(Keys.session(sessionId), {
      uid,
      startTime: now.toString(),
      lastTickScore: "0",
      lastTickSpeed: "0",
      lastTickLevel: "0",
      lastTickTime: now.toString(),
      tickCount: "0",
      flagged: "0",
    })

    await redis.expire(Keys.session(sessionId), CONFIG.SESSION_TTL)

    return session
  }

  async getSession(sessionId: string): Promise<GameSession | null> {
    const redis = getRedis()
    const raw = await redis.hgetall(Keys.session(sessionId))
    if (!raw || Object.keys(raw).length === 0) return null
    return this.deserializeSession(sessionId, raw)
  }

  async processTick(
    sessionId: string,
    score: number,
    speed: number,
    level: number,
    timestamp: number,
    x = 0,
    y = 0,
    z = 0
  ): Promise<boolean> {
    const redis = getRedis()
    const key = Keys.session(sessionId)
    const raw = await redis.hgetall(key)
    if (!raw || Object.keys(raw).length === 0) return false

    const session = this.deserializeSession(sessionId, raw)
    if (session.flagged) return false

    const { ANTI_CHEAT: AC } = CONFIG
    const now = Date.now()
    const deltaTime = (timestamp - session.lastTickTime) / 1000

    if (session.tickCount > 0 && deltaTime > 0) {
      if (deltaTime > AC.TICK_INTERVAL_MAX) return false
      if (Math.abs(timestamp - now) > AC.CLOCK_DRIFT_MS) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      if (score < session.lastTickScore - AC.SCORE_MONOTONIC_GRACE) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      if (level < session.lastTickLevel) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      if (speed < session.lastTickSpeed - 0.02) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      const speedAccel = (speed - session.lastTickSpeed) / deltaTime
      if (speedAccel > AC.SPEED_ACCEL_MAX) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      const maxSpeed = AC.SPEED_BASE + level * AC.SPEED_PER_LEVEL + AC.SPEED_GRACE
      if (speed > maxSpeed) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
      const expectedLevel = Math.floor(score / AC.SCORE_UNITS_PER_LEVEL)
      if (Math.abs(level - expectedLevel) > AC.LEVEL_TOLERANCE) {
        await redis.hset(key, { flagged: "1" })
        return false
      }
    }

    await redis.hset(key, {
      lastTickScore: score.toString(),
      lastTickSpeed: speed.toString(),
      lastTickLevel: level.toString(),
      lastTickTime: timestamp.toString(),
      tickCount: (session.tickCount + 1).toString(),
    })
    await redis.expire(key, CONFIG.SESSION_TTL)

    await redis.rpush(Keys.tickList(sessionId), `${z},${x},${y}`)
    await redis.expire(Keys.tickList(sessionId), CONFIG.SESSION_TTL)

    return true
  }

  async validateScore(
    sessionId: string,
    uid: string,
    score: number
  ): Promise<{ valid: boolean; reason?: string }> {
    const redis = getRedis()
    const key = Keys.session(sessionId)
    const raw = await redis.hgetall(key)
    if (!raw || Object.keys(raw).length === 0) {
      return { valid: false, reason: "Session not found" }
    }

    const session = this.deserializeSession(sessionId, raw)

    if (session.uid !== uid) {
      await redis.hset(key, { flagged: "1" })
      return { valid: false, reason: "Wallet mismatch" }
    }

    if (session.flagged) {
      return { valid: false, reason: "Session flagged for suspicious activity" }
    }

    if (score <= 0) {
      return { valid: false, reason: "Score must be positive" }
    }

    const { ANTI_CHEAT: AC } = CONFIG

    if (session.tickCount >= AC.MIN_TICK_COUNT) {
      const now = Date.now()
      const timeSinceLastTick = (now - session.lastTickTime) / 1000

      if (timeSinceLastTick <= AC.TICK_INTERVAL_MAX) {
        if (score < session.lastTickScore - AC.SCORE_MONOTONIC_GRACE) {
          await redis.hset(key, { flagged: "1" })
          return { valid: false, reason: "Score cannot decrease" }
        }

        const maxSpeed = AC.SPEED_BASE + session.lastTickLevel * AC.SPEED_PER_LEVEL + AC.SPEED_GRACE
        const maxIncrease = maxSpeed * AC.SCORE_PER_UNIT_SPEED * Math.max(timeSinceLastTick, 0.5) * AC.SCORE_TOLERANCE

        if (score - session.lastTickScore > maxIncrease) {
          await redis.hset(key, { flagged: "1" })
          return { valid: false, reason: "Score increase exceeds plausible maximum" }
        }

        const expectedLevel = Math.floor(score / AC.SCORE_UNITS_PER_LEVEL)
        if (Math.abs(session.lastTickLevel - expectedLevel) > AC.LEVEL_TOLERANCE) {
          await redis.hset(key, { flagged: "1" })
          return { valid: false, reason: "Level mismatch with score" }
        }
      }
    }

    return { valid: true }
  }

  async endSession(sessionId: string): Promise<void> {
    const redis = getRedis()
    await redis.del(Keys.session(sessionId))
  }

  private deserializeSession(sessionId: string, raw: Record<string, string>): GameSession {
    return {
      sessionId,
      uid: raw.uid || "",
      startTime: parseInt(raw.startTime || "0") || 0,
      lastTickScore: parseFloat(raw.lastTickScore || "0") || 0,
      lastTickSpeed: parseFloat(raw.lastTickSpeed || "0") || 0,
      lastTickLevel: parseInt(raw.lastTickLevel || "0") || 0,
      lastTickTime: parseInt(raw.lastTickTime || "0") || 0,
      tickCount: parseInt(raw.tickCount || "0") || 0,
      flagged: raw.flagged === "1",
    }
  }
}

export const sessionService = new SessionService()
