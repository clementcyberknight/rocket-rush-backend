export class BinaryWriter {
  private buffer: Uint8Array;
  private offset: number = 0;

  constructor(initialSize = 256) {
    this.buffer = new Uint8Array(initialSize);
  }

  private ensureCapacity(needed: number) {
    if (this.offset + needed > this.buffer.length) {
      const next = new Uint8Array(Math.max(this.buffer.length * 2, this.offset + needed));
      next.set(this.buffer);
      this.buffer = next;
    }
  }

  writeTag(fieldNumber: number, wireType: number) {
    this.writeVarint((fieldNumber << 3) | wireType);
  }

  writeVarint(val: number) {
    this.ensureCapacity(10);
    let v = Math.floor(Math.abs(val));
    while (v >= 0x80) {
      this.buffer[this.offset++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buffer[this.offset++] = v & 0x7f;
  }

  writeString(fieldNumber: number, str: string) {
    if (!str) return;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    this.writeTag(fieldNumber, 2);
    this.writeVarint(bytes.length);
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  writeBytes(fieldNumber: number, bytes: Uint8Array) {
    if (!bytes || bytes.length === 0) return;
    this.writeTag(fieldNumber, 2);
    this.writeVarint(bytes.length);
    this.ensureCapacity(bytes.length);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.length;
  }

  writeDouble(fieldNumber: number, val: number) {
    this.writeTag(fieldNumber, 1);
    this.ensureCapacity(8);
    const dv = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 8);
    dv.setFloat64(0, val, true);
    this.offset += 8;
  }

  writeFloat(fieldNumber: number, val: number) {
    this.writeTag(fieldNumber, 5);
    this.ensureCapacity(4);
    const dv = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset, 4);
    dv.setFloat32(0, val, true);
    this.offset += 4;
  }

  writeUint32(fieldNumber: number, val: number) {
    if (val === 0) return;
    this.writeTag(fieldNumber, 0);
    this.writeVarint(val);
  }

  writeBool(fieldNumber: number, val: boolean) {
    this.writeTag(fieldNumber, 0);
    this.writeVarint(val ? 1 : 0);
  }

  finish(): Uint8Array {
    return this.buffer.subarray(0, this.offset);
  }
}

export class BinaryReader {
  private view: DataView;
  private offset: number = 0;
  private length: number;
  private decoder = new TextDecoder();

  constructor(buffer: ArrayBuffer | Uint8Array) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.byteLength;
  }

  hasMore(): boolean {
    return this.offset < this.length;
  }

  readTag(): { fieldNumber: number; wireType: number } | null {
    if (!this.hasMore()) return null;
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.length) {
      const b = this.view.getUint8(this.offset++);
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  readString(): string {
    const len = this.readVarint();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return this.decoder.decode(bytes);
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const start = this.view.byteOffset + this.offset;
    const bytes = new Uint8Array(this.view.buffer.slice(start, start + len));
    this.offset += len;
    return bytes;
  }

  readDouble(): number {
    const val = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return val;
  }

  readFloat(): number {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }

  skip(wireType: number) {
    if (wireType === 0) this.readVarint();
    else if (wireType === 1) this.offset += 8;
    else if (wireType === 2) {
      const len = this.readVarint();
      this.offset += len;
    } else if (wireType === 5) this.offset += 4;
  }
}

export enum ClientMessageType {
  START_SESSION = 1,
  GAME_TICK = 2,
  SUBMIT_SCORE = 3,
  GET_LEADERBOARD = 4,
  UPDATE_USERNAME = 5,
  MERGE_GUEST = 6,
  CHECK_USERNAME = 7,
  CREATE_ROOM = 8,
  JOIN_ROOM = 9,
  LEAVE_ROOM = 10,
  START_ROOM = 11,
  SPECTATE_TARGET = 12,
  PLAYER_MOVE = 13,
  RESET_ROOM_LOBBY = 14,
}

export type ClientMessagePayload =
  | { type: ClientMessageType.START_SESSION; wallet: string; username?: string }
  | { type: ClientMessageType.GAME_TICK; sessionId: string; score: number; speed: number; level: number; timestamp: number; x: number; y: number; z: number }
  | { type: ClientMessageType.SUBMIT_SCORE; sessionId: string; wallet: string; score: number; username?: string }
  | { type: ClientMessageType.GET_LEADERBOARD; limit?: number; week?: string }
  | { type: ClientMessageType.UPDATE_USERNAME; wallet: string; username: string }
  | { type: ClientMessageType.MERGE_GUEST; fromWallet: string; toWallet: string }
  | { type: ClientMessageType.CHECK_USERNAME; username: string; wallet: string }
  | { type: ClientMessageType.CREATE_ROOM; wallet?: string; username?: string }
  | { type: ClientMessageType.JOIN_ROOM; code: string; wallet?: string; username?: string }
  | { type: ClientMessageType.LEAVE_ROOM }
  | { type: ClientMessageType.START_ROOM }
  | { type: ClientMessageType.SPECTATE_TARGET; uid: string }
  | { type: ClientMessageType.PLAYER_MOVE; x: number; y: number; z: number; speed: number; score: number; level: number }
  | { type: ClientMessageType.RESET_ROOM_LOBBY };

export enum ServerMessageType {
  SESSION_STARTED = 1,
  LEADERBOARD = 2,
  SCORE_SUBMITTED = 3,
  ERROR = 4,
  USERNAME_UPDATED = 5,
  USERNAME_CHECKED = 6,
  ROOM_CREATED = 7,
  ROOM_JOINED = 8,
  ROOM_PLAYER_JOINED = 9,
  ROOM_PLAYER_LEFT = 10,
  ROOM_PLAYERS = 11,
  ROOM_COUNTDOWN = 12,
  ROOM_STARTED = 13,
  ROOM_PLAYER_DIED = 14,
  ROOM_GAME_OVER = 15,
  ROOM_ERROR = 16,
  ROOM_PLAYERS_COMPACT = 17,
  ROOM_CLOSED = 18,
  ROOM_RESET_LOBBY = 19,
}

export type LeaderboardEntry = {
  rank: number;
  wallet: string;
  username: string | null;
  score: number;
};

export type CompactPlayerState = {
  playerIndex: number
  alive: boolean
  x: number
  y: number
  z: number
  speed: number
  score: number
  level: number
  uid?: string
}

export type ServerMessagePayload =
  | { type: ServerMessageType.SESSION_STARTED; sessionId: string; uid: string; ghost?: Uint8Array }
  | { type: ServerMessageType.LEADERBOARD; week: string; entries: LeaderboardEntry[] }
  | { type: ServerMessageType.SCORE_SUBMITTED; score: number; rank: number; valid: boolean }
  | { type: ServerMessageType.ERROR; message: string }
  | { type: ServerMessageType.USERNAME_UPDATED; success: boolean; message: string; username?: string }
  | { type: ServerMessageType.USERNAME_CHECKED; available: boolean; error?: string }
  | { type: ServerMessageType.ROOM_CREATED; code: string; seed: number }
  | { type: ServerMessageType.ROOM_JOINED; code: string; seed: number; players: RoomPlayerEntry[] }
  | { type: ServerMessageType.ROOM_PLAYER_JOINED; uid: string; username: string | null }
  | { type: ServerMessageType.ROOM_PLAYER_LEFT; uid: string }
  | { type: ServerMessageType.ROOM_PLAYERS; players: RoomPlayerState[] }
  | { type: ServerMessageType.ROOM_COUNTDOWN; seconds: number }
  | { type: ServerMessageType.ROOM_STARTED }
  | { type: ServerMessageType.ROOM_PLAYER_DIED; uid: string }
  | { type: ServerMessageType.ROOM_GAME_OVER; rankings: RoomRankingEntry[] }
  | { type: ServerMessageType.ROOM_ERROR; message: string }
  | { type: ServerMessageType.ROOM_PLAYERS_COMPACT; players: CompactPlayerState[] }
  | { type: ServerMessageType.ROOM_CLOSED; reason?: string }
  | { type: ServerMessageType.ROOM_RESET_LOBBY; code: string; seed: number; players: RoomPlayerEntry[] };

export type RoomPlayerEntry = {
  uid: string
  username: string | null
  isHost: boolean
}

export type RoomPlayerState = {
  uid: string
  username: string | null
  x: number
  y: number
  z: number
  score: number
  alive: boolean
  level: number
}

export type RoomRankingEntry = {
  uid: string
  username: string | null
  score: number
  rank: number
}

export function encodeClientMessage(msg: ClientMessagePayload): Uint8Array {
  const outer = new BinaryWriter();
  outer.writeUint32(1, msg.type);

  const inner = new BinaryWriter();
  if (msg.type === ClientMessageType.START_SESSION) {
    inner.writeString(1, msg.wallet);
    if (msg.username) inner.writeString(2, msg.username);
  } else if (msg.type === ClientMessageType.GAME_TICK) {
    inner.writeString(1, msg.sessionId);
    inner.writeDouble(2, msg.score);
    inner.writeFloat(3, msg.speed);
    inner.writeUint32(4, msg.level);
    inner.writeDouble(5, msg.timestamp);
  } else if (msg.type === ClientMessageType.SUBMIT_SCORE) {
    inner.writeString(1, msg.sessionId);
    inner.writeString(2, msg.wallet);
    inner.writeDouble(3, msg.score);
    if (msg.username) inner.writeString(4, msg.username);
  } else if (msg.type === ClientMessageType.GET_LEADERBOARD) {
    if (msg.limit) inner.writeUint32(1, msg.limit);
    if (msg.week) inner.writeString(2, msg.week);
  } else if (msg.type === ClientMessageType.UPDATE_USERNAME) {
    inner.writeString(1, msg.wallet);
    inner.writeString(2, msg.username);
  } else if (msg.type === ClientMessageType.MERGE_GUEST) {
    inner.writeString(1, msg.fromWallet);
    inner.writeString(2, msg.toWallet);
  } else if (msg.type === ClientMessageType.CHECK_USERNAME) {
    inner.writeString(1, msg.username);
    inner.writeString(2, msg.wallet);
  }

  outer.writeBytes(2, inner.finish());
  return outer.finish();
}

export function decodeClientMessage(buffer: ArrayBuffer | Uint8Array): ClientMessagePayload | null {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength === 16 && bytes[0] === ClientMessageType.PLAYER_MOVE) {
      const move = decodePlayerMove(bytes);
      return {
        type: ClientMessageType.PLAYER_MOVE,
        ...move,
      };
    }

    const reader = new BinaryReader(bytes);
    let type: number = 0;
    let payloadBytes: Uint8Array | null = null;

    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.fieldNumber === 1 && tag.wireType === 0) type = reader.readVarint();
      else if (tag.fieldNumber === 2 && tag.wireType === 2) payloadBytes = reader.readBytes();
      else reader.skip(tag.wireType);
    }

    if (!type) return null;

    const inner = new BinaryReader(payloadBytes || new Uint8Array(0));

    if (type === ClientMessageType.START_SESSION) {
      let wallet = "";
      let username: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) wallet = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, wallet, username };
    } else if (type === ClientMessageType.GAME_TICK) {
      let sessionId = "", score = 0, speed = 0, level = 0, timestamp = 0, x = 0, y = 0, z = 0;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) sessionId = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 1) score = inner.readDouble();
        else if (tag.fieldNumber === 3 && tag.wireType === 5) speed = inner.readFloat();
        else if (tag.fieldNumber === 4 && tag.wireType === 0) level = inner.readVarint();
        else if (tag.fieldNumber === 5 && tag.wireType === 1) timestamp = inner.readDouble();
        else if (tag.fieldNumber === 6 && tag.wireType === 5) x = inner.readFloat();
        else if (tag.fieldNumber === 7 && tag.wireType === 5) y = inner.readFloat();
        else if (tag.fieldNumber === 8 && tag.wireType === 1) z = inner.readDouble();
        else inner.skip(tag.wireType);
      }
      return { type, sessionId, score, speed, level, timestamp, x, y, z };
    } else if (type === ClientMessageType.SUBMIT_SCORE) {
      let sessionId = "", wallet = "", score = 0, username: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) sessionId = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) wallet = inner.readString();
        else if (tag.fieldNumber === 3 && tag.wireType === 1) score = inner.readDouble();
        else if (tag.fieldNumber === 4 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, sessionId, wallet, score, username };
    } else if (type === ClientMessageType.GET_LEADERBOARD) {
      let limit: number | undefined, week: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 0) limit = inner.readVarint();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) week = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, limit, week };
    } else if (type === ClientMessageType.UPDATE_USERNAME) {
      let wallet = "", username = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) wallet = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, wallet, username };
    } else if (type === ClientMessageType.MERGE_GUEST) {
      let fromWallet = "", toWallet = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) fromWallet = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) toWallet = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, fromWallet, toWallet };
    } else if (type === ClientMessageType.CHECK_USERNAME) {
      let username = "", wallet = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) username = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) wallet = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, username, wallet };
    } else if (type === ClientMessageType.CREATE_ROOM) {
      let wallet: string | undefined, username: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) wallet = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, wallet, username };
    } else if (type === ClientMessageType.JOIN_ROOM) {
      let code = "", wallet: string | undefined, username: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) code = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) wallet = inner.readString();
        else if (tag.fieldNumber === 3 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, code, wallet, username };
    } else if (type === ClientMessageType.LEAVE_ROOM) {
      return { type };
    } else if (type === ClientMessageType.START_ROOM) {
      return { type };
    } else if (type === ClientMessageType.SPECTATE_TARGET) {
      let uid = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) uid = inner.readString();
        else inner.skip(tag.wireType);
      }
    } else if (type === ClientMessageType.RESET_ROOM_LOBBY) {
      return { type };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeServerMessage(msg: ServerMessagePayload): Uint8Array {
  const outer = new BinaryWriter();
  outer.writeUint32(1, msg.type);

  const inner = new BinaryWriter();
  if (msg.type === ServerMessageType.SESSION_STARTED) {
    inner.writeString(1, msg.sessionId);
    if (msg.uid) inner.writeString(2, msg.uid);
    if (msg.ghost) inner.writeBytes(3, msg.ghost);
  } else if (msg.type === ServerMessageType.LEADERBOARD) {
    inner.writeString(1, msg.week);
    for (const entry of msg.entries) {
      const item = new BinaryWriter();
      item.writeUint32(1, entry.rank);
      item.writeString(2, entry.wallet);
      if (entry.username) item.writeString(3, entry.username);
      item.writeDouble(4, entry.score);
      inner.writeBytes(2, item.finish());
    }
  } else if (msg.type === ServerMessageType.SCORE_SUBMITTED) {
    inner.writeDouble(1, msg.score);
    inner.writeUint32(2, msg.rank);
    inner.writeBool(3, msg.valid);
  } else if (msg.type === ServerMessageType.ERROR) {
    inner.writeString(1, msg.message);
  } else if (msg.type === ServerMessageType.USERNAME_UPDATED) {
    inner.writeBool(1, msg.success);
    inner.writeString(2, msg.message);
    if (msg.username) inner.writeString(3, msg.username);
  } else if (msg.type === ServerMessageType.USERNAME_CHECKED) {
    inner.writeBool(1, msg.available);
    if (msg.error) inner.writeString(2, msg.error);
  } else if (msg.type === ServerMessageType.ROOM_CREATED) {
    inner.writeString(1, msg.code);
    inner.writeUint32(2, msg.seed);
  } else if (msg.type === ServerMessageType.ROOM_JOINED) {
    inner.writeString(1, msg.code);
    inner.writeUint32(2, msg.seed);
    for (const p of msg.players) {
      const item = new BinaryWriter();
      item.writeString(1, p.uid);
      if (p.username) item.writeString(2, p.username);
      item.writeBool(3, p.isHost);
      inner.writeBytes(3, item.finish());
    }
  } else if (msg.type === ServerMessageType.ROOM_PLAYER_JOINED) {
    inner.writeString(1, msg.uid);
    if (msg.username) inner.writeString(2, msg.username);
  } else if (msg.type === ServerMessageType.ROOM_PLAYER_LEFT) {
    inner.writeString(1, msg.uid);
  } else if (msg.type === ServerMessageType.ROOM_PLAYERS) {
    for (const p of msg.players) {
      const item = new BinaryWriter();
      item.writeString(1, p.uid);
      if (p.username) item.writeString(2, p.username);
      item.writeFloat(3, p.x);
      item.writeFloat(4, p.y);
      item.writeDouble(5, p.z);
      item.writeDouble(6, p.score);
      item.writeBool(7, p.alive);
      item.writeUint32(8, p.level);
      inner.writeBytes(1, item.finish());
    }
  } else if (msg.type === ServerMessageType.ROOM_COUNTDOWN) {
    inner.writeUint32(1, msg.seconds);
  } else if (msg.type === ServerMessageType.ROOM_STARTED) {
  } else if (msg.type === ServerMessageType.ROOM_PLAYER_DIED) {
    inner.writeString(1, msg.uid);
  } else if (msg.type === ServerMessageType.ROOM_GAME_OVER) {
    for (const r of msg.rankings) {
      const item = new BinaryWriter();
      item.writeString(1, r.uid);
      if (r.username) item.writeString(2, r.username);
      item.writeDouble(3, r.score);
      item.writeUint32(4, r.rank);
      inner.writeBytes(1, item.finish());
    }
  } else if (msg.type === ServerMessageType.ROOM_ERROR) {
    inner.writeString(1, msg.message);
  } else if (msg.type === ServerMessageType.ROOM_PLAYERS_COMPACT) {
    return encodeRoomPlayersCompact(msg.players);
  } else if (msg.type === ServerMessageType.ROOM_CLOSED) {
    if (msg.reason) inner.writeString(1, msg.reason);
  } else if (msg.type === ServerMessageType.ROOM_RESET_LOBBY) {
    inner.writeString(1, msg.code);
    inner.writeUint32(2, msg.seed);
    for (const p of msg.players) {
      const item = new BinaryWriter();
      item.writeString(1, p.uid);
      if (p.username) item.writeString(2, p.username);
      item.writeBool(3, p.isHost);
      inner.writeBytes(3, item.finish());
    }
  }

  outer.writeBytes(2, inner.finish());
  return outer.finish();
}

export function decodeServerMessage(buffer: ArrayBuffer | Uint8Array): ServerMessagePayload | null {
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength >= 2 && bytes[0] === ServerMessageType.ROOM_PLAYERS_COMPACT) {
      const players = decodeRoomPlayersCompact(bytes);
      return {
        type: ServerMessageType.ROOM_PLAYERS_COMPACT,
        players,
      };
    }

    const reader = new BinaryReader(bytes);
    let type: number = 0;
    let payloadBytes: Uint8Array | null = null;

    while (reader.hasMore()) {
      const tag = reader.readTag();
      if (!tag) break;
      if (tag.fieldNumber === 1 && tag.wireType === 0) type = reader.readVarint();
      else if (tag.fieldNumber === 2 && tag.wireType === 2) payloadBytes = reader.readBytes();
      else reader.skip(tag.wireType);
    }

    if (!type) return null;

    const inner = new BinaryReader(payloadBytes || new Uint8Array(0));

    if (type === ServerMessageType.SESSION_STARTED) {
      let sessionId = "";
      let uid = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) sessionId = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) uid = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, sessionId, uid };
    } else if (type === ServerMessageType.LEADERBOARD) {
      let week = "";
      const entries: LeaderboardEntry[] = [];
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) week = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 2) {
          const itemBytes = inner.readBytes();
          const itemReader = new BinaryReader(itemBytes);
          let rank = 0, wallet = "", username: string | null = null, score = 0;
          while (itemReader.hasMore()) {
            const itag = itemReader.readTag();
            if (!itag) break;
            if (itag.fieldNumber === 1 && itag.wireType === 0) rank = itemReader.readVarint();
            else if (itag.fieldNumber === 2 && itag.wireType === 2) wallet = itemReader.readString();
            else if (itag.fieldNumber === 3 && itag.wireType === 2) username = itemReader.readString();
            else if (itag.fieldNumber === 4 && itag.wireType === 1) score = itemReader.readDouble();
            else itemReader.skip(itag.wireType);
          }
          entries.push({ rank, wallet, username, score });
        } else inner.skip(tag.wireType);
      }
      return { type, week, entries };
    } else if (type === ServerMessageType.SCORE_SUBMITTED) {
      let score = 0, rank = 0, valid = false;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 1) score = inner.readDouble();
        else if (tag.fieldNumber === 2 && tag.wireType === 0) rank = inner.readVarint();
        else if (tag.fieldNumber === 3 && tag.wireType === 0) valid = inner.readVarint() === 1;
        else inner.skip(tag.wireType);
      }
      return { type, score, rank, valid };
    } else if (type === ServerMessageType.ERROR) {
      let message = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) message = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, message };
    } else if (type === ServerMessageType.USERNAME_UPDATED) {
      let success = false, message = "", username: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 0) success = inner.readVarint() === 1;
        else if (tag.fieldNumber === 2 && tag.wireType === 2) message = inner.readString();
        else if (tag.fieldNumber === 3 && tag.wireType === 2) username = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, success, message, username };
    } else if (type === ServerMessageType.USERNAME_CHECKED) {
      let available = false, error: string | undefined;
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 0) available = inner.readVarint() === 1;
        else if (tag.fieldNumber === 2 && tag.wireType === 2) error = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, available, error };
    } else if (type === ServerMessageType.ROOM_CLOSED) {
      let reason = "";
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) reason = inner.readString();
        else inner.skip(tag.wireType);
      }
      return { type, reason };
    } else if (type === ServerMessageType.ROOM_RESET_LOBBY) {
      let code = "", seed = 0;
      const players: RoomPlayerEntry[] = [];
      while (inner.hasMore()) {
        const tag = inner.readTag();
        if (!tag) break;
        if (tag.fieldNumber === 1 && tag.wireType === 2) code = inner.readString();
        else if (tag.fieldNumber === 2 && tag.wireType === 0) seed = inner.readVarint();
        else if (tag.fieldNumber === 3 && tag.wireType === 2) {
          const itemBytes = inner.readBytes();
          const ir = new BinaryReader(itemBytes);
          let uid = "", username: string | null = null, isHost = false;
          while (ir.hasMore()) {
            const it = ir.readTag();
            if (!it) break;
            if (it.fieldNumber === 1 && it.wireType === 2) uid = ir.readString();
            else if (it.fieldNumber === 2 && it.wireType === 2) username = ir.readString();
            else if (it.fieldNumber === 3 && it.wireType === 0) isHost = ir.readVarint() === 1;
            else ir.skip(it.wireType);
          }
          players.push({ uid, username, isHost });
        } else inner.skip(tag.wireType);
      }
      return { type, code, seed, players };
    }
    return null;
  } catch {
    return null;
  }
}

