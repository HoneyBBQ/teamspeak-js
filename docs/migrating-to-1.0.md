# Migrating to 1.0

From `@honeybbq/teamspeak-client` 0.x to 1.0. The per-release details are in
the CHANGELOG; this guide is the path through them.

In 1.0 the packages are one: `@honeybbq/teamspeak`, with two entry points.
Install it, and import from the entry that holds what you need.

| Entry                        | What it holds                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@honeybbq/teamspeak`        | The command language, branded ids, errors and `ErrorCode`, the typed commands such as `listChannels`, the event types, and what every client shares: `ClientStatus`, reconnection policy |
| `@honeybbq/teamspeak/client` | The voice `Client`, identities, file transfer data, diagnostics, the retry policy, and the errors only the voice client throws                                                           |

Both are ESM-only, as 0.x was; on Node 22.12 and later `require()` loads them
too. Each entry exports only its own symbols. The code samples below name
symbols without import lines: `Client`, `Identity`, `generateIdentity`,
`parseIdentity`, `uidFromPublicKey`, the voice client's errors
(`HandshakeError`, `ConnectionTimeoutError`, `RemovedError`,
`InvalidAddressError`, `InvalidIdentityError`, `FileTransferError`),
`defaultShouldRetry`, `EventMap` and `unknownServerCapabilities` come from
`@honeybbq/teamspeak/client`; everything else, the typed commands, ids,
`ServerError`, `ErrorCode`, `NotConnectedError`, `NoDataError`,
`CommandTimeoutError`, `CommandMiddleware`, the event types and `escape`,
comes from `@honeybbq/teamspeak`. That includes what every kind of client
shares: `ClientStatus`, `Unsubscribe`, `Listener`, `ConnectedEvent`,
`DisconnectedEvent`, `ServerEventMap`, `SessionEventMap`, `ServerFamily`,
`AlreadyConnectedError`, `ReconnectOptions`, `BackoffPolicy`,
`defaultBackoffPolicy` and `backoffDelay`.

## The package was renamed

`@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` are now one
package, `@honeybbq/teamspeak`. The 0.x client re-exported the core; the new
client entry does not, so an import splits in two:

| You imported                                                                                                                          | Import it from now on        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `Client`, `Identity`, the client's errors, `commandChannel`, ... from `@honeybbq/teamspeak-client`                                    | `@honeybbq/teamspeak/client` |
| `listChannels`, `ErrorCode`, `ClientStatus`, `ReconnectOptions`, `TeamspeakError`, ids, events, ... from `@honeybbq/teamspeak-client` | `@honeybbq/teamspeak`        |
| anything from `@honeybbq/teamspeak-core`                                                                                              | `@honeybbq/teamspeak`        |

```ts
// before
import { Client, listChannels, ErrorCode } from "@honeybbq/teamspeak-client";
// after
import { Client } from "@honeybbq/teamspeak/client";
import { listChannels, ErrorCode } from "@honeybbq/teamspeak";
```

Replace both package names with `@honeybbq/teamspeak` in your `package.json`.
To rewrite the specifiers in your source in one step (use `sed -i ''` on
macOS), then move the client's own symbols to a `/client` import by hand:

```sh
git grep -lE '@honeybbq/teamspeak-(core|client)' -- src | xargs sed -i -E 's#@honeybbq/teamspeak-(core|client)#@honeybbq/teamspeak#g'
```

`@honeybbq/teamspeak-client` and `@honeybbq/teamspeak-core` are deprecated on
npm and get no further releases; 1.0 is published only as
`@honeybbq/teamspeak`. `@honeybbq/teamspeak-core/internal` is gone.

The 0.x line is closed to features: 0.3.x gets security fixes only, from a
`release/0.3` branch. There will be no 0.x release built on 1.0.

## Identities

```ts
// 0.x
const id = generateIdentity(8);
const saved = id.toString(); // the private key, also in every log line
const restored = identityFromString(saved);

// 1.0
const id = await generateIdentity(8, { signal });
const saved = id.export(); // toString() no longer reveals the key
const restored = parseIdentity(saved);
```

`generateIdentitySync(level)` keeps the blocking form.

An `Identity` is immutable and opaque. `upgradeToLevel(level, { signal })`
returns a new identity instead of changing this one, and refuses a level above
160; `offset` is read-only, and the private key is no longer a property —
`export()` is the one way to the secret. `new Identity(...)` is gone: make one
with `generateIdentity` or `parseIdentity`, which throws only an
`InvalidIdentityError`. `parseIdentity` is strict: the key must be canonical
base64 of at most 32 bytes and the offset a decimal unsigned 64-bit integer,
where 0.x decoded whatever base64 it could and took any offset.

```ts
// 0.x
await id.upgradeToLevel(10);
const uid = getUidFromPublicKey(id.publicKeyBase64());

