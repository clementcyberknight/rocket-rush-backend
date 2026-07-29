import { getRedis } from "../redis/client"
import { Keys } from "../redis/keys"
import { CONFIG } from "../config"
import {
  encodeServerMessage,
  ServerMessageType,
  type RoomPlayerEntry,
  type RoomPlayerState,
  type RoomRankingEntry,
} from "../protocol/protoCodec"
import { usernameService } from "./username.service"
import type { AppServer, AppWebSocket } from "../types"

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ROOM_CODE_LEN = 6
const ROOM_MAX_PLAYERS = 10
const ROOM_TTL = 60 * 60 * 2
const BROADCAST_INTERVAL_MS = 50

interface InMemoryPlayer {
  ws: AppWebSocket
  uid: string
  username: string | null
  isHost: boolean
  alive: boolean
  x: number; y: number; z: number; score: number; level: number
}

interface InMemoryRoom {
  code: string
  seed: number
  hostUid: string
  status: "lobby" | "countdown" | "playing" | "finished"
  players: Map<string, InMemoryPlayer>
  createdAt: number
}

const rooms = new Map<string, InMemoryRoom>()
const uidToRoom = new Map<string, string>()

function generateCode(): string {
  let code = ""
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  }
  return code
}

let broadcastTimer: Timer | null = null

