const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase()
const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(level: string): boolean {
  return levels[level]! >= levels[LOG_LEVEL]!
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23)
}

function fmt(level: string, mod: string, msg: string, ctx?: Record<string, unknown>): string {
  const base = `[${ts()}] [${level.toUpperCase().padEnd(5)}] [${mod}] ${msg}`
  if (ctx && Object.keys(ctx).length > 0) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(ctx)) {
      parts.push(`${k}=${v}`)
    }
    return `${base} ${parts.join(" ")}`
  }
  return base
}

export function debug(mod: string, msg: string, ctx?: Record<string, unknown>) {
  if (shouldLog("debug")) console.log(fmt("debug", mod, msg, ctx))
}

export function info(mod: string, msg: string, ctx?: Record<string, unknown>) {
  if (shouldLog("info")) console.log(fmt("info", mod, msg, ctx))
}

export function warn(mod: string, msg: string, ctx?: Record<string, unknown>) {
  if (shouldLog("warn")) console.warn(fmt("warn", mod, msg, ctx))
}

export function error(mod: string, msg: string, ctx?: Record<string, unknown>) {
  if (shouldLog("error")) console.error(fmt("error", mod, msg, ctx))
}