// 1.0
const stronger = await id.upgradeToLevel(10);
const uid = id.uid("sha1"); // or uidFromPublicKey(id.publicKey(), "sha1"); TS6 uses "sha256"
```

`publicKeyBase64()` is now `publicKey()`; it still returns the base64 text.

## Connecting

```ts
// 0.x
await client.connect();
await client.waitConnected(AbortSignal.timeout(15_000));

// 1.0
await client.connect({ signal: AbortSignal.timeout(15_000) });
```

`connect()` resolves once the handshake completes and rejects with its
failure, such as the server's `ServerError` for a wrong password.
`disconnect({ signal })` bounds the goodbye. `await using client = new
Client(...)` disconnects at the end of the scope.

The default logger is silent: pass `logger: console` to see what 0.x printed.
`TEAMSPEAK_TRACE_RAW` is gone; subscribe to the `honeybbq:teamspeak:command`
and `honeybbq:teamspeak:incoming` diagnostics channels instead.

## Commands

The helpers 0.x had are typed functions taking the client first and branded
ids. Required arguments are positional; everything optional is in one last
options object, which also carries `{ signal, timeoutMs }`:

| 0.x                                                        | 1.0                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `listChannels(client)`                                     | `listChannels(client)`                                                                                                   |
| `listClients(client)`                                      | `listClients(client, { away, ..., signal })`                                                                             |
| `clientMove(client, clid, cid, password)`                  | `moveClient(client, clid, cid, { password })`                                                                            |
| `poke(client, clid, message)`                              | `pokeClient(client, clid, message)`                                                                                      |
| `sendTextMessage(client, mode, target, message)`           | `sendPrivateMessage(client, clid, message)`, `sendChannelMessage(client, message)`, `sendServerMessage(client, message)` |
| `fileTransferDeleteFile(client, cid, paths)`               | `deleteFile(client, cid, paths)`                                                                                         |
| `client.fileTransferInitUpload(cid, path, password, size)` | `initFileUpload(client, cid, path, size, { password })`                                                                  |
| `client.fileTransferInitDownload(cid, path, password)`     | `initFileDownload(client, cid, path, { password })`                                                                      |
| `client.execCommandWithResponse(line, ms)`                 | `client.exec(line, { timeoutMs: ms })`                                                                                   |
| `client.execCommand(line, ms)`                             | `client.exec(line, { timeoutMs: ms })`                                                                                   |
| `client.sendCommandNoWait(line)`                           | `client.execNoWait(line)`                                                                                                |
| `getClientInfo(client, clid)`                              | `getClientProperties(client, clid)`, the raw property map                                                                |

If you used a 1.0 prerelease, these took positional optional arguments and now
take them in the options object:

| Before                                                                                            | Now                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `listClients(c, include, options)`                                                                | `listClients(c, { ...include, ...options })`                        |
| `moveClient(c, clid, cid, password)`                                                              | `moveClient(c, clid, cid, { password })`                            |
| `kickClient(c, clid, reason, message)`                                                            | `kickClient(c, clid, reason, { reasonMessage })`                    |
| `moveChannel(c, cid, parent, order)`                                                              | `moveChannel(c, cid, parent, { order })`                            |
| `deleteChannel(c, cid, force)`                                                                    | `deleteChannel(c, cid, { force })`                                  |
| `deleteServerGroup` / `deleteChannelGroup(c, id, force)`                                          | `(c, id, { force })`                                                |
| `addClientPermission(c, dbid, perm, value, skip)`                                                 | `addClientPermission(c, dbid, perm, value, { skip })`               |
| `listFiles(c, cid, path?, password?)`                                                             | `listFiles(c, cid, path, { password })`                             |
| `getFileInfo`, `deleteFile`, `createDirectory(…, password)`                                       | `(…, { password })`                                                 |
| `renameFile(c, cid, old, new, rename, options)`                                                   | `renameFile(c, cid, old, new, { ...rename, ...options })`           |
| `initFileUpload` / `initFileDownload(…, upload, options)`                                         | `(…, { password, ..., signal })`                                    |
| `stopFileTransfer(c, id, removePartialFile)`                                                      | `stopFileTransfer(c, id, { removePartialFile })`                    |
| `listComplaints(c, dbid)`                                                                         | `listComplaints(c, { targetDatabaseID })`                           |
| `listBindings(c, subsystem)`                                                                      | `listBindings(c, { subsystem })`                                    |
| `banClient`, `viewLog`, `listClientDatabase`, `listServerGroupClients`, `listChannelGroupClients` | their options and `{ signal, timeoutMs }` merged into one object    |
| `addServerGroupPermission(c, sgid, { permission, value, negated, skip })`                         | `addServerGroupPermission(c, sgid, perm, value, { negated, skip })` |
| `updateMessageFlag(c, id, read)`                                                                  | `updateMessageFlag(c, id, { read })`                                |
| `getClientIDs(c, uid)` answering `ClientID[]`                                                     | answers `ClientMatch[]` (`id`, `nickname`)                          |
| `getClientNameByDBID(c, dbid)` answering a string                                                 | answers `ClientDatabaseName` (`databaseID`, `name`)                 |

A ban's fields are a `BanFields` (`ip`, `name`, `uid`, `reason`, `durationMs`),
which `addBan` takes as `BanOptions` and which carries no `signal` or
`timeoutMs`: those are `addBan`'s separate last argument, as they are for every
command that sends content (`createChannel`, `editChannel`, `updateClient`,
`editClient`, `editClientDatabase`).
`BanClientOptions` is `BanFields`' `durationMs` and `reason` with
`{ signal, timeoutMs }`.

`initFileUpload` no longer replaces a file already at the path unless passed
`overwrite: true`; it used to by default. `renameFile` sends its
`targetChannelPassword` only with a `targetChannelID` other than 0, and
`viewLog` always sends `reverse` and `instance`. A `Permission` with id 0 is
refused before anything is sent.

The options types are named `…Options` like the rest: `listClientDatabase`
takes a `ClientDatabasePageOptions`, `listChannelGroupClients` a
`ChannelGroupClientListOptions`, and `pages` a `PagingOptions`.

Ids the server hands back are branded like the rest: a ban is a `BanID`
(`BanEntry.id`, `addBan`, `banClient`, `deleteBan`), an offline message a
`MessageID`, a virtual server a `ServerID` (`WhoAmI.serverID`,
`getServerIDByPort`), and a transfer has a `ClientFileTransferID` and a
`ServerFileTransferID` (`stopFileTransfer` takes the latter). Brand one with
`asBanID(…)` and the like. `banClient` resolves to every ban it made — the
server bans a client by address, uid and, on TS6, myTeamSpeak id, and over
ServerQuery reports each — as a `BanID[]`, which is empty over the voice
protocol; `addBan` resolves to its one id, or `undefined` over the voice
protocol, which reports none. `ServerGroup.sortID` and `ChannelGroup.sortID` are
numbers. `PermissionLocation`, which `findPermission` and
`getPermissionOverview` return, is discriminated on `target` and names its ids
— `serverGroupID`, `databaseID`, `channelID`, `channelGroupID` — instead of
`id1` and `id2`:

```ts
for (const where of await findPermission(
  client,
  permissionByName(PermissionName.ClientTalkPower),
)) {
  if (where.target === PermissionTarget.ChannelGroup)
    console.log(where.channelID, where.channelGroupID);
}
```

A `Channel`'s `uniqueIdentifier` is now `uid`, a `ChannelUID` — its own brand,
not a client's `UID` — and the privilege key type table `TokenType` is
`PrivilegeKeyType`.

Privilege keys have one set of functions: `listPrivilegeKeys`,
`addPrivilegeKey`, `deletePrivilegeKey` and `usePrivilegeKey`. The `listTokens`,
`addToken`, `deleteToken` and `useToken` aliases of a 1.0 prerelease are gone.

About a hundred more commands are new: channels, groups, permissions, bans,
files, tokens and the server. An id comes from a result, an event, or a
constructor: `asChannelID(5)`, `asClientID(3)`. A constructor throws a
`RangeError` for anything but an integer in the id's wire range — 0–65535 for a
`ClientID` and the file transfer ids, 0–2^32−1 for a `PermissionID`, 0–2^64−1
for the `bigint` ids.

Many queries were answered with nothing in 0.x, because the server sends their
data in a notification. They now return the data.

Every list and find answers `[]` when there is nothing to list, never an
error: the server's "database empty result set" (1281) is caught, and so are
the 512 and 768 with which `findClients` and `findChannels` report finding
nothing.

## Raw commands

`escape` and `unescape` stay public, for a raw line sent with `client.exec`.
`parseCommand`, `buildCommand`, `buildCommandOrdered` and the `Command` and
`EscapedString` types are no longer exported: build the line yourself with
`escape`, or use a typed command. `escape` returns a plain `string`.
`encodeRequest`, which renders a `CommandRequest` as a line, is no longer
exported either: a `CommandExecutor` is handed the request, and a client's
`send()` encodes it.

Commands, `exec`, `execNoWait`, `sendVoice` and `sendWhisper` fail with a
`NotConnectedError` unless `client.status` is `"connected"`. They used to need
only an open socket, so one sent while `connect()` was still running went out
under the handshake's public key.

## Voice

`sendWhisper(data, targets, codec)` takes its targets as a record,
`{ clients: [clid, …] }`, in place of a bare list of client ids. The whisper
the client writes carries client ids only, so `WhisperTargets` has no field for
channels yet. `sendVoice(data, codec, options?)` takes a `VoiceOptions`, which
has no fields yet.

## Errors

```ts
// 0.x
if (err instanceof ServerError && err.id === "2568") { … }