export function encodePlayerMove(x: number, y: number, z: number, speed: number, score: number, level: number): Uint8Array {
  const buf = new Uint8Array(9);
  const dv = new DataView(buf.buffer, buf.byteOffset, 9);
  dv.setUint8(0, ClientMessageType.PLAYER_MOVE);
  dv.setInt16(1, Math.round(Math.max(-32768, Math.min(32767, x * 100))), true);
  dv.setUint8(3, Math.round(Math.max(0, Math.min(255, (y - 1.0) * 30))));
  dv.setFloat32(4, z, true);
  const speedQuant = Math.round(Math.max(0, Math.min(15, speed * 2.5)));
  const levelQuant = Math.max(0, Math.min(15, Math.floor(level)));
  dv.setUint8(8, (speedQuant << 4) | (levelQuant & 0x0F));
  return buf;
}

export function decodePlayerMove(bytes: Uint8Array): { x: number; y: number; z: number; speed: number; score: number; level: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const x = dv.getInt16(1, true) / 100;
  const y = 1.0 + (dv.getUint8(3) / 30);
  const z = dv.getFloat32(4, true);
  const packed = dv.getUint8(8);
  const speed = (packed >> 4) / 2.5;
  const level = packed & 0x0F;
  const score = Math.max(0, Math.abs(z) - 10);
  return { x, y, z, speed, score, level };
}

