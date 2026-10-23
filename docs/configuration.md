# Configuration

Options for the client, and what to do with the connection around it: the client version it presents, tracing and diagnostics, reconnection, custom transports and what the server reports about itself.

## Options

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

## Client version

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

## Tracing

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

## Diagnostics

The client logs nothing unless given a `logger`. For tracing, it publishes on
two [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels, which cost nothing without a subscriber:

- `honeybbq:teamspeak:command` (`commandChannel`), a tracing channel: `start`
  when a command is sent, `asyncEnd` when its answer arrives, `error` when it
  fails.
- `honeybbq:teamspeak:incoming` (`incomingChannel`): every command the server sends.

Both carry the command's name, never its parameters, which hold password hashes
and privilege keys.

## Reconnection

Off by default: a silent reconnect makes an outage look like a healthy session.
An explicit `disconnect()` never reconnects, whatever the policy says.

```typescript
const client = new Client(identity, "ts.example.com", "Bot", {
  reconnect: {
    backoff: {
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      factor: 2,
      jitter: 0.2,
    },
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

## Custom transports

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

## Server capabilities

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