// 1.0
if (err instanceof ServerError && err.code === ErrorCode.PermissionsClientInsufficient) { … }
```

`code` is a number; `ErrorCode` names every code. `failedPermissionID` is a
`PermissionID`; over WebQuery the missing permission is named in
`failedPermission` instead. A wrong server or channel
password is no longer retried by the reconnect loop.

Every error the SDK throws is a `TeamspeakError`, and `instanceof` works even
when two copies of the package are installed, minified or not: each class
names itself in a fixed static `kind`, which instances carry. A subclass of
your own that declares no `kind` matches only its own instances across
copies. A handshake that fails on what
the server sent rejects with a `HandshakeError`; `parseIdentity` throws only
an `InvalidIdentityError`. `EAXTagMismatchError` and
`FakeSignatureMismatchError` are no longer exported: a packet that fails them
is dropped, and they never reached a caller. An address that
cannot be one — no host, a port outside 1–65535 — makes `connect()` reject with
an `InvalidAddressError` instead of a Node `RangeError` or `TypeError`, and a
host name that does not resolve with a `TeamspeakError` whose `cause` is the
lookup's error. `TimedOutError` is now
`ConnectionTimeoutError`, which says which timeout it is: a command's is a
`CommandTimeoutError`. A command that exists to return data — `createChannel`,
`addPrivilegeKey`, `initFileUpload`, `initFileDownload`, `getChannelInfo`,
`getClientProperties`, `getClientDBIDByUID`, `getServerIDByPort`, `getMessage`,
`whoAmI` and the other single-answer queries — throws the new `NoDataError`
when the server answers without it, where it used to return an id of 0 or an
object of empty fields; `getClientInfo`, now `getClientProperties`, threw a plain
`TeamspeakError`.

The exported tables — `ErrorCode`, `Reason`, `ClientStatus`, every enumeration,
`noopLogger`, `consoleLogger` and `defaultBackoffPolicy` — are frozen.

## Events

```ts
// 0.x
client.on("kicked", (reason) => …);
client.on("clientLeave", (e) => e.reasonID);

