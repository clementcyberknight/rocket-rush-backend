import { CONFIG } from "../config"

const P = CONFIG.KEY_PREFIX

export const Keys = {
  user: (uid: string) => `${P}u:${uid}`,
  identityToUid: (identity: string) => `${P}id:${identity}`,
  username: (lower: string) => `${P}un:${lower}`,
  uidToUsername: (uid: string) => `${P}uun:${uid}`,

  profile: (uid: string) => `${P}p:${uid}`,

  lbWeekly: (weekKey: string) => `${P}lb:w:${weekKey}`,
  lbAllTime: () => `${P}lb:all`,

  lbCacheWeekly: (weekKey: string) => `${P}c:w:${weekKey}`,
  lbCacheAllTime: () => `${P}c:all`,

  session: (sessionId: string) => `${P}sess:${sessionId}`,

  tickList: (sessionId: string) => `${P}tick:${sessionId}`,

  ghost: (uid: string) => `${P}ghost:${uid}`,

  rateLimit: (action: string, id: string) => `${P}rl:${action}:${id}`,
} as const

export function getWeekKey(date?: Date): string {
  const d = date ?? new Date()
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86400000 +
      yearStart.getUTCDay() +
      1) /
      7
  )
  return `${d.getUTCFullYear()}-W${week}`
}
