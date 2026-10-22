# Design

The conventions below hold across the whole package. Each is stated once here.

## Errors

An error is one of two kinds:

- **A refusal the server reports.** It is a `ServerError` carrying the server's
  numeric `code`, its text as `serverMessage`, and `extraMessage` and
  `failedPermissionID` when the server names them.
- **A condition the SDK detects itself**: not connected, no data, a timeout, a
  failed handshake, a failed file transfer. Each has its own class.

Every error the SDK throws on purpose extends `TeamspeakError`, so
`instanceof TeamspeakError` tells its failures from anything else. A failure
that wraps another keeps it in `cause`. Match a refusal by `error.code` against
`ErrorCode`, and everything else by class:

```typescript
import {
  ErrorCode,
  NotConnectedError,
  ServerError,
  TeamspeakError,
  asChannelID,
  moveClient,
} from "@honeybbq/teamspeak";

try {
  await moveClient(client, client.clientID, asChannelID(5), {
    password: "wrong",
  });
} catch (err) {
  if (err instanceof ServerError && err.code === ErrorCode.ChannelInvalidPassword) {
    // ask for the password again
  } else if (err instanceof NotConnectedError) {
    // the connection is gone
  } else if (err instanceof ServerError) {
    console.log(err.code, err.serverMessage, err.extraMessage, err.failedPermissionID);
  } else if (err instanceof TeamspeakError) {
    console.log(err.name, err.message, err.cause);
  } else {
    throw err;
  }
}
```

`ErrorCode` names the server's codes as constants. It is the table `errcode`
is in the Go SDK, with the same numbers. A server may send a code it does not
name, so `code` is a plain `number`. `instanceof` also works between two
installed copies of the package.

Errors live with the code that produces them, so each entry point exports only
the errors its own code throws:

| Entry point                                        | Errors                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@honeybbq/teamspeak` (shared by every connection) | `TeamspeakError`, `ServerError`, `CommandTimeoutError`, `NotConnectedError`, `AlreadyConnectedError`, `NoDataError`                                                                    |
| `@honeybbq/teamspeak/client` (voice only)          | `ConnectionTimeoutError`, `HandshakeError` and its `PuzzleTooHardError`, `InvalidAddressError`, `InvalidIdentityError`, `FileTransferError`, `RemovedError` (kick, ban or server stop) |
| `@honeybbq/teamspeak/stream` (streams only)        | `StreamsUnsupportedError`, `StreamJoinDeniedError`, `StreamEndedError`, `StreamPayloadTooLargeError`                                                                                   |
| `@honeybbq/teamspeak/query` (query only)           | `QueryAuthError`, `GuestAccessError`, `SshHostKeyError`, `MissingDependencyError`, `WebQueryHttpError`                                                                                 |

A call that is given a value it cannot use, such as an out-of-range id or an
option that contradicts another, throws the language's own `TypeError` or
`RangeError` before anything is sent. Those are not `TeamspeakError`s: they are
a bug in the caller, not a condition to handle. `WebQueryHttpError` carries the
HTTP `status`; a refusal the server itself reports is a `ServerError` over every
transport.

**Cancellation.** An aborted `signal` is the caller's own cancellation, not an
SDK error. `connect()`, the typed commands, `exec`, file transfers and `events()`
reject with the signal's `reason` itself, unwrapped: a `DOMException` named
`AbortError` after a bare `abort()`, a `TimeoutError` after
`AbortSignal.timeout()`, or whatever value was passed to `abort(reason)`. A
signal that is already aborted rejects before anything is sent. Aborting a
`connect()` abandons the attempt and leaves the client disconnected; a command
that was given up on may still have taken effect on the server. The signal and
the command's own `timeoutMs` are separate: when `timeoutMs` (ten seconds by
default) passes first, the command rejects with a `CommandTimeoutError`.

**No data.** `NoDataError` means the command succeeded but its answer lacked the
data it exists to return, such as the id of a channel just created. Treat the
command as having taken effect and do not retry it blindly, or it creates a
second object or is refused as a duplicate. `createChannel` and the group
commands look the new object up themselves and throw it only when nothing
matches. A list that comes back empty is `[]`, not this error.

## Ids

Every kind of id is a branded type: `ChannelID`, `ClientID`, `ClientDBID`,
`ServerGroupID`, `ChannelGroupID`, `PermissionID`, `IconID`, `ServerID`,
`BanID` and the rest, with `UID` and `ChannelUID` as branded strings. The
brand costs nothing at runtime, and passing the wrong kind is a compile error.
Make one with its constructor, which throws a `RangeError` for a value outside
the id's wire range:

```typescript
import { asChannelID, asClientID, moveClient } from "@honeybbq/teamspeak";

