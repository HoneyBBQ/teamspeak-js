<div align="center">

# @honeybbq/teamspeak

**A clean-room TeamSpeak client protocol library written in pure TypeScript.**

Compatible with TeamSpeak 3, 5 & 6. No proprietary SDK. No copy-pasted code.

[![CI](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml/badge.svg)](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@honeybbq/teamspeak)](https://www.npmjs.com/package/@honeybbq/teamspeak)
[![Node Version](https://img.shields.io/node/v/@honeybbq/teamspeak)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

## Features

- **Full protocol handshake** — ECDH key exchange, RSA puzzle, EAX-encrypted transport
- **Command & notification system** — Send commands, receive server events
- **Event-driven API** — Register handlers for text messages, client enter/leave, channel moves, kicks, etc.
- **Voice data** — Send Opus voice packets (codec 4 & 5)
- **File transfers** — Upload, download, and delete files on the server
- **Address resolution** — SRV records, TSDNS, and direct address support
- **Middleware** — Pluggable command and event middleware chains
- **Built-in rate limiter** — Token-bucket throttling to prevent server-side flood kicks
- **Identity management** — Generate, import/export, and upgrade security level of identities
- **Dual format** — Ships ESM and CJS with full TypeScript declarations
- **Zero native deps** — Pure TypeScript, no native addons required

## Installation

```bash
npm install @honeybbq/teamspeak
# or
pnpm add @honeybbq/teamspeak
```

Requires **Node.js 20.19** or later.

## Quick Start

```typescript
import { Client, generateIdentity } from "@honeybbq/teamspeak";

// Generate a new identity (or load an existing one)
const identity = generateIdentity(8);

// Create the client
const client = new Client(identity, "localhost", "TSBot");

// Register event handlers
client.on("connected", () => {
  console.log("Connected to server!");
});

client.on("textMessage", (msg) => {
  console.log(`[${msg.invokerName}]: ${msg.message}`);
});

client.on("disconnected", (err) => {
  console.log("Disconnected:", err?.message ?? "clean");
});

// Connect
await client.connect();

// Wait until connected (with 15s timeout)
await client.waitConnected(AbortSignal.timeout(15_000));

// Stay connected until interrupted
process.on("SIGINT", async () => {
  await client.disconnect();
});
```

## API Overview

### Client Lifecycle

| Method                                        | Description                         |
| --------------------------------------------- | ----------------------------------- |
| `new Client(identity, addr, nickname, opts?)` | Create a new client                 |
| `connect()`                                   | Initiate connection to the server   |
| `waitConnected(signal?)`                      | Block until the handshake completes |
| `disconnect()`                                | Gracefully disconnect               |

### Events

| Method                        | Description                        |
| ----------------------------- | ---------------------------------- |
| `on("connected", handler)`    | Fires when fully connected         |
| `on("disconnected", handler)` | Fires on disconnect                |
| `on("textMessage", handler)`  | Fires on text messages             |
| `on("clientEnter", handler)`  | Fires when a client joins          |
| `on("clientLeave", handler)`  | Fires when a client leaves         |
| `on("clientMoved", handler)`  | Fires when a client moves channels |
| `on("kicked", handler)`       | Fires when the bot is kicked       |
| `on("poke", handler)`         | Fires when poked by a client       |
| `on("voice", handler)`        | Fires on incoming voice data       |

### Commands

| Function                                             | Description                                |
| ---------------------------------------------------- | ------------------------------------------ |
| `sendTextMessage(client, targetMode, targetID, msg)` | Send a text message                        |
| `clientMove(client, clid, channelID, password?)`     | Move a client to a channel                 |
| `poke(client, clid, message)`                        | Poke a client                              |
| `client.sendVoice(data, codec)`                      | Send Opus voice data                       |
| `listChannels(client)`                               | List all channels                          |
| `listClients(client)`                                | List all connected clients                 |
| `getClientInfo(client, clid)`                        | Get detailed client information            |
| `client.execCommand(cmd, timeout?)`                  | Execute a raw command                      |
| `client.execCommandWithResponse(cmd, timeout?)`      | Execute a command and return response data |

### File Transfers

| Function                               | Description                       |
| -------------------------------------- | --------------------------------- |
| `client.fileTransferInitUpload(...)`   | Initialize a file upload          |
| `client.fileTransferInitDownload(...)` | Initialize a file download        |
| `fileTransferDeleteFile(client, ...)`  | Delete files on the server        |
| `uploadFileData(host, info, reader)`   | Transfer file data to the server  |
| `downloadFileData(host, info, writer)` | Receive file data from the server |

### Identity

```typescript
import { generateIdentity, identityFromString } from "@honeybbq/teamspeak";

// Generate a new identity with security level 8
const identity = generateIdentity(8);

// Export to string for persistent storage
const exported = identity.exportString();

// Import from a previously exported string
const restored = identityFromString(exported);

// Upgrade security level (CPU-intensive)
identity.upgradeToLevel(10);
```

### Options

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  logger: consoleLogger,
  resolver: customResolver,
  commandMiddleware: [loggingMiddleware],
  eventMiddleware: [filterMiddleware],
});
```

## Subpath Exports

The package provides granular subpath exports for advanced use cases:

```typescript
import { Identity } from "@honeybbq/teamspeak/crypto";
import { Resolver } from "@honeybbq/teamspeak/discovery";
import { PacketHandler } from "@honeybbq/teamspeak/transport";
import { buildCommand, parseCommand } from "@honeybbq/teamspeak/command";
import { processInit1 } from "@honeybbq/teamspeak/handshake";
```

## Architecture

```
teamspeak-js/
├── src/
│   ├── client.ts          # Client lifecycle, connection management
│   ├── api.ts             # High-level API (messages, channels, clients)
│   ├── commands.ts        # Command sending and response tracking
│   ├── events.ts          # Event handler registration and middleware
│   ├── notifications.ts   # Server notification parsing and dispatch
│   ├── handshake.ts       # Protocol handshake orchestration
│   ├── transfer.ts        # File transfer operations
│   ├── throttle.ts        # Token-bucket rate limiter
│   ├── types.ts           # Public type definitions
│   ├── errors.ts          # Error classes
│   ├── crypto/            # ECDH, EAX encryption, identity management
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packet framing, ACK, compression
│   ├── command/           # Command builder and parser
│   └── discovery/         # SRV / TSDNS / direct address resolution
├── examples/
│   └── connect.ts         # Minimal connection example
├── vite.config.ts         # Build configuration (Vite library mode)
└── tsconfig.json
```

## Related

- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — The original Go implementation this library is ported from

## Acknowledgments

Protocol knowledge was primarily informed by the [TSLib](https://github.com/Splamy/TS3AudioBot) implementation in [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) by Splamy. Huge thanks to the TS3AudioBot project and its contributors.

## Disclaimer

TeamSpeak is a registered trademark of [TeamSpeak Systems GmbH](https://teamspeak.com/). This project is not affiliated with, endorsed by, or associated with TeamSpeak Systems GmbH in any way.

This library is a **clean-room implementation** developed from publicly available documentation, protocol analysis of network traffic, and independent research. No proprietary TeamSpeak SDK code, headers, or libraries were used in its creation.

## License

[MIT](LICENSE)