export function encodeRoomPlayersCompact(players: CompactPlayerState[]): Uint8Array {
  const count = players.length;
  const totalBytes = 2 + count * 8;
  const buf = new Uint8Array(totalBytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, totalBytes);
  dv.setUint8(0, ServerMessageType.ROOM_PLAYERS_COMPACT);
  dv.setUint8(1, count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 8;
    const p = players[i];
    if (!p) continue;
    const packed = ((p.alive ? 1 : 0) << 7) | ((Math.min(7, p.level) & 0x07) << 4) | (p.playerIndex & 0x0F);
    dv.setUint8(off, packed);
    dv.setInt16(off + 1, Math.round(Math.max(-32768, Math.min(32767, p.x * 100))), true);
    dv.setUint8(off + 3, Math.round(Math.max(0, Math.min(255, (p.y - 1.0) * 30))));
    dv.setFloat32(off + 4, p.z, true);
  }
  return buf;
}

export function decodeRoomPlayersCompact(bytes: Uint8Array): CompactPlayerState[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint8(1);
  const players: CompactPlayerState[] = [];
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 8;
    if (off + 8 > bytes.byteLength) break;
    const packed = dv.getUint8(off);
    const alive = (packed & 0x80) !== 0;
    const level = (packed >> 4) & 0x07;
    const playerIndex = packed & 0x0F;
    const x = dv.getInt16(off + 1, true) / 100;
    const y = 1.0 + (dv.getUint8(off + 3) / 30);
    const z = dv.getFloat32(off + 4, true);
    const score = Math.max(0, Math.abs(z) - 10);
    players.push({
      playerIndex,
      alive,
      x,
      y,
      z,
      speed: 1.0 + (level * 0.15),
      score,
      level,
    });
  }
  return players;
}