const cid = asChannelID(5); // or asChannelID(5n)
await moveClient(client, client.clientID, cid);
// moveClient(client, cid, client.clientID) does not compile.
const clid = asClientID(3);
```

A `ClientID`, `PermissionID`, `IconID` and the file transfer ids are `number`s.
The ones the protocol makes 64 bits wide are `bigint`s: `ChannelID`,
`ClientDBID`, `ServerGroupID`, `ChannelGroupID`, `ServerID`, `BanID`,
`MessageID` and `APIKeyID`. Their constructors take a `number` or a `bigint`.

## Options and absent values

**Options.** Required arguments are positional. Everything optional is one
options object, the last argument. A field that is not set is not sent:
`undefined` leaves the setting alone and `""` sends it empty.

```typescript
import { editChannel } from "@honeybbq/teamspeak";

await editChannel(client, cid, {
  name: "Lounge",
  topic: "", // sent empty: clears the topic
  // password is not set: not sent, so the password stays as it is.
});
```

**Records.** In a record the server's answer fills in, an optional field is
`undefined` when the server did not send it. That is not the same as `0` or
`false`: `totalClients` is `undefined` in a `getChannelInfo` result, which does
not carry it, and `0` in a `listChannels` result of an empty channel.

```typescript
import { getChannelInfo } from "@honeybbq/teamspeak";

const info = await getChannelInfo(client, cid);
if (info.totalClients !== undefined) console.log(info.totalClients, "clients");
```

**Durations and times** are numbers of milliseconds with an `Ms` suffix
(`idleTimeMs`, `timeoutMs`) and `Date`. A `Date` field is `undefined` where the
server sends 0 for "never". The Go SDK uses `time.Duration` and `time.Time`.

## Events

Each server event has a typed name (`"textMessage"`, `"clientEnter"`, ...;
`EventName` has a constant for each), and `"notification"` delivers every
notification as the server sent it, including those no typed event models. The
notification arrives after the typed event it produced. `on()` returns a
function that removes the listener; `events(name, { signal })` is the same as an
async iterator.

```typescript
const off = client.on("textMessage", (message) => {
  console.log(message.invokerName, message.message);
});
off();

client.on("notification", (n) => console.log(n.name, n.params));
```

- **Order.** Listeners run one at a time, in the order the events arrived, so a
  listener may call the client and await an answer.
- **State.** The client updates its state, such as `client.view`, before it
  queues the event that reports the change, so a listener sees state at least as
  new as its event.
- **A throw** in a listener does not stop the others. The exception is rethrown
  from a microtask, as an uncaught exception, as an EventEmitter listener's
  would be. The Go SDK recovers a panicking handler and logs it instead.
- **Middleware.** `eventMiddleware` sees each server event before the listeners
  and may pass it on, replace it or drop it; `connected`, `disconnected`,
  `kicked` and the view events bypass it. `commandMiddleware` wraps the typed commands. Both are
  described above.

## Stability

From 1.0 the package follows semver, as described under
[Compatibility](compatibility.md): a breaking change to `@honeybbq/teamspeak`,
`/client` and `/versions` waits for 2.0. The enumerations, `ErrorCode` and the
event map may gain members in a minor release; give a `switch` over them a
default case.

An API that may still change in a minor release is marked `@experimental` in its TSDoc,
which editors and the API reference show. Today that is the whole
`@honeybbq/teamspeak/query` entry point, the server view (`client.view` and the
view events), the `previous` field of the client-left and channel-deleted
events, and `getServerVariables`.

## Server behaviour the SDK works around

The servers answer some commands in ways that differ between TeamSpeak 3 and 6
and between transports, and the SDK evens those out. The measured tables are in
[voice-protocol-responses.md](voice-protocol-responses.md)
and [serverquery-responses.md](serverquery-responses.md).
