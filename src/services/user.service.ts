import type { UserRecord, IdentityKind } from "../types"
import { getRedis } from "../redis/client"
import { Keys } from "../redis/keys"

const profanityList: ReadonlySet<string> = new Set([
  "fuck", "shit", "ass", "bitch", "dick", "cock", "cunt", "piss",
  "slut", "whore", "bastard", "nigger", "fag", "retard", "twat",
])

export function generateRushId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let id = ""
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return `rush_${id}`
}

export function isRushId(identity: string): boolean {
  return identity.startsWith("rush_")
}

export function isWalletId(identity: string): boolean {
  return !isRushId(identity)
}

export class UserService {
  private rateLimitMap = new Map<string, number>()

  private checkRateLimit(key: string, maxPerSec = 10): boolean {
    const now = Date.now()
    const last = this.rateLimitMap.get(key)
    if (last && now - last < 1000 / maxPerSec) return false
    this.rateLimitMap.set(key, now)
    return true
  }

  async resolveUser(identity: string): Promise<UserRecord> {
    const redis = getRedis()
    const idKey = Keys.identityToUid(identity)
    let uid = await redis.get(idKey)

    if (uid) {
      const profile = await redis.hgetall(Keys.profile(uid))
      if (profile && Object.keys(profile).length > 0) {
        const record = this.deserializeProfile(uid, profile)
        await redis.hset(Keys.profile(uid), { lastSeen: Date.now().toString() })
        return record
      }
    }

    uid = this.generateUid(identity)
    const kind: IdentityKind = isRushId(identity) ? "rush" : "wallet"
    const now = Date.now()

    const profile: Record<string, string> = {
      uid,
      identity,
      identityKind: kind,
      createdAt: now.toString(),
      updatedAt: now.toString(),
      lastSeen: now.toString(),
      highScore: "0",
      totalGames: "0",
      username: "",
    }

    await redis.set(idKey, uid)
    await redis.hset(Keys.profile(uid), profile)

    return {
      uid,
      username: null,
      identityKind: kind,
      identity,
      createdAt: now,
      updatedAt: now,
      lastSeen: now,
      highScore: 0,
      totalGames: 0,
    }
  }

  async getUser(uid: string): Promise<UserRecord | null> {
    const redis = getRedis()
    const profile = await redis.hgetall(Keys.profile(uid))
    if (!profile || Object.keys(profile).length === 0) return null
    return this.deserializeProfile(uid, profile)
  }

  private generateUid(identity: string): string {
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).substring(2, 8)
    return `u_${ts}_${rand}`
  }

  private deserializeProfile(uid: string, raw: Record<string, string>): UserRecord {
    const username = (raw.username && raw.username.length > 0) ? raw.username : null
    return {
      uid,
      username,
      identityKind: ((raw.identityKind as IdentityKind | undefined) || "rush") as IdentityKind,
      identity: raw.identity || "",
      createdAt: parseInt(raw.createdAt || "0") || 0,
      updatedAt: parseInt(raw.updatedAt || "0") || 0,
      lastSeen: parseInt(raw.lastSeen || "0") || 0,
      highScore: parseFloat(raw.highScore || "0") || 0,
      totalGames: parseInt(raw.totalGames || "0") || 0,
    }
  }

  async updateHighScore(uid: string, score: number): Promise<void> {
    const redis = getRedis()
    const profile = await redis.hgetall(Keys.profile(uid))
    const current = parseFloat(profile?.highScore || "0")
    if (score > current) {
      await redis.hset(Keys.profile(uid), { highScore: score.toString() })
    }
  }

  async incrementGames(uid: string): Promise<void> {
    const redis = getRedis()
    await redis.hincrby(Keys.profile(uid), "totalGames", 1)
  }

  validateUsernameFormat(username: string): { valid: boolean; error?: string } {
    const { MIN_LENGTH, MAX_LENGTH, PATTERN } = {
      MIN_LENGTH: 3,
      MAX_LENGTH: 16,
      PATTERN: /^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/,
    }
    const clean = username.trim()
    if (clean.length < MIN_LENGTH) {
      return { valid: false, error: `Username must be at least ${MIN_LENGTH} characters` }
    }
    if (clean.length > MAX_LENGTH) {
      return { valid: false, error: `Username must be at most ${MAX_LENGTH} characters` }
    }
    if (!PATTERN.test(clean)) {
      return { valid: false, error: "Username can only contain letters, numbers, underscores, and hyphens" }
    }
    const lower = clean.toLowerCase()
    for (const bad of profanityList) {
      if (lower.includes(bad)) {
        return { valid: false, error: "Username contains inappropriate content" }
      }
    }
    return { valid: true }
  }

  async getUserByIdentity(identity: string): Promise<UserRecord | null> {
    const redis = getRedis()
    const uid = await redis.get(Keys.identityToUid(identity))
    if (!uid) return null
    return this.getUser(uid)
  }
}

export const userService = new UserService()