function startBroadcastTimer(server: AppServer) {
  if (broadcastTimer) return
  broadcastTimer = setInterval(async () => {
    const redis = getRedis()
    for (const [code, room] of rooms) {
      if (room.status !== "playing") continue
      try {
        const posHash = Keys.roomPositions(code)
        const rawPos = await redis.hgetall(posHash)
        if (!rawPos || Object.keys(rawPos).length === 0) continue

        const states: RoomPlayerState[] = []
        for (const [rUid, raw] of Object.entries(rawPos)) {
          const parts = (raw || "").split(",")
          const player = room.players.get(rUid)
          states.push({
            uid: rUid,
            username: player?.username || null,
            x: parseFloat(parts[0] || "0"),
            y: parseFloat(parts[1] || "0"),
            z: parseFloat(parts[2] || "0"),
            score: parseFloat(parts[3] || "0"),
            alive: parts[5] === "1",
            level: parseInt(parts[4] || "0"),
          })
        }
        if (states.length === 0) continue

        const bytes = encodeServerMessage({ type: ServerMessageType.ROOM_PLAYERS, players: states })
        server.publish(`room:${code}`, bytes)
      } catch (err) {
        console.error(`[RoomService] Broadcast error for room ${code}:`, err)
      }
    }
  }, BROADCAST_INTERVAL_MS)
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

export class RoomService {
  private server: AppServer | null = null

  setServer(server: AppServer) {
    this.server = server
    startBroadcastTimer(server)
  }

  private getServer(): AppServer {
    if (!this.server) throw new Error("RoomService not initialized")
    return this.server
  }

  async createRoom(ws: AppWebSocket): Promise<{ code: string; seed: number } | null> {
    const uid = ws.data.uid
    if (!uid) { console.error("[RoomService] createRoom: no uid"); return null }

    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    let code = generateCode()
    while (rooms.has(code)) code = generateCode()

    const seed = (Math.random() * 0xffffffff) >>> 0
    const username = await usernameService.getUsername(uid)

    const room: InMemoryRoom = {
      code, seed, hostUid: uid, status: "lobby",
      players: new Map(), createdAt: Date.now()
    }

    room.players.set(uid, {
      ws, uid, username, isHost: true, alive: true,
      x: 0, y: 0, z: 0, score: 0, level: 0
    })

    rooms.set(code, room)
    uidToRoom.set(uid, code)

    try {
      const redis = getRedis()
      await redis.hset(Keys.room(code), {
        seed: seed.toString(), host_uid: uid, status: "lobby",
        player_count: "1", created_at: Date.now().toString()
      })
      await redis.sadd(Keys.roomPlayers(code), uid)
      await redis.expire(Keys.room(code), ROOM_TTL)
      await redis.expire(Keys.roomPlayers(code), ROOM_TTL)
    } catch (err) { console.error("[RoomService] Redis createRoom:", err) }

    ws.subscribe(`room:${code}`)
    console.log(`[RoomService] Room ${code} created by uid=${uid} seed=${seed}`)
    return { code, seed }
  }

  async joinRoom(ws: AppWebSocket, code: string): Promise<{
    success: boolean; error?: string; code?: string; seed?: number; players?: RoomPlayerEntry[]
  }> {
    const uid = ws.data.uid
    if (!uid) return { success: false, error: "Not authenticated" }
    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    const room = rooms.get(code.toUpperCase())
    if (!room) return { success: false, error: "Room not found or expired" }
    if (room.status !== "lobby") return { success: false, error: "Game already in progress" }
    if (room.players.size >= ROOM_MAX_PLAYERS) return { success: false, error: "Room is full (max 10)" }

    const username = await usernameService.getUsername(uid)
    const player: InMemoryPlayer = {
      ws, uid, username, isHost: false, alive: true,
      x: 0, y: 0, z: 0, score: 0, level: 0
    }

    room.players.set(uid, player)
    uidToRoom.set(uid, code)
    ws.subscribe(`room:${code}`)

    try {
      const redis = getRedis()
      await redis.sadd(Keys.roomPlayers(code), uid)
      await redis.hset(Keys.room(code), { player_count: room.players.size.toString() })
    } catch {}

    const players: RoomPlayerEntry[] = []
    for (const [, p] of room.players) {
      players.push({ uid: p.uid, username: p.username, isHost: p.isHost })
    }

    const joinedBytes = encodeServerMessage({ type: ServerMessageType.ROOM_PLAYER_JOINED, uid, username })
    for (const [, p] of room.players) {
      if (p.uid !== uid) { try { p.ws.send(joinedBytes) } catch {} }
    }

    console.log(`[RoomService] uid=${uid} joined room ${code}`)
    return { success: true, code, seed: room.seed, players }
  }

  leaveRoom(ws: AppWebSocket): void {
    const uid = ws.data.uid
    if (!uid) return
    const code = uidToRoom.get(uid)
    if (!code) return

    const room = rooms.get(code)
    if (!room) { uidToRoom.delete(uid); return }

    room.players.delete(uid)
    uidToRoom.delete(uid)
    try { ws.unsubscribe(`room:${code}`) } catch {}

    if (room.players.size === 0) {
      rooms.delete(code)
      try { const redis = getRedis(); redis.del(Keys.room(code)); redis.del(Keys.roomPlayers(code)); redis.del(Keys.roomPositions(code)) } catch {}
      console.log(`[RoomService] Room ${code} deleted (empty)`)
      return
    }

    if (room.hostUid === uid) {
      const first = room.players.values().next().value
      if (first) { room.hostUid = first.uid; first.isHost = true }
    }

    const leaveBytes = encodeServerMessage({ type: ServerMessageType.ROOM_PLAYER_LEFT, uid })
    for (const [, p] of room.players) { try { p.ws.send(leaveBytes) } catch {} }

    try {
      const redis = getRedis()
      redis.srem(Keys.roomPlayers(code), uid)
      redis.hset(Keys.room(code), { player_count: room.players.size.toString(), host_uid: room.hostUid })
    } catch {}
  }

  async startRoom(ws: AppWebSocket): Promise<boolean> {
    const uid = ws.data.uid
    if (!uid) return false
    const code = uidToRoom.get(uid)
    if (!code) return false
    const room = rooms.get(code)
    if (!room) return false
    if (room.hostUid !== uid) return false
    if (room.players.size < 1) return false

    room.status = "countdown"
    room.players.forEach(p => { p.alive = true })
    const server = this.getServer()

    for (let sec = 3; sec >= 1; sec--) {
      const bytes = encodeServerMessage({ type: ServerMessageType.ROOM_COUNTDOWN, seconds: sec })
      server.publish(`room:${code}`, bytes)
      await sleep(1000)
    }

    room.status = "playing"
    try {
      await getRedis().hset(Keys.room(code), { status: "playing" })
    } catch {}
    server.publish(`room:${code}`, encodeServerMessage({ type: ServerMessageType.ROOM_STARTED }))

    return true
  }

  updatePosition(uid: string, x: number, y: number, z: number, score: number, level: number): void {
    const code = uidToRoom.get(uid)
    if (!code) return
    const room = rooms.get(code)
    if (!room || room.status !== "playing") return

    const player = room.players.get(uid)
    if (!player || !player.alive) return

    player.x = x; player.y = y; player.z = z; player.score = score; player.level = level

    try {
      getRedis().hset(Keys.roomPositions(code), {
        [uid]: `${x},${y},${z},${score},${level},1`
      })
    } catch {}
  }

  playerDied(ws: AppWebSocket): void {
    const uid = ws.data.uid
    if (!uid) return
    const code = uidToRoom.get(uid)
    if (!code) return
    const room = rooms.get(code)
    if (!room) return
    const player = room.players.get(uid)
    if (!player) return

    player.alive = false
    try {
      getRedis().hset(Keys.roomPositions(code), {
        [uid]: `${player.x},${player.y},${player.z},${player.score},${player.level},0`
      })
    } catch {}

    const server = this.getServer()
    server.publish(`room:${code}`, encodeServerMessage({ type: ServerMessageType.ROOM_PLAYER_DIED, uid }))

    const allDead = Array.from(room.players.values()).every(p => !p.alive)
    if (allDead) {
      room.status = "finished"
      const sorted = Array.from(room.players.values()).sort((a, b) => b.score - a.score)
      const rankings: RoomRankingEntry[] = sorted.map((p, i) => ({
        uid: p.uid, username: p.username, score: p.score, rank: i + 1
      }))
      server.publish(`room:${code}`, encodeServerMessage({ type: ServerMessageType.ROOM_GAME_OVER, rankings }))
    }
  }

  getRoomCode(uid: string): string | null {
    return uidToRoom.get(uid) || null
  }

  async rejoinRoom(ws: AppWebSocket, uid: string, code: string): Promise<boolean> {
    const room = rooms.get(code)
    if (!room) return false
    const player = room.players.get(uid)
    if (!player) return false
    player.ws = ws
    ws.data.uid = uid
    uidToRoom.set(uid, code)
    ws.subscribe(`room:${code}`)

    sendJoinInfo(ws, room, uid)
    return true
  }
}

function sendJoinInfo(ws: AppWebSocket, room: InMemoryRoom, uid: string) {
  const players: RoomPlayerEntry[] = []
  for (const [, p] of room.players) {
    players.push({ uid: p.uid, username: p.username, isHost: p.isHost })
  }
  const bytes = encodeServerMessage({
    type: ServerMessageType.ROOM_JOINED,
    code: room.code, seed: room.seed, players,
  })
  try { ws.send(bytes) } catch {}
}

export const roomService = new RoomService()
