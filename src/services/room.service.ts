import { getRedis } from "../redis/client"
import { Keys } from "../redis/keys"
import { CONFIG } from "../config"
import {
  encodeServerMessage,
  ServerMessageType,
  type ServerMessagePayload,
  type RoomPlayerEntry,
  type RoomPlayerState,
  type RoomRankingEntry,
} from "../protocol/protoCodec"
import { userService } from "./user.service"
import { usernameService } from "./username.service"
import type { AppServer, AppWebSocket } from "../types"

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ROOM_CODE_LEN = 6
const ROOM_MAX_PLAYERS = 10
const ROOM_TTL = 60 * 60 * 2
const BROADCAST_INTERVAL_MS = 50

interface RoomPlayer {
  ws: AppWebSocket
  uid: string
  username: string | null
  isHost: boolean
  alive: boolean
  x: number
  y: number
  z: number
  score: number
  level: number
}

interface Room {
  code: string
  seed: number
  hostUid: string
  status: "lobby" | "countdown" | "playing" | "finished"
  players: Map<string, RoomPlayer>
  createdAt: number
}

const rooms = new Map<string, Room>()
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
    for (const [, room] of rooms) {
      if (room.status !== "playing") continue
      const states: RoomPlayerState[] = []
      for (const [, p] of room.players) {
        if (!p.alive) continue
        states.push({
          uid: p.uid,
          username: p.username,
          x: p.x,
          y: p.y,
          z: p.z,
          score: p.score,
          alive: true,
          level: p.level,
        })
      }
      if (states.length === 0) continue
      const bytes = encodeServerMessage({
        type: ServerMessageType.ROOM_PLAYERS,
        players: states,
      })
      server.publish(`room:${room.code}`, bytes)
    }
  }, BROADCAST_INTERVAL_MS)
}

export class RoomService {
  private server: AppServer | null = null

  setServer(server: AppServer) {
    this.server = server
    startBroadcastTimer(server)
  }

  private getServer(): AppServer {
    if (!this.server) throw new Error("RoomService not initialized with server")
    return this.server
  }

  async createRoom(ws: AppWebSocket): Promise<{ code: string; seed: number } | null> {
    const uid = ws.data.uid
    if (!uid) return null

    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    let code = generateCode()
    while (rooms.has(code)) code = generateCode()

    const seed = (Math.random() * 0xffffffff) >>> 0
    const username = await usernameService.getUsername(uid)

    const room: Room = {
      code,
      seed,
      hostUid: uid,
      status: "lobby",
      players: new Map(),
      createdAt: Date.now(),
    }

    room.players.set(uid, {
      ws,
      uid,
      username,
      isHost: true,
      alive: true,
      x: 0,
      y: 0,
      z: 0,
      score: 0,
      level: 0,
    })

    rooms.set(code, room)
    uidToRoom.set(uid, code)

    try {
      const redis = getRedis()
      await redis.hset(Keys.room(code), {
        seed: seed.toString(),
        host_uid: uid,
        status: "lobby",
        player_count: "1",
        created_at: Date.now().toString(),
      })
      await redis.sadd(Keys.roomPlayers(code), uid)
      await redis.expire(Keys.room(code), ROOM_TTL)
      await redis.expire(Keys.roomPlayers(code), ROOM_TTL)
    } catch (err) {
      console.error("[RoomService] Redis error creating room:", err)
    }

    ws.subscribe(`room:${code}`)
    return { code, seed }
  }

  async joinRoom(ws: AppWebSocket, code: string): Promise<{
    success: boolean
    error?: string
    code?: string
    seed?: number
    players?: RoomPlayerEntry[]
  }> {
    const uid = ws.data.uid
    if (!uid) return { success: false, error: "Not authenticated" }

    if (uidToRoom.has(uid)) this.leaveRoom(ws)

    const room = rooms.get(code.toUpperCase())
    if (!room) return { success: false, error: "Room not found or expired" }

    if (room.status !== "lobby") return { success: false, error: "Game already in progress" }

    if (room.players.size >= ROOM_MAX_PLAYERS) return { success: false, error: "Room is full (max 10 players)" }

    const username = await usernameService.getUsername(uid)
    const player: RoomPlayer = {
      ws,
      uid,
      username,
      isHost: false,
      alive: true,
      x: 0,
      y: 0,
      z: 0,
      score: 0,
      level: 0,
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

    const bytes = encodeServerMessage({
      type: ServerMessageType.ROOM_PLAYER_JOINED,
      uid,
      username,
    })

    for (const [, p] of room.players) {
      if (p.uid !== uid) {
        try { p.ws.send(bytes) } catch {}
      }
    }

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
      try {
        const redis = getRedis()
        redis.del(Keys.room(code))
        redis.del(Keys.roomPlayers(code))
      } catch {}
      return
    }

    if (room.hostUid === uid) {
      const first = room.players.values().next().value
      if (first) {
        room.hostUid = first.uid
        first.isHost = true
      }
    }

    const leaveBytes = encodeServerMessage({
      type: ServerMessageType.ROOM_PLAYER_LEFT,
      uid,
    })
    for (const [, p] of room.players) {
      try { p.ws.send(leaveBytes) } catch {}
    }
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
    const server = this.getServer()

    const sendCountdown = (sec: number) => {
      const bytes = encodeServerMessage({
        type: ServerMessageType.ROOM_COUNTDOWN,
        seconds: sec,
      })
      server.publish(`room:${code}`, bytes)
    }

    sendCountdown(3)
    await sleep(1000)
    sendCountdown(2)
    await sleep(1000)
    sendCountdown(1)
    await sleep(1000)

    room.status = "playing"

    for (const [, p] of room.players) {
      p.alive = true
    }

    const startBytes = encodeServerMessage({
      type: ServerMessageType.ROOM_STARTED,
    })
    server.publish(`room:${code}`, startBytes)

    return true
  }

  updatePosition(uid: string, x: number, y: number, z: number, score: number, level: number): void {
    const code = uidToRoom.get(uid)
    if (!code) return

    const room = rooms.get(code)
    if (!room || room.status !== "playing") return

    const player = room.players.get(uid)
    if (!player || !player.alive) return

    player.x = x
    player.y = y
    player.z = z
    player.score = score
    player.level = level
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

    const dieBytes = encodeServerMessage({
      type: ServerMessageType.ROOM_PLAYER_DIED,
      uid,
    })

    const server = this.getServer()
    server.publish(`room:${code}`, dieBytes)

    const allDead = Array.from(room.players.values()).every(p => !p.alive)
    if (allDead) {
      room.status = "finished"

      const sorted = Array.from(room.players.values())
        .sort((a, b) => b.score - a.score)

      const rankings: RoomRankingEntry[] = sorted.map((p, i) => ({
        uid: p.uid,
        username: p.username,
        score: p.score,
        rank: i + 1,
      }))

      const overBytes = encodeServerMessage({
        type: ServerMessageType.ROOM_GAME_OVER,
        rankings,
      })
      server.publish(`room:${code}`, overBytes)
    }
  }

  getRoomCode(uid: string): string | null {
    return uidToRoom.get(uid) || null
  }

  getRoomPlayers(uid: string): RoomPlayerEntry[] | null {
    const code = uidToRoom.get(uid)
    if (!code) return null
    const room = rooms.get(code)
    if (!room) return null
    const players: RoomPlayerEntry[] = []
    for (const [, p] of room.players) {
      players.push({ uid: p.uid, username: p.username, isHost: p.isHost })
    }
    return players
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const roomService = new RoomService()
