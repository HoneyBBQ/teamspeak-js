<div align="center">

# @honeybbq/teamspeak

**A clean-room TeamSpeak client protocol library written in pure TypeScript.**

Works with TeamSpeak 3 and TeamSpeak 6 servers. No proprietary SDK, no copied code.

[![CI](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml/badge.svg)](https://github.com/honeybbq/teamspeak-js/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@honeybbq/teamspeak)](https://www.npmjs.com/package/@honeybbq/teamspeak)
[![npm beta](https://img.shields.io/npm/v/@honeybbq/teamspeak/beta?label=beta)](https://www.npmjs.com/package/@honeybbq/teamspeak?activeTab=versions)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/HoneyBBQ/teamspeak-js/badge)](https://scorecard.dev/viewer/?uri=github.com/HoneyBBQ/teamspeak-js)
[![Node Version](https://img.shields.io/node/v/@honeybbq/teamspeak)](https://github.com/HoneyBBQ/teamspeak-js/blob/main/package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/HoneyBBQ/teamspeak-js/blob/main/LICENSE)

</div>

**[API reference](https://honeybbq.github.io/teamspeak-js/)**

Upgrading from 0.x? The package was renamed; see the [migration guide](https://github.com/HoneyBBQ/teamspeak-js/blob/main/docs/migrating-to-1.0.md).

## Features

- **Full protocol handshake** — ECDH key exchange, RSA puzzle, EAX-encrypted transport
- **Command & notification system** — Send commands, receive server events
- **Event-driven API** — Register handlers for text messages, client enter/leave, channel moves, kicks, etc.
- **Voice data** — Send Opus voice packets (codec 4 & 5)
- **File transfers** — Upload, download, and delete files on the server
- **Address resolution** — SRV records, TSDNS, and direct addresses; server nicknames on request (`nicknameLookup: true`), since that lookup goes to named.myteamspeak.com
- **Middleware** — Pluggable command and event middleware chains
- **Built-in rate limiter** — Token-bucket throttling to prevent server-side flood kicks
- **Identity management** — Generate, import/export, and upgrade security level of identities
- **Full command set** — 111 typed functions covering every command the voice protocol answers
- **Reconnection** — Opt-in retry with backoff, tuned for TeamSpeak's antiflood ban
- **Server capabilities** — Reports the server version and the uid hash it uses (SHA-1 on TS3, SHA-256 on TS6), and the server's name, icon, banner and welcome message
- **Custom transports** — Supply your own socket, for proxies, tunnels or tests
- **ESM with types** — Ships ES modules with full TypeScript declarations
- **Zero native deps** — Pure TypeScript, no native addons required

## Installation

1.0 is in beta, published under the `beta` tag. A plain `npm install` still
gets 0.3, so ask for the beta:

```bash
npm install @honeybbq/teamspeak@beta
# or
pnpm add @honeybbq/teamspeak@beta
```

Everything in this README is the 1.0 API. You need Node.js 22.12 or newer.

## Quick Start

```typescript
import { Client, generateIdentity } from "@honeybbq/teamspeak/client";

// Generate a new identity (or load an existing one)
const identity = await generateIdentity(8);

// Create the client
const client = new Client(identity, "localhost", "TSBot", {
  serverPassword: process.env.TEAMSPEAK_SERVER_PASSWORD,
  defaultChannel: "Lobby",
  defaultChannelPassword: process.env.TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD,
});

// Register event handlers
client.on("connected", ({ reconnected }) => {
  console.log(reconnected ? "Reconnected to server!" : "Connected to server!");
});

client.on("textMessage", (msg) => {
  console.log(`[${msg.invokerName}]: ${msg.message}`);
});

client.on("disconnected", ({ error, willReconnect }) => {
  console.log("Disconnected:", error?.message ?? "clean", willReconnect ? "(reconnecting)" : "");
});

// Connect; resolves once the handshake completes.
await client.connect({ signal: AbortSignal.timeout(15_000) });

// Stay connected until interrupted
process.on("SIGINT", async () => {
  await client.disconnect();
});
```

## API Overview

### Client Lifecycle

| Method                                        | Description                                       |
| --------------------------------------------- | ------------------------------------------------- |
| `new Client(identity, addr, nickname, opts?)` | Create a new client                               |
| `connect({ signal? })`                        | Connect; resolves once the handshake completes    |
| `disconnect({ signal? })`                     | Leave the server and close the connection         |
| `status`                                      | `"disconnected"`, `"connecting"` or `"connected"` |
| `clientID`                                    | Our clid, assigned by the server                  |
| `channelID`                                   | The channel we are in                             |
| `serverCapabilities`                          | Server version, family and uid hash               |
| `uid`                                         | Our own uid, hashed as the server does            |

`connect()` rejects with an `InvalidAddressError` for an address that cannot be
one — no host, or a port outside 1–65535 — before anything starts; a host name
that does not resolve fails with a `TeamspeakError` whose `cause` is the lookup's
error. A `connect()` called while `disconnect()` is still saying goodbye waits
for it to finish, then connects.

Commands, raw `exec`/`execNoWait`, voice and whispers need a connected client:
until `connect()` resolves, and from the moment `disconnect()` begins, they fail
with a `NotConnectedError` and send nothing.

### Events

Name an event with an `EventName` constant, or with its string: the two are the
same, and the listener's payload type follows either.

```typescript
import { EventName } from "@honeybbq/teamspeak/client";

client.on(EventName.TextMessage, (message) => console.log(message.message));
client.on("textMessage", (message) => console.log(message.message)); // the same
```

| Method                                     | Description                                                    |
| ------------------------------------------ | -------------------------------------------------------------- |
| `on("connected", handler)`                 | Fires when fully connected (`ConnectedEvent`)                  |
| `on("disconnected", handler)`              | Fires on disconnect (`DisconnectedEvent`)                      |
| `on("textMessage", handler)`               | Fires on text messages                                         |
| `on("clientEnter", handler)`               | Fires when a client joins                                      |
| `on("clientLeave", handler)`               | Fires when a client leaves                                     |
| `on("clientMoved", handler)`               | Fires when a client moves channels                             |
| `on("clientUpdated", handler)`             | Fires when a client's properties change (`ClientUpdatedEvent`) |
| `on("clientServerGroupAdded", handler)`    | Fires when a client joins a server group                       |
| `on("clientServerGroupRemoved", handler)`  | Fires when a client leaves a server group                      |
| `on("clientChannelGroupChanged", handler)` | Fires when a client's channel group changes                    |
| `on("channelCreated", handler)`            | Fires when a channel is created                                |
| `on("channelEdited", handler)`             | Fires when a channel's properties are edited                   |
| `on("channelMoved", handler)`              | Fires when a channel is moved or reordered                     |
| `on("channelDeleted", handler)`            | Fires when a channel is deleted                                |
| `on("channelDescriptionChanged", handler)` | Fires when a channel's description changes                     |
| `on("channelPasswordChanged", handler)`    | Fires when a channel's password changes                        |
| `on("serverEdited", handler)`              | Fires when the server's settings are edited                    |
| `on("channelSubscribed", handler)`         | Fires when the bot is subscribed to a channel                  |
| `on("channelUnsubscribed", handler)`       | Fires when the bot is unsubscribed from a channel              |
| `on("pluginCommand", handler)`             | Fires on a plugin command (`sendPluginCommand`)                |
| `on("clientChatComposing", handler)`       | Fires when a client is typing a private message                |
| `on("kicked", handler)`                    | Fires when the bot is kicked                                   |
| `on("poked", handler)`                     | Fires when poked by a client                                   |
| `on("voiceData", handler)`                 | Fires on incoming voice data                                   |

`on()` and `once()` return a function that removes the listener, which is also
a `Disposable` (`using listener = client.on(...)`). Listeners run one at a
time, in the order their events arrived, so a listener may call the client and
await an answer. `disconnected` delivers `undefined` after `disconnect()`, and
the cause otherwise — a `ConnectionTimeoutError`, or a `RemovedError` for a kick, a ban
or a server stopping. `await using client = new Client(...)` disconnects when
the scope ends.

`connected` is delivered after `connect()` resolves, so a listener added right
after `await client.connect()` still hears it. `disconnect()` waits a second at
most for the server to acknowledge its goodbye, less if its `signal` aborts
sooner, and resolves once `disconnected` has been delivered. A `connect()` waits
for an earlier session's `disconnected` to be delivered before it starts, so no
listener or `events()` iterator of the new session hears the old one end.

A listener that throws does not stop the others: the event still reaches the
listeners after it, and the exception surfaces as an `uncaughtException`, as an
EventEmitter listener's would.

Voice is the exception to "every event in order": while more than 256
deliveries are waiting, voice frames are dropped (and counted in a warning at
most every ten seconds) rather than queued without bound.

`events(name, { signal })` is the same as an async iterator, buffering events
that arrive while the loop body runs. The buffer is unbounded (voice excepted,
as above), so stop iterating when you stop reading. Aborting `signal` stops
listening and makes the pending and later `next()` calls reject with the
signal's reason, as Node's `events.on` does; `break`ing out of the loop, or a
disconnect, ends it normally:

```typescript
for await (const msg of client.events("textMessage", { signal })) {
  await reply(msg);
}
```

`notification` is the catch-all: it delivers every notification the server
sends, as it arrived, the ones that also have a typed event among them, after
that event. It is how to reach one the SDK does not model; `NotificationName`
names the known ones:

```typescript
import { NotificationName } from "@honeybbq/teamspeak";

client.on("notification", (n) => {
  if (n.name === NotificationName.ChannelEdited) console.log(n.params);
});
```

### Commands

Every command the voice protocol answers is a typed function, grouped by area.
Each is addressed by branded ids, so a `ChannelID` cannot be passed where a
`ClientID` is meant. The constructors — `asChannelID(5)`, `asClientID(3)` and
the rest — throw a `RangeError` for anything but an integer in the id's wire
range: 0–65535 for a `ClientID` and the file transfer ids, 0–2^32−1 for a
`PermissionID` (an `IconID` also takes the signed form), 0–2^64−1 for the
`bigint` ids. Required arguments are positional; everything optional
goes in one options object, always the last argument, which also carries
`signal` and `timeoutMs` to abandon the command or bound how long it waits.

```typescript
import {
  listChannels,
  createChannel,
  moveClient,
  kickClient,
  sendChannelMessage,
  addServerGroupPermission,
  iterateClientDatabase,
  permissionByName,
  PermissionName,
  asClientID,
  Codec,
  Reason,
} from "@honeybbq/teamspeak";

const channels = await listChannels(client, { signal: AbortSignal.timeout(5_000) });

const cid = await createChannel(client, {
  name: "Lounge",
  topic: "the quiet one",
  codec: Codec.OpusVoice,
  isPermanent: true,
});

await moveClient(client, client.clientID, cid, { password: "channel-password" });
await sendChannelMessage(client, "hello");
await kickClient(client, someone, Reason.KickChannel, { reasonMessage: "take a break" });

await addServerGroupPermission(client, sgid, permissionByName(PermissionName.ClientTalkPower), 50, {
  skip: true,
});

for await (const entry of iterateClientDatabase(client)) {
  console.log(entry.nickname, entry.lastConnectedAt);
}
```

A command that sends content — `createChannel`'s channel, `editChannel`'s
settings, `updateClient`, `editClient`, `editClientDatabase`,
`addBan`'s `BanFields` — takes it as its own
argument, and `{ signal, timeoutMs }` as a separate one after it: set among the
content, they are not read.

Options objects use camelCase names (`maxClients` for `channel_maxclients`),
and only the fields you set are sent: an unset field leaves the setting alone,
while `""` sends it empty — `editChannel(client, cid, { password: "" })` clears
a password. A key an options type does not name is never sent. The exceptions
are `editServer` and `editInstance`, which take the raw `virtualserver_*` and
`serverinstance_*` properties as `getServerInfo` reports them; `PropertyName` names
the keys.

Results are camelCase too. Timestamps are `Date`s (`undefined` where the server
sends 0 for "never"), durations are milliseconds with an `Ms` suffix
(`idleTimeMs`, `durationMs`), and a permission is a `Permission`, built with
`permissionByID` or `permissionByName`. Small enumerations — `GroupType`,
`Codec`, `PrivilegeKeyType`, `LogLevel` and the rest — are objects of named values with
a type of the same name.

| Module       | Covers                                                         |
| ------------ | -------------------------------------------------------------- |
| `channels`   | Create, edit, move, delete, subscribe, channel permissions     |
| `clients`    | List, move, kick, poke, edit, the client database, permissions |
| `server`     | Server and instance settings, groups, temp passwords, bindings |
| `groups`     | Channel groups, the permission catalogue, privilege keys       |
| `moderation` | Bans, complaints, offline messages, text messages, the log     |
| `files`      | List, delete, rename, create directories, transfer negotiation |

Many of these commands are answered over the voice protocol with a
notification rather than data rows — `servergrouplist` with
`notifyservergrouplist`, `ftinitupload` with `notifystartupload` after the
command has already succeeded. The client pairs each answer with its command,
so this is invisible to callers; [docs/voice-protocol-responses.md](https://github.com/HoneyBBQ/teamspeak-js/blob/main/docs/voice-protocol-responses.md)
has the measured table. A refusal is always thrown, never returned as an empty
result. A list or find with nothing to report answers `[]`. A command that
exists to return something — `createChannel`'s id, `initFileUpload`'s key,
`getClientProperties`'s fields — throws a `NoDataError` when the server answers
without it, rather than returning an id of 0 or an empty object.

For anything outside the typed set, `client.exec(line, { signal?, timeoutMs? })`
sends a raw command line and resolves to the rows that answer it.

### File Transfers

`uploadFile` and `downloadFile` (from `@honeybbq/teamspeak/client`) negotiate the
transfer and move the bytes in one call, and `listFilesRecursive` (from the
package) lists a directory and everything under it, each entry with its full path:

```typescript
import { downloadFile, uploadFile } from "@honeybbq/teamspeak/client";
import { listFilesRecursive } from "@honeybbq/teamspeak";

await uploadFile(client, cid, "/docs/notes.txt", data);
const bytes = await downloadFile(client, cid, "/docs/notes.txt");
const tree = await listFilesRecursive(client, cid, "/", { maxDepth: 4 });
```

They work over a voice `Client`, and over a `QueryClient` on raw TCP or SSH when
passed the file transfer host as `{ host }`; WebQuery refuses every file command.
`downloadFile` takes `{ dest }` to stream into a `Writable` instead of holding
the file, and refuses a file over `maxSize` (256 MiB) in memory.

To control the two halves, negotiate with the `files` module, then move the bytes over TCP:

```typescript
import { Readable } from "node:stream";
import { initFileUpload } from "@honeybbq/teamspeak";

const info = await initFileUpload(client, cid, "/notes.txt", BigInt(data.length));
await client.uploadFileData(host, info, Readable.from([data]));
```

An upload does not replace a file already at the path unless passed
`{ overwrite: true }`.

| Function                                             | Description                       |
| ---------------------------------------------------- | --------------------------------- |
| `initFileUpload(client, ...)`                        | Negotiate an upload               |
| `initFileDownload(client, ...)`                      | Negotiate a download              |
| `client.uploadFileData(host, info, data, options?)`  | Transfer file data to the server  |
| `client.downloadFileData(host, info, out, options?)` | Receive file data from the server |

The transfer functions take `FileTransferOptions`:

| Option          | Description                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `signal`        | An `AbortSignal` that abandons the transfer; it rejects with the signal's reason                                                   |
| `socketFactory` | Opens the connection instead of a direct TCP dial, to route it through a proxy or tunnel                                           |
| `trace`         | Hooks called at each milestone of the transfer (`dialStart`, `dialDone`, `progress`, `done`, `failed`); none sees the transfer key |
| `idleTimeoutMs` | The longest, in milliseconds, a transfer may go without moving a byte, the key write included. Default 30 000; `0` disables it     |

A transfer that goes idle for `idleTimeoutMs` fails with a `FileTransferError`
whose `cause` is a `TimeoutError`, and its connection is destroyed. A download
that sends more bytes than the negotiated size, or ends short of it, fails with
a `FileTransferError` too; bytes past the announced size are never written.

### Identity

```typescript
import { generateIdentity, parseIdentity } from "@honeybbq/teamspeak/client";

// Generate a new identity with security level 8
const identity = await generateIdentity(8);

// Export to string for persistent storage
const exported = identity.export();

// Import from a previously exported string
const restored = parseIdentity(exported);

// Raise the security level (CPU-intensive). Identities are immutable: this
// returns a new one with the same key.
const stronger = await identity.upgradeToLevel(10, { signal });

// The unique identifier, hashed as a TS3 (sha1) or TS6 (sha256) server does
const uid = identity.uid("sha1");
```

The private key never leaves the identity except through `export()`:
`toString()`, `toJSON()` and `util.inspect()` describe it without the key.
`parseIdentity` takes exactly what `export()` writes — the key as canonical
base64 of at most 32 bytes, a colon, and a decimal offset that fits in 64 bits
— and throws an `InvalidIdentityError` for anything else.

### Options

```typescript
import { Client } from "@honeybbq/teamspeak/client";
import { consoleLogger } from "@honeybbq/teamspeak";

const client = new Client(identity, "ts.example.com", "Bot", {
  logger: consoleLogger, // silent unless set
  resolver: customResolver,
  commandMiddleware: [timing],
  eventMiddleware: [filterMiddleware],
  serverPassword: process.env.TEAMSPEAK_SERVER_PASSWORD,
  defaultChannel: "Lobby",
  defaultChannelPassword: process.env.TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD,
});
```

Address resolution — the built-in one or a custom `resolver` — has ten seconds
in all: the `signal` a resolver is given aborts then, and the client connects
to the address as given.

`commandMiddleware` wraps the typed commands: each middleware receives the
request (its command name and parameters) with its options and returns the
answering rows, so it can time, retry or answer a command itself. Raw `exec`
and `execNoWait` lines do not pass through it.

```typescript
import type { CommandMiddleware } from "@honeybbq/teamspeak";

const timing: CommandMiddleware = (next) => async (request, options) => {
  const started = Date.now();
  try {
    return await next(request, options);
  } finally {
    console.log(request.command, Date.now() - started, "ms");
  }
};
```

Connection auth options:

- `serverPassword`: plain-text server password; sent as the TeamSpeak protocol hash during `clientinit`
- `defaultChannel`: default channel name requested during `clientinit`
- `defaultChannelPassword`: plain-text password for `defaultChannel`; sent as the TeamSpeak protocol hash

### Client version

By default `clientinit` sends a recent Windows version. The `version` option
sends another, and `@honeybbq/teamspeak/versions` has one export for each
version that is known to work, named `<Platform>_<version>_<build>`:

```typescript
import { Client } from "@honeybbq/teamspeak/client";
import { Windows_3_6_2_1695203293 } from "@honeybbq/teamspeak/versions";

const client = new Client(identity, "ts.example.com", "Bot", {
  version: Windows_3_6_2_1695203293,
});
```

A `ClientVersion` is a platform, a version string and a signature, and only
the ones in that entry carry a signature a server accepts. A server refuses a
build below its configured minimum, so an old version fails to connect on a
server that has raised it. `new Client` throws when a field is empty or the
signature is not the base64 of 64 bytes. Importing `@honeybbq/teamspeak/client`
does not load the table; only the entry you import it from does.

### Tracing

`trace` takes hooks that are called at each milestone of the client's life, for timing, metrics, logs or a progress display. For each connection attempt, the one `connect()` starts and each one the reconnect loop makes, the milestones come in this order: `resolveStart`, `resolveDone`, `connectStart`, `connectDone`, `handshakeDone`, `sessionStart`, `welcomeDone`. An attempt that never gets a session ends with `attemptFailed` instead, which says in which phase (`"open"`, `"handshake"` or `"join"`) and why. When a session ends, `sessionEnd` is called with the cause (`undefined` after `disconnect()`), preceded on a `disconnect()` by `disconnectStart` and `disconnectDone`, which says whether the server acknowledged the goodbye. `reconnectScheduled` fires when the reconnect loop is about to wait for its next attempt, and `reconnectStopped` when it ends without a session. Every attempt ends with exactly one of `sessionStart` and `attemptFailed`, and every session with exactly one `sessionEnd`.

The infos carry what each milestone knows: the resolver's candidates, the local address, the RSA puzzle's level and how long it took, how many packets were sent again, the server's public key (to pin a server's identity), the nickname the server accepted, the server's `initserver` parameters without any secret, and where the client landed with how many channels and clients the welcome delivered. Durations are in milliseconds.

```ts
const client = new Client(identity, "ts.example.com", "Bot", {
  trace: {
    resolveDone: (i) => console.log(`resolved to ${i.target} in ${i.durationMs.toFixed(0)} ms`),
    handshakeDone: (i) =>
      console.log(`encrypted after ${i.durationMs.toFixed(0)} ms, ${i.resends} resends`),
    sessionStart: (i) => console.log(`joined as ${i.nickname} after ${i.durationMs.toFixed(0)} ms`),
    welcomeDone: (i) => console.log(`${i.channels} channels, ${i.clients} clients in view`),
    attemptFailed: (i) => console.log(`attempt ${i.attempt} failed while ${i.phase}:`, i.error),
    sessionEnd: (i) => console.log(`session over after ${(i.durationMs / 1000).toFixed(0)} s`),
    reconnectScheduled: (i) => console.log(`retry ${i.attempt} in ${i.delayMs} ms`),
  },
});
```

A file transfer has a trace of its own, given in the options of `uploadFileData`, `downloadFileData` and `dialFileTransfer` (and of the client's methods that forward to them): `dialStart`, `dialDone`, `progress` (at most once per 64 KiB, and once more at the end with the final count), then exactly one of `done` and `failed`, which names the stage (`"dial"` or `"transfer"`). The transfer key never appears in any of it.

The rules for a hook, in both traces:

- It runs synchronously, at the moment of the milestone, and the client waits for it. Keep it quick and hand slow work to your own task.
- What it returns is ignored. A promise it returns is not awaited.
- It must not call `connect()` or `disconnect()`. To give up on an attempt, abort the signal you passed to `connect()`; to leave once connected, call `disconnect()` from a `connected` listener.
- It may read `client.status`, `client.clientID` and the like. `sessionStart` runs before `connect()` resolves and before `connected` is delivered, and `sessionEnd` before `disconnected`.
- If it throws, or the promise it returns rejects, the error is reported the way a throwing event listener's is, as an uncaught exception, and the client carries on as if nothing happened.

The object is copied when the client is made (or the transfer call starts), so changing it afterwards has no effect.

### Diagnostics

The client logs nothing unless given a `logger`. For tracing, it publishes on
two [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels, which cost nothing without a subscriber:

- `honeybbq:teamspeak:command` (`commandChannel`), a tracing channel: `start`
  when a command is sent, `asyncEnd` when its answer arrives, `error` when it
  fails.
- `honeybbq:teamspeak:incoming` (`incomingChannel`): every command the server sends.

Both carry the command's name, never its parameters, which hold password hashes
and privilege keys.

### Reconnection

Off by default: a silent reconnect makes an outage look like a healthy session.
An explicit `disconnect()` never reconnects, whatever the policy says.

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  reconnect: {
    backoff: { initialDelayMs: 1_000, maxDelayMs: 60_000, factor: 2, jitter: 0.2 },
    // Optional: decide for yourself which failures are worth retrying.
    shouldRetry: (err, attempt) => attempt < 10,
  },
});
```

The defaults are conservative because TeamSpeak **bans an IP after roughly
three rapid connects** — a retry loop without a delay bans itself, and the ban
outlasts the outage it was recovering from. Recovery is also not instant even
when it succeeds: the server holds the dropped session for a while and refuses a
reconnect with `521 too many clones already connected` until it reaps it, so the
loop keeps trying rather than giving up on the first refusal. It stops once a
`connect()` of your own has connected the client, and it does not retry an
address that cannot be one (`InvalidAddressError`).

### Custom transports

`fileTransferSocketFactory` and `socketFactory` are the only seams into the
network layer. Without them the SDK always creates its own sockets, so an
application running behind a proxy has no way through. `socketFactory` returns
a `DatagramSocket` — a `node:dgram` socket, or anything with the few methods
it names — and `fileTransferSocketFactory` any `Duplex` stream, such as the
socket a SOCKS library returns.

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  // UDP, for the voice and command channel.
  socketFactory: (family) => createSocket(family === 6 ? "udp6" : "udp4"),
  // TCP, dialled separately by each file transfer.
  fileTransferSocketFactory: (host, port) => createConnection({ host, port }),
});
```

### Server capabilities

```typescript
const caps = client.serverCapabilities;
// {
//   version: "6.0.0-beta13.1 [Build: 1790080330]", major: 6, family: "ts6",
//   uidAlgorithm: "sha256", name: "TeamSpeak 6 Server", iconID: undefined,
//   hostBannerImageURL: undefined, welcomeMessage: "…"
// }
```

Read from `initserver` during the handshake, so it costs no extra round trip.
The uid hash matters because TS3 hashes a client's public key with SHA-1 and TS6
with SHA-256 — a client that assumes either one computes an identifier the other
server never sends.

## ServerQuery

The `@experimental` subpath `@honeybbq/teamspeak/query` administers a server
the way the voice protocol cannot: the same typed commands the core exports,
plus the ones only an administrator may run, over the three transports a
ServerQuery speaks.

| Transport | Where                       | Server           | Login             | Notifications |
| --------- | --------------------------- | ---------------- | ----------------- | ------------- |
| `tcp`     | 10011                       | TeamSpeak 3 only | `transport.login` | yes           |
| `ssh`     | 10022                       | both             | the SSH login     | yes           |
| `web`     | 10080 (HTTP), 10443 (HTTPS) | both             | the api key       | **no**        |

TeamSpeak 3 (3.12 and later for WebQuery, 3.3 and later for SSH) serves SSH and
WebQuery as well as raw TCP, but only the raw port is on until
`query_protocols` lists the others; the official Docker image takes it as
`TS3SERVER_QUERY_PROTOCOLS=raw,ssh,http`. TeamSpeak 6 has no raw port. Its
WebQuery also answers a request with no api key as a guest; TeamSpeak 3 refuses
one.

WebQuery is reached over `http:` or `https:`, by the scheme of `url`. TeamSpeak 3
serves HTTPS on 10443 once `query_protocols` lists `https` and
`query_https_certificate_file` and `query_https_private_key_file` are set. The
built-in `fetch` verifies the certificate against the trust store Node uses and
never skips that. A certificate from a private CA, or a self-signed one, is
trusted by starting Node with `NODE_EXTRA_CA_CERTS=ca.pem`, or by a `fetch`
that trusts the CA:

```typescript
import { readFileSync } from "node:fs";
import { Agent, request } from "node:https";

const agent = new Agent({ ca: readFileSync("ca.pem") });
const trusting = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers as never, agent },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body as string);
  })) as typeof fetch;

new QueryClient({
  transport: { kind: "web", url: "https://ts.example.com:10443", apiKey, fetch: trusting },
});
```

Only raw TCP and SSH carry notifications: the server pushes them down the same
connection. WebQuery has no session to push to and refuses to register, so the
client never tries, and a listener for a server event there throws rather than
sitting silent. `connected` and `disconnected` work on every transport, since
they come from the client itself.

```typescript
import { QueryClient } from "@honeybbq/teamspeak/query";
import { listChannels } from "@honeybbq/teamspeak";

const client = new QueryClient({
  transport: {
    kind: "tcp", // 10011
    host: "ts.example.com",
    login: { name: "serveradmin", password: process.env.QUERY_PASSWORD! },
  },
  server: { id: 1 },
  nickname: "bot",
  events: { categories: ["textserver", "textprivate"] },
  reconnect: { backoff: { initialDelayMs: 1_000 } },
});

client.on("textMessage", (message) => console.log(message.invokerName, message.message));

await client.connect();

for (const channel of await listChannels(client)) console.log(channel.name);

await client.disconnect();
```

The three transports are figures of speech the client rebuilds on every
connection, which is what makes reconnecting possible; `custom` opens one
itself, for a proxy, a tunnel or a test. Each built-in transport also offers
the seam into its own connection — `connect` for `tcp`, returning a `Duplex`,
and `connection` for `ssh`, taking a client or a factory for one — so an
application behind a TLS terminator or a SOCKS proxy, or one that already
holds an SSH client, can supply it. `ssh2` is an optional peer dependency:
without it the other two transports still work, and an `ssh` transport throws
a `MissingDependencyError` naming the package.

A query client delivers the events its categories carry: `serverEdited` comes
under `server`; the channel events, `clientEnter`, `clientLeave` and
`clientMoved` under `channel`; and `textMessage` under the three text
categories. `QueryEventsOption` has the table. The voice client's events about
clients' updates, group changes, subscriptions, plugin commands and typing are
not sent to a ServerQuery connection by TeamSpeak 3 or by TeamSpeak 6 over SSH,
so the query client does not offer them.

`serverFamily` reports which generation the server is, read from its own
`version` answer, and `transport` reads back the live connection for metrics.

### SSH host keys

The `ssh` transport checks the server's host key before it sends the login, and
there is no default for how: the login is a credential, normally
`serveradmin`'s, and a client that accepts any key hands it to whatever answers
the port. Give exactly one of these, or the client refuses to be built, naming
all three:

```typescript
const client = new QueryClient({
  transport: {
    kind: "ssh",
    host: "ts.example.com",
    username: "serveradmin",
    password: process.env.QUERY_PASSWORD!,
    knownHosts: "/etc/ssh/ssh_known_hosts",
  },
});
```

- `knownHosts`: the path of an OpenSSH `known_hosts` file, read each time a
  connection is attempted and never found on its own: `~/.ssh/known_hosts` is
  used only if you name it. The check is `StrictHostKeyChecking=yes`: a host the
  file does not mention is refused, so is one recorded with another key, and so
  is a key a `@revoked` line names. Plain, `[host]:port` and hashed
  (`ssh-keygen -H`) entries are read. The query port is not 22, so record it as
  `ssh-keyscan -p 10022 ts.example.com`, which writes `[ts.example.com]:10022`;
  an entry for port 22 does not vouch for 10022.
- `hostKey`: your own check, `(key) => void`, that throws to refuse. `key` has
  the host, port, `keyType`, the key's bytes and its `fingerprint`, the
  `SHA256:…` that `ssh-keygen -lf` prints. It has to be synchronous and return
  nothing: a returned value, a `false` included, or a promise is refused rather
  than guessed at.
- `insecureIgnoreHostKey: true`: accept any key. It gives up what the host key
  is for, and is for a test or a throwaway server.

A key that is refused fails the connection with an `SshHostKeyError`, whose
`cause` says why, and nothing was sent: the password has not left the process.
Reconnection does not retry it. A connection you supply yourself through
`connection` is checked by whoever made it, so these options are refused there.

**`@experimental`**: this entry point is new, and its API may change in a
minor release — the options, the transport union and the event map are all
still settling. Pin a version and read the changelog if you depend on it.

## Compatibility

The package follows semver from 1.0. A few sets are open by nature and may
gain members in a minor release: the events (`EventMap`, `ServerEventName`),
`ClientStatus`, `ServerFamily`, `UIDAlgorithm`, `ErrorCode`, `Reason` and the
enumeration tables. Write a `switch` over any of them with a default case. A
field the server sends as a number that one of those tables names — a codec, a
text message's target mode, a group type — is a plain `number`, since a server
may send a value newer than the table.

`DatagramSocket` describes the part of a socket the client uses; should a
later release use more, the new members will be optional.

### Supported environments

| Environment | Supported                                                                      |
| ----------- | ------------------------------------------------------------------------------ |
| Node.js     | The active and maintenance LTS releases, from 22.12; CI tests 22.12, 24 and 26 |
| TypeScript  | 5.2 and newer, for the published types                                         |
| Modules     | ESM only                                                                       |

When a Node.js release reaches end of life, a minor release may raise
`engines.node` past it; that is not a breaking change. The published types use
`Disposable`, so the `lib` option must include `esnext.disposable` (or `es2026`
or `esnext`), and the subpath exports need `moduleResolution` set to `node16`,
`nodenext` or `bundler`. CI type-checks a consumer of the packed package with
TypeScript 5.2. Raising that minimum follows TypeScript's own support window,
happens in a minor release, and comes with a changelog note.

### Differences from the Go SDK

The [Go SDK](https://github.com/honeybbq/teamspeak-go) makes the same calls
with the same semantics, apart from what the languages make differ:

- Backoff fields: JavaScript takes `undefined` as "the default" and `0` as 0.
  Go cannot tell an unset field from 0, so there a zero field takes the default
  and a negative jitter disables it.
- A listener that throws: here the exception is rethrown from a microtask, an
  uncaught exception as an EventEmitter listener's would be, and the other
  listeners still get the event. Go recovers a panicking handler, logs it at
  Error, and keeps delivering.
- Durations are milliseconds with an `Ms` suffix here, `time.Duration` in Go;
  `listClients`' `uid` flag (on by default) is Go's `OmitUID`.

## Entry points

| Import from                    | What it is                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@honeybbq/teamspeak`          | What every TeamSpeak connection shares: the command language, ids, errors, the typed commands, the event types and the status and reconnection types |
| `@honeybbq/teamspeak/client`   | The voice client, identities, file transfers, diagnostics and its retry policy                                                                       |
| `@honeybbq/teamspeak/versions` | Client versions a server accepts, for the client's `version` option; data only, one export each                                                      |
| `@honeybbq/teamspeak/query`    | The ServerQuery client, running the same typed commands over raw TCP, SSH or WebQuery; `@experimental`                                               |

Each entry exports only its own symbols. The client entry does not re-export
the core, so a program imports the `Client` from `@honeybbq/teamspeak/client`
and the typed commands, ids and errors from `@honeybbq/teamspeak`.

The protocol internals (crypto, handshake, transport) are not exported. They
change with the protocol, and exporting them would have made every change a
breaking one.

`@honeybbq/teamspeak-client` and `@honeybbq/teamspeak-core` are deprecated and
get no further releases. Coming from 0.x? The
[migration guide](https://github.com/HoneyBBQ/teamspeak-js/blob/main/docs/migrating-to-1.0.md) lists every change.

## Architecture

```
src/
├── core/              # Shared: command language, ids, errors, typed commands
├── client/            # The voice client (@honeybbq/teamspeak/client)
│   ├── client.ts          # Client lifecycle, connection management
│   ├── commands.ts        # Command sending and response tracking
│   ├── api/voice.ts       # Commands only the voice protocol has
│   ├── capabilities.ts    # Server version and uid hash detection
│   ├── reconnect.ts       # Backoff policy and permanent-failure detection
│   ├── events.ts          # Event handler registration and middleware
│   ├── notifications.ts   # Server notification parsing and dispatch
│   ├── handshake.ts       # Protocol handshake orchestration
│   ├── transfer.ts        # File transfer data connections
│   ├── throttle.ts        # Token-bucket rate limiter
│   ├── crypto/            # ECDH, EAX encryption, identity management
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packet framing, ACK, compression
│   └── discovery/         # SRV / TSDNS / direct address resolution
└── query/             # ServerQuery client (not exported yet)
examples/
└── connect.ts  # Minimal connection example
```

## Related

- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — The original Go implementation this library is ported from

## Acknowledgments

Protocol knowledge was primarily informed by the [TSLib](https://github.com/Splamy/TS3AudioBot) implementation in [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) by Splamy. Huge thanks to the TS3AudioBot project and its contributors.

## Disclaimer

TeamSpeak is a registered trademark of [TeamSpeak Systems GmbH](https://teamspeak.com/). This project is not affiliated with, endorsed by, or associated with TeamSpeak Systems GmbH in any way.

This library is a **clean-room implementation** developed from publicly available documentation, protocol analysis of network traffic, and independent research. No proprietary TeamSpeak SDK code, headers, or libraries were used in its creation.

## Contributing

See [CONTRIBUTING.md](https://github.com/HoneyBBQ/teamspeak-js/blob/main/.github/CONTRIBUTING.md) for setup, checks and the integration suite.

## License

[MIT](https://github.com/HoneyBBQ/teamspeak-js/blob/main/LICENSE)
