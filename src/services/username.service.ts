import { getRedis, evalLua } from "../redis/client"
import { Keys } from "../redis/keys"
import { LUA_SET_USERNAME } from "../redis/scripts"
import { userService } from "./user.service"

export class UsernameService {
  private rateLimitMap = new Map<string, number>()

  private checkRateLimit(key: string): boolean {
    const now = Date.now()
    const last = this.rateLimitMap.get(key)
    if (last && now - last < 1000) return false
    this.rateLimitMap.set(key, now)
    return true
  }

  async checkAvailability(username: string, uid: string): Promise<{ available: boolean; error?: string }> {
    if (!this.checkRateLimit(`check:${uid}`)) {
      return { available: false, error: "Rate limited. Please wait a moment." }
    }

    const validation = userService.validateUsernameFormat(username)
    if (!validation.valid) {
      return { available: false, error: validation.error }
    }

    const redis = getRedis()
    const lower = username.trim().toLowerCase()
    const owner = await redis.get(Keys.username(lower))

    if (owner && owner !== uid) {
      return { available: false, error: `"${username.trim()}" is already taken` }
    }

    return { available: true }
  }

  async setUsername(uid: string, username: string): Promise<{ success: boolean; error?: string }> {
    if (!this.checkRateLimit(`set:${uid}`)) {
      return { success: false, error: "Rate limited. Please wait a moment." }
    }

    const user = await userService.getUser(uid)
    if (!user) {
      return { success: false, error: "User not found" }
    }

    const validation = userService.validateUsernameFormat(username)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }

    const clean = username.trim()
    const lower = clean.toLowerCase()
    const redis = getRedis()

    try {
      const result = (await evalLua(
        LUA_SET_USERNAME,
        2,
        Keys.username(lower),
        Keys.uidToUsername(uid),
        uid,
        clean,
        lower
      )) as [number, string]

      if (!result || result[0] === 0) {
        return { success: false, error: "Username is already taken by another pilot" }
      }

      await redis.hset(Keys.profile(uid), {
        username: clean,
        updatedAt: Date.now().toString(),
      })

      return { success: true }
    } catch (error) {
      console.error("[UsernameService] Error setting username:", error)
      return { success: false, error: "Server error" }
    }
  }

  async getUsername(uid: string): Promise<string | null> {
    const redis = getRedis()
    const name = await redis.get(Keys.uidToUsername(uid))
    return name && name.length > 0 ? name : null
  }
}

export const usernameService = new UsernameService()
