# Rocket Rush Realtime Backend

An open-source, ultra-fast, high-concurrency backend for **Rocket Rush** built with **Bun.js**, **Redis**, and custom lightweight **Protocol Buffers (Protobuf)** over WebSockets.
(to scale vertically)

---

## Key Features

- **High Performance**: Powered by [Bun.js](https://bun.sh) for ultra-low latency WebSocket I/O and HTTP request handling.
- **Binary Protobuf Serialization**: Custom zero-dependency Protobuf binary encoder & decoder for minimal packet sizes and high throughput.
- **Weekly Rotating Leaderboard**: Redis Sorted Sets (`ZSET`) with automatic ISO week key generation (`rocket-rush:leaderboard:YYYY-Www`) and 14-day automatic TTL expiration.
- **Integrated Anti-Cheat Engine**:
  - Telemetry tick validation (verifies delta score vs. time elapsed).
  - Maximum plausible score verification against session duration.
  - Automatic session flagging for suspicious activity.
- **Realtime Pub/Sub Broadcasting**: Automatic WebSocket broadcasting of top 10 leaderboard updates to connected players upon score submission.
- **Modular & Extensible Architecture**: Clean separation of concerns designed for easy open-source contributions.

---

## Tech Stack

- **Runtime**: [Bun.js](https://bun.sh)
- **Database**: [Redis](https://redis.io) (Sorted Sets & Hashes)
- **Protocol**: Custom Binary Protobuf over WebSockets & HTTP
- **Language**: TypeScript (`strict` mode)

---

## Project Structure

```
rocket-rush-backend/
├── .env                    # Active environment variables (git-ignored)
├── .env.example            # Environment template file
├── README.md               # Project documentation & contribution guidelines
├── package.json            # Dependencies and npm scripts
├── index.ts                # Application entry point
├── protoCodec.ts           # Root re-export for backward compatibility
├── tsconfig.json           # TypeScript configuration
└── src/
    ├── config/
    │   └── index.ts        # Environment configuration & anti-cheat constants
    ├── handlers/
    │   ├── http.handler.ts # HTTP routing (/health, /leaderboard, WS upgrade)
    │   └── websocket.handler.ts # Binary WebSocket message handler & router
    ├── protocol/
    │   └── protoCodec.ts   # Binary Protobuf Reader/Writer & Encoders/Decoders
    ├── services/
    │   ├── leaderboard.service.ts # Redis leaderboard queries & week rotator
    │   └── session.service.ts     # Active gameplay session & anti-cheat engine
    ├── types/
    │   └── index.ts        # Shared TypeScript interfaces & types
    └── server.ts           # Bun server lifecycle & scheduled background tasks
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed (`v1.0.0` or higher)
- [Redis](https://redis.io) running locally or remotely (e.g. `redis://localhost:6379`)

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-repo/rocket-rush-backend.git
cd rocket-rush-backend
bun install
```

### 2. Environment Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Default configuration in `.env`:

```env
REDIS_URL=redis://localhost:6379
PORT=3000
LEADERBOARD_PREFIX=rocket-rush:leaderboard
KEY_USERNAMES=rocket-rush:usernames
WS_TOPIC=leaderboard
```

### 3. Running the Server

#### Development Mode (with hot reloading):
```bash
bun run dev
```

#### Production Mode:
```bash
bun run start
```

#### Type Check:
```bash
bun run typecheck
```

---

## API & Protocol Specification

### 1. HTTP Endpoints

| Method | Endpoint | Description | Response |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server health check endpoint | `"ok"` (200 OK) |
| `GET` | `/leaderboard` | Get current week's top 100 leaderboard | `{ leaderboard: [...], week: "..." }` |
| `GET` | `/` (or WS) | Default entry / WebSocket Upgrade | `101 Switching Protocols` or `200 OK` |

---

### 2. WebSocket Binary Protobuf Protocol

WebSockets communicate using binary Protobuf packets.

#### Client Messages (`ClientMessageType`)

| Type ID | Message Name | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `1` | `START_SESSION` | `wallet` (string), `username`? (string) | Starts a new tracked gameplay session |
| `2` | `GAME_TICK` | `sessionId`, `score`, `speed`, `level`, `timestamp` | Periodic client telemetry tick for anti-cheat validation |
| `3` | `SUBMIT_SCORE` | `sessionId`, `wallet`, `score`, `username`? | Submits final score at game over |
| `4` | `GET_LEADERBOARD` | `limit`? (number), `week`? (string) | Requests top leaderboard entries |

#### Server Messages (`ServerMessageType`)

| Type ID | Message Name | Parameters | Description |
| :--- | :--- | :--- | :--- |
| `1` | `SESSION_STARTED` | `sessionId` (string) | Returns newly generated session ID |
| `2` | `LEADERBOARD` | `week` (string), `entries` (Array) | Broadcasts top leaderboard ranks |
| `3` | `SCORE_SUBMITTED` | `score`, `rank`, `valid` (boolean) | Returns score submission result & rank |
| `4` | `ERROR` | `message` (string) | Error response packet |

---

## Contributing

We welcome community contributions! Please follow these standards when opening issues or pull requests:

1. **Fork & Branch**: Create a feature branch off `main` (`git checkout -b feature/my-feature`).
2. **Code Structure**: Follow modular domain structure under `src/` (`services/`, `handlers/`, `protocol/`, `config/`).
3. **Type Safety**: Ensure strict TypeScript compliance by running:
   ```bash
   bun run typecheck
   ```
4. **Pull Requests**: Provide clear descriptions of proposed changes and verify backwards compatibility with the Protobuf binary format.

---

## License

This project is licensed under the **MIT License**.