// 1.0
const stop = client.on("kicked", (e) => e.reasonMessage); // and e.reason, e.invokerName
client.on("clientLeave", (e) => e.reason);
stop();

for await (const message of client.events("textMessage", { signal })) { … }
```

`on()` returns a function that removes the listener, and `once()` is new.
Listeners run one at a time, in arrival order. A listener that throws does not
stop the others: its exception surfaces as an `uncaughtException`, as an
EventEmitter listener's would, and the event still reaches the listeners after
it.

A notification arrives on two layers at once. One is the typed events — the
ones an event map names. The other is `notification`, the catch-all: it
carries every notification the server sends with its wire name and unescaped
parameters, the ones that have a typed event among them, and it is delivered
after the event that notification produced. So a notification is never taken
out of the catch-all by being given a typed event, and adding one is additive,
a minor change — as is any key an event map gains; `EventMap`, `ServerEventMap`
and `SessionEventMap` never lose a key in a minor release.

Five of the names `NotificationName` lists have a typed event:
`notifytextmessage`, `notifycliententerview`, `notifyclientleftview`,
`notifyclientmoved` and `notifyclientpoke`. They are the notifications that
describe this client's own session as it happens: who comes into view, moves or
leaves, and the two that address this client directly, a message and a poke.
The three about other clients are at the same time what the client's view of
who is present is kept from, which the move and message payloads are then
completed from. That is the shape they share, not a test that picks them out of
the other 61: several notifications left to `notification` are just as
unprompted and just as much about the session, such as `notifyclientupdated` or
`notifyserveredited`, and none of the five is a command's answer. So promoting
one is a judgement against that shape rather than a rule that decides itself.
Adding such an event is a minor change, and the notification stays on the
catch-all.

`disconnected` delivers a `DisconnectedEvent`: its `error` is `undefined`
only after `disconnect()`, and otherwise the cause, such as a `RemovedError`
for a kick or a `ConnectionTimeoutError`; its `willReconnect` says whether the
reconnect loop will try again (0.x gave the bare `Error | undefined`).
`connected` delivers a `ConnectedEvent`, whose `reconnected` is true when the
reconnect loop made the connection. `disconnect()` resolves once
`disconnected` has been delivered, and a `connect()` waits for an earlier
session's `disconnected` to be delivered first, so the new session never hears
the old one end. `connected` is delivered after `connect()` resolves. Channel
kicks now reach `kicked`. Ids in
events are branded, and `clientEnter` delivers the same `ClientEntry` that
`listClients` returns.

The event types are named after their event, with an `Event` suffix:

| 0.x                   | 1.0                                  |
| --------------------- | ------------------------------------ |
| `TextMessage`         | `TextMessageEvent`                   |
| `ClientInfo`          | `ClientEnterEvent` (a `ClientEntry`) |
| `ClientLeftViewEvent` | `ClientLeaveEvent`                   |
| `VoiceData`           | `VoiceDataEvent`                     |
| `RawNotification`     | `NotificationEvent`                  |

The client an event is about is `clientID` in `ClientMovedEvent`,
`ClientLeaveEvent` and `VoiceDataEvent` (was `id`, and `clientId` for voice).
`TextMessageEvent.targetMode` and `VoiceDataEvent.codec` are plain numbers, to
compare with `TextMessageTarget` and `Codec`: a server may send a value newer
than those tables. `TextMessageEvent.invokerGroups` is `undefined` for a sender
the client has not seen, as a text message carries no groups of its own, and
`ClientMovedEvent.reasonMessage` is the move's message, `""` when it has none.

Middleware is set with the `commandMiddleware` and `eventMiddleware` options;
`useCommandMiddleware()` and `useEventMiddleware()` are gone. Event middleware
receives `{ name, payload }`.

Command middleware wraps the typed commands rather than the wire: it receives
the request and its options and returns the rows, so it can time, retry or
answer a command itself.

```ts
// 0.x: a line, and nothing back
const logging: CommandMiddleware = (next) => async (line) => next(line);

