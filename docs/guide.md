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
