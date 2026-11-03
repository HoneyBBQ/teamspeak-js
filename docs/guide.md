# Guide

How to connect, handle events, send commands, move files and manage an identity. The [configuration](configuration.md) page covers the options, [streams](streams.md) the TeamSpeak 6 screen share and [serverquery](serverquery.md) the administration client.

## Client Lifecycle

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
| `roundTrip`                                   | Keepalive round trip, once a pong has come back   |

`roundTrip` is the keepalive ping/pong round trip of the voice connection, the
mean and standard deviation over the last 10 pongs; the first comes about 5
seconds after connecting, and a reconnect starts over. It is the ping this client
reports when the server asks, and other clients see it as it was then, not as it
is now.

`connect()` rejects with an `InvalidAddressError` for an address that cannot be
one — no host, or a port outside 1–65535 — before anything starts; a host name
that does not resolve fails with a `TeamspeakError` whose `cause` is the lookup's
error. A `connect()` called while `disconnect()` is still saying goodbye waits
for it to finish, then connects.

Commands, raw `exec`/`execNoWait`, voice and whispers need a connected client:
until `connect()` resolves, and from the moment `disconnect()` begins, they fail
with a `NotConnectedError` and send nothing.

## Events

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
most every ten seconds) rather than queued without bound. See
[Receiving voice](#receiving-voice).

`events(name, { signal })` is the same as an async iterator, buffering events
that arrive while the loop body runs. The buffer is unbounded (voice excepted,
see [Receiving voice](#receiving-voice)), so stop iterating when you stop
reading. Aborting `signal` stops listening and makes the pending and later
`next()` calls reject with the signal's reason, as Node's `events.on` does;
`break`ing out of the loop, or a disconnect, ends it normally:

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

## Receiving voice

Take voice with the `events("voiceData")` iterator: it has a buffer of its own,
so a slow consumer costs only its own frames, and each consumer reads at its
own pace.

```typescript
for await (const v of client.events("voiceData", { signal })) {
  if (v.data.length === 0) {
    endSpeech(v.session, v.clientID, v.whisper); // the speaker stopped
    continue;
  }
  jitterBuffer(v.session, v.clientID, v.whisper).push(v.seq, v.codec, v.data, v.receivedAt);
}
```

A `VoiceDataEvent` has:

- `session`: `client.session` when the packet arrived. It starts at 1 and goes
  up with every connect and reconnect. A client id names a client only within
  one session, so when `session` changes, start every per-speaker state over.
- `clientID`: who is speaking.
- `whisper`: the packet type was VoiceWhisper. A speaker's whispers and its
  other voice count `seq` separately, and `whisper` is all a receiver learns
  about a whisper, not who it was for.
- `seq`: the speaker's own packet counter, which the server relays unchanged.
  It goes up by one for each packet the speaker sends, wraps from 65535 to 0,
  and is chosen by the speaker, so bound any wait or buffer it drives. Compare
  two with `((a - b) << 16 >> 16)`, a signed 16-bit difference, never `a < b`.
  The network and the server can reorder packets, and they are delivered as they
  arrived: put them in order yourself.
- `receivedAt`: when the datagram was read from the socket, in
  `performance.now()` milliseconds, a monotonic clock. It is the arrival time
  for de-jittering; the packet carries no time of its own.
- `codec` and `data`: one encoded frame, copied. The codec can change from one
  packet to the next. An empty `data` is the end of that speaker's speech by
  convention; the packet can be lost like any other, so do not rely on it alone.

Reorder by (`session`, `clientID`, `whisper`) and then by `seq`. A client that
connects again gets another client id and counts `seq` from 0.

The iterator buffers at most 256 frames. When it is full, each new frame drops
the **oldest** buffered one, since live audio is worth most when it is newest,
and `iterator.dropped` counts the frames it has dropped. A listener added with
`on("voiceData")` that falls behind loses frames before they are built, once
more than 256 deliveries are waiting; that is logged as a warning at most every
ten seconds, with the number dropped since the last one.

### What the server relays

The server decides whose voice reaches whom, and drops the rest without an
error. Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0-beta13.1:

- A speaker's voice to its channel is relayed while it may talk there: its
  `isTalker` is set, or its talk power is at least the channel's needed talk
  power. Being a priority speaker does not change that. A whisper does not need
  talk power.
- Neither is relayed while the speaker is away, input-muted, or without input
  hardware, as it last told the server with `updateClient`. A bot that sets
  `isAway` is not heard.
- A listener gets neither while it is output-muted or without output hardware.
  Being away or input-muted does not stop it hearing.
- Voice reaches only the clients in the channel. Subscribing to another channel
  shows its clients, not its voice.

## Commands

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

const channels = await listChannels(client, {
  signal: AbortSignal.timeout(5_000),
});

const cid = await createChannel(client, {
  name: "Lounge",
  topic: "the quiet one",
  codec: Codec.OpusVoice,
  isPermanent: true,
});

await moveClient(client, client.clientID, cid, {
  password: "channel-password",
});
await sendChannelMessage(client, "hello");
await kickClient(client, someone, Reason.KickChannel, {
  reasonMessage: "take a break",
});

await addServerGroupPermission(client, sgid, permissionByName(PermissionName.ClientTalkPower), 50, {
  skip: true,
});

for await (const entry of iterateClientDatabase(client)) {
  console.log(entry.nickname, entry.lastConnectedAt);
}
```

`getOwnPermission` reads one of this connection's own permissions, resolved
across groups, channels and client settings; `getOwnPermissions` reads a list in
one command and answers in the order asked. Both need
`b_client_permissionoverview_own`.

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
the keys. A value there may be a string, a number or a boolean (sent as 1 or 0),
so a table's constant goes in as it is:
`editServer(client, { [PropertyName.VirtualServerHostBannerMode]: BannerMode.AdjustKeepAspect })`.

Results are camelCase too. Timestamps are `Date`s (`undefined` where the server
sends 0 for "never"), durations are milliseconds with an `Ms` suffix
(`idleTimeMs`, `durationMs`), and a permission is a `Permission`, built with
`permissionByID` or `permissionByName`. Small enumerations — `GroupType`,
`Codec`, `PrivilegeKeyType`, `LogLevel` and the rest — are objects of named values with
a type of the same name. A parameter takes the type, so a typo does not compile; a
result carries a plain `number` or `string`, since a server may send a value newer
than the table.

The values are the server's own numbers and strings, so they are what to store:
written to JSON or a database, they read back unchanged. What reads back is a plain
`number` or `string` to TypeScript, and `isValueOf` checks it against a table and
narrows it before it is passed as a parameter:

```ts
import { BannerMode, editChannel, isValueOf } from "@honeybbq/teamspeak";

if (!isValueOf(BannerMode, saved.bannerMode)) throw new Error("unknown banner mode");
await editChannel(client, cid, { bannerMode: saved.bannerMode });
```

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
so this is invisible to callers; [voice-protocol-responses.md](voice-protocol-responses.md)
has the measured table. A refusal is always thrown, never returned as an empty
result. A list or find with nothing to report answers `[]`. A command that
exists to return something — `createChannel`'s id, `initFileUpload`'s key,
`getClientProperties`'s fields — throws a `NoDataError` when the server answers
without it, rather than returning an id of 0 or an empty object.

For anything outside the typed set, `client.exec(line, { signal?, timeoutMs? })`
sends a raw command line and resolves to the rows that answer it.

## File Transfers

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
the file (the stream is not ended, so it may take several downloads), and
refuses a download over `maxSize` (256 MiB) in memory, stopping the transfer the
server had negotiated. `uploadFile` resolves once the server has closed the
transfer connection, which it does when it has the file, and fails a stream that
gives fewer or more bytes than `size`.

Both resume. `uploadFile(..., { resume: true })` asks the server how much of an
interrupted upload it kept and sends the rest of `data`, which is still the whole
file; `downloadFile(..., { seekPosition })` fetches the file from that offset to
its end. The file transfer port is dialled on the host the connection uses: the
servers never name another in the negotiation.

To control the two halves, negotiate with the `files` module, then move the bytes over TCP:

```typescript
import { Readable } from "node:stream";
import { initFileUpload } from "@honeybbq/teamspeak";

const info = await initFileUpload(client, cid, "/notes.txt", BigInt(data.length));
await client.uploadFileData(host, info, Readable.from([data]));
```

`info.size` and `info.seekPosition` fix how many bytes move: `data` is the file
from `seekPosition` on, and must give exactly `size - seekPosition` bytes.

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

## Identity

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