// 1.0
const timing: CommandMiddleware = (next) => async (request, options) => {
  const started = Date.now();
  try {
    return await next(request, options);
  } finally {
    console.log(request.command, Date.now() - started, "ms");
  }
};
```

Raw lines sent with `exec` and `execNoWait`, and the handshake's own commands,
do not pass through it.

## Options

Every field of `ClientOptions`, `ReconnectOptions` and `FileTransferOptions`
is `readonly` and accepts `undefined`, so `serverPassword:
process.env.TEAMSPEAK_SERVER_PASSWORD` compiles under
`exactOptionalPropertyTypes`. A custom `AddrResolver.resolve(addr, { signal })`
takes its signal in an options object, and returns `ResolvedAddr`s whose
`source` and `expiry` are optional.

## Address resolution

A dot-less address (`mybox`) was sent to named.myteamspeak.com as a server
nickname. That lookup is now opt-in, with `nicknameLookup: true`; without it
the name is resolved like any host. Resolution as a whole is bounded at ten
seconds, after which the address is used as given; the client holds a custom
`resolver` to the same budget, through the `signal` it passes in.

## Transports

`socketFactory` returns a `DatagramSocket` — a `node:dgram` socket still is
one — and `fileTransferSocketFactory` any `Duplex`. File transfers take
`{ signal }` as their last argument:

```ts
await client.uploadFileData(host, info, Readable.from([data]), { signal });
```

## Reconnecting

Supplying `reconnect` turns reconnecting on; `enabled` is gone:

```ts
// 0.x
new Client(identity, addr, "Bot", { reconnect: { enabled: true } });

// 1.0
new Client(identity, addr, "Bot", { reconnect: {} });
```

`isPermanentFailure(err)` is `defaultShouldRetry(err)`, with the opposite
meaning. `backoffDelay(policy, attempt)` takes no random source, and
`defaultBackoffPolicy` is frozen.

## Status

The client's state is read through getters: `client.status`,
`client.clientID`, `client.channelID`, `client.uid` (was
`uniqueIdentifier()`) and `client.serverCapabilities` — no parentheses, and
the ids are already branded. `parseServerCapabilities` is no longer exported:
the client reads `initserver` itself, and `client.serverCapabilities` is what
it read; `unknownServerCapabilities()` stays, for a value to start from.

`ClientStatus` is a string union (`"disconnected"`, `"connecting"`,
`"connected"`) rather than a `const enum`; compare against
`ClientStatus.Connected` as before.
