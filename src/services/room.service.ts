import { getRedis } from "../redis/client"
import { Keys } from "../redis/keys"
import { CONFIG } from "../config"
import {
  encodeServerMessage,
  encodeRoomPlayersCompact,
  ServerMessageType,
  type RoomPlayerEntry,
  type RoomPlayerState,
  type RoomRankingEntry,
  type CompactPlayerState,
} from "../protocol/protoCodec"
import { usernameService } from "./username.service"
import { userService } from "./user.service"
import type { AppServer, AppWebSocket } from "../types"

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ROOM_CODE_LEN = 6
const ROOM_MAX_PLAYERS = 10
const ROOM_TTL = 60 * 60 * 2
const BROADCAST_INTERVAL_MS = 40

interface InMemoryPlayer {
  ws: AppWebSocket
  uid: string
  username: string | null
  isHost: boolean
  alive: boolean
  playerIndex: number
  x: number
  y: number
  z: number
  speed: number
  score: number
  level: number
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
  broadcastTimer = setInterval(() => {
    for (const [code, room] of rooms) {
      if (room.status !== "playing") continue
      try {
        if (room.players.size === 0) continue

        const compactStates: CompactPlayerState[] = []
        for (const [, p] of room.players) {
          compactStates.push({
            playerIndex: p.playerIndex,
            alive: p.alive,
            x: p.x,
            y: p.y,
            z: p.z,
            speed: p.speed,
            score: p.score,
            level: p.level,
            uid: p.uid,
          })
        }

        if (compactStates.length > 0) {
          const bytes = encodeRoomPlayersCompact(compactStates)
          server.publish(`room:${code}`, bytes)
        }
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

  async createRoom(ws: AppWebSocket, preferredUsername?: string): Promise<{ code: string; seed: number } | null> {
    const uid = ws.data.uid
    if (!uid) { console.error("[RoomService] createRoom: no uid"); return null }

    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    let code = generateCode()
    while (rooms.has(code)) code = generateCode()

    const seed = (Math.random() * 0xffffffff) >>> 0
    let username = await usernameService.getUsername(uid)
    if (!username) {
      const u = await userService.getUser(uid)
      username = u?.username || preferredUsername || null
    }

    const room: InMemoryRoom = {
      code, seed, hostUid: uid, status: "lobby",
      players: new Map(), createdAt: Date.now()
    }

    room.players.set(uid, {
      ws, uid, username, isHost: true, alive: true,
      playerIndex: 0,
      x: 0, y: 3, z: -10, speed: 0, score: 0, level: 0
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
    console.log(`[RoomService] Room ${code} created by uid=${uid} username=${username} seed=${seed}`)
    return { code, seed }
  }

  async joinRoom(ws: AppWebSocket, code: string, preferredUsername?: string): Promise<{
    success: boolean; error?: string; code?: string; seed?: number; players?: RoomPlayerEntry[]
  }> {
    const uid = ws.data.uid
    if (!uid) return { success: false, error: "Not authenticated" }
    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    const room = rooms.get(code.toUpperCase())
    if (!room) return { success: false, error: "Room not found or expired" }
    if (room.status !== "lobby") return { success: false, error: "Game already in progress" }
    if (room.players.size >= ROOM_MAX_PLAYERS) return { success: false, error: "Room is full (max 10)" }

    let username = await usernameService.getUsername(uid)
    if (!username) {
      const u = await userService.getUser(uid)
      username = u?.username || preferredUsername || null
    }

    const playerIndex = room.players.size
    const player: InMemoryPlayer = {
      ws, uid, username, isHost: false, alive: true,
      playerIndex,
      x: 0, y: 3, z: -10, speed: 0, score: 0, level: 0
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

    console.log(`[RoomService] uid=${uid} username=${username} joined room ${code}`)
    return { success: true, code, seed: room.seed, players }
  }

  leaveRoom(ws: AppWebSocket): void {
    const uid = ws.data.uid
    if (!uid) return
    const code = uidToRoom.get(uid)
    if (!code) return

    const room = rooms.get(code)
    if (!room) { uidToRoom.delete(uid); return }

    try { ws.unsubscribe(`room:${code}`) } catch {}
    uidToRoom.delete(uid)

    // If host leaves/disconnects, close the room and return everyone to main menu
    if (room.hostUid === uid) {
      console.log(`[RoomService] Host ${uid} left room ${code}. Closing room for all players.`)
      const closedBytes = encodeServerMessage({
        type: ServerMessageType.ROOM_CLOSED,
        reason: "Room creator left. Returning to main menu.",
      })
      for (const [pUid, p] of room.players) {
        if (pUid !== uid) {
          try { p.ws.send(closedBytes) } catch {}
          uidToRoom.delete(pUid)
        }
      }
      rooms.delete(code)
      try {
        const redis = getRedis()
        redis.del(Keys.room(code))
        redis.del(Keys.roomPlayers(code))
        redis.del(Keys.roomPositions(code))
      } catch {}
      return
    }

    room.players.delete(uid)

    if (room.players.size === 0) {
      rooms.delete(code)
      try {
        const redis = getRedis()
        redis.del(Keys.room(code))
        redis.del(Keys.roomPlayers(code))
        redis.del(Keys.roomPositions(code))
      } catch {}
      console.log(`[RoomService] Room ${code} deleted (empty)`)
      return
    }

    const leaveBytes = encodeServerMessage({ type: ServerMessageType.ROOM_PLAYER_LEFT, uid })
    for (const [, p] of room.players) { try { p.ws.send(leaveBytes) } catch {} }

    try {
      const redis = getRedis()
      redis.srem(Keys.roomPlayers(code), uid)
      redis.hset(Keys.room(code), { player_count: room.players.size.toString() })
    } catch {}
  }

  resetRoomToLobby(ws: AppWebSocket): void {
    const uid = ws.data.uid
    if (!uid) return
    const code = uidToRoom.get(uid)
    if (!code) return
    const room = rooms.get(code)
    if (!room) return
    if (room.hostUid !== uid) return

    room.status = "lobby"
    room.seed = (Math.random() * 0xffffffff) >>> 0
    let idx = 0
    room.players.forEach(p => {
      p.playerIndex = idx++
      p.alive = true
      p.score = 0
      p.x = 0; p.y = 3; p.z = -10; p.speed = 0; p.level = 0
    })

    const players: RoomPlayerEntry[] = []
    for (const [, p] of room.players) {
      players.push({ uid: p.uid, username: p.username, isHost: p.isHost })
    }

    try {
      getRedis().hset(Keys.room(code), { status: "lobby", seed: room.seed.toString() })
    } catch {}

    const server = this.getServer()
    server.publish(`room:${code}`, encodeServerMessage({
      type: ServerMessageType.ROOM_RESET_LOBBY,
      code,
      seed: room.seed,
      players,
    }))
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

    // Generate new random seed for every new game round
    room.seed = (Math.random() * 0xffffffff) >>> 0
    room.status = "countdown"
    let idx = 0
    room.players.forEach(p => {
      p.playerIndex = idx++
      p.alive = true
      p.score = 0
      p.x = 0; p.y = 3; p.z = -10; p.speed = 0; p.level = 0
    })

    try {
      const redis = getRedis()
      await redis.del(Keys.roomPositions(code))
    } catch {}

    const server = this.getServer()

    const startInfoBytes = encodeServerMessage({
      type: ServerMessageType.ROOM_JOINED,
      code,
      seed: room.seed,
      players: Array.from(room.players.values()).map(p => ({ uid: p.uid, username: p.username, isHost: p.isHost }))
    })
    server.publish(`room:${code}`, startInfoBytes)

    for (let sec = 3; sec >= 1; sec--) {
      const bytes = encodeServerMessage({ type: ServerMessageType.ROOM_COUNTDOWN, seconds: sec })
      server.publish(`room:${code}`, bytes)
      await sleep(1000)
    }

    room.status = "playing"
    try {
      await getRedis().hset(Keys.room(code), { status: "playing", seed: room.seed.toString() })
    } catch {}
    server.publish(`room:${code}`, encodeServerMessage({ type: ServerMessageType.ROOM_STARTED }))

    return true
  }

  updatePosition(uid: string, x: number, y: number, z: number, speed: number, score: number, level: number): void {
    const code = uidToRoom.get(uid)
    if (!code) return
    const room = rooms.get(code)
    if (!room || room.status !== "playing") return

    const player = room.players.get(uid)
    if (!player || !player.alive) return

    player.x = x
    player.y = y
    player.z = z
    player.speed = speed
    player.score = score
    player.level = level
  }

  playerDied(ws: AppWebSocket): void {
    const uid = ws.data.uid
    if (!uid) return
    const code = uidToRoom.get(uid)
    if (!code) return
    const room = rooms.get(code)
    if (!room || room.status !== "playing") return
    const player = room.players.get(uid)
    if (!player || !player.alive) return

    player.alive = false
    const server = this.getServer()
    server.publish(`room:${code}`, encodeServerMessage({ type: ServerMessageType.ROOM_PLAYER_DIED, uid }))

    const aliveCount = Array.from(room.players.values()).filter(p => p.alive).length

    // The round ONLY finishes when ALL players have crashed (aliveCount === 0)
    if (aliveCount === 0) {
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
