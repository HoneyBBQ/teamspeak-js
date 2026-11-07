# Flood control

TeamSpeak refuses a client that sends too many commands, and the way it does so
differs between the voice protocol and ServerQuery. This SDK leaves the
response to you: how fast to send, whether to send a refused command again and
how long to wait are choices of your bot, so the package ships the seam
(`lineMiddleware`) and reads what the server says, and the strategies below are
code you copy and own.

## What the SDK does

- It never paces commands, and never sends one again. A command goes out when
  you call it, unless a line middleware of yours holds it.
- It never keeps a ServerQuery session alive. See
  [idle sessions](#idle-sessions-raw-tcp-and-ssh) below.
- It registers for no ServerQuery events unless `events` names categories.
- Every command line passes your `lineMiddleware`, outermost first: the typed
  commands once encoded, the raw lines of `exec` and `execNoWait`, and the
  client's own (`setconnectioninfo` and what streams, avatars and file transfers
  send on the voice client; `login`, `use`, `version`, `whoami`,
  `servernotifyregister` and `clientlist` on ServerQuery). Two things do not
  pass: the voice handshake's own lines (`clientinitiv`, `clientek`,
  `clientinit`), which go out before a session exists, and the goodbye
  (`clientdisconnect` of `disconnect()`, `quit` when a query client closes),
  which must leave at once or the server keeps a ghost session (measured: error
  521 for the next connection).
- A refusal surfaces as a `ServerError` with code 524 (`ErrorCode.ClientIsFlooding`),
  and `floodWaitMs(error)` reads the wait the server named, in milliseconds, or
  `undefined` for any other error.

A line middleware wraps the sending of a line. `next` may be called more than
once: each call is a new command to the server, with a return code of its own.
`options.signal` aborts when the caller's signal does, when the command's
`timeoutMs` runs out (the timeout bounds the whole chain, a middleware's wait
included) and when the client disconnects. Lines still held in a middleware when
`disconnect()` begins are aborted and never written. On a `QueryClient` the
commands go one at a time, so a middleware that waits holds every command behind
it, in order; the voice client runs concurrent calls concurrently.

`line.text` can carry secrets (channel password hashes, privilege keys, a query
login), so do not log it.

## Voice antiflood

The server gives each client points per command and takes
`virtualserver_antiflood_points_tick_reduce` away every tick. A virtual server's
own thresholds, which its `serveredit` help describes, are:

- `virtualserver_antiflood_points_tick_reduce`: the points removed from a client
  each tick for being good.
- `virtualserver_antiflood_points_needed_command_block`: the points at which the
  server stops running a client's commands.
- `virtualserver_antiflood_points_needed_ip_block`: in the server's own
  `serveredit` help, "Anti-flood points needed to block incoming connections
  from the client".
- `virtualserver_antiflood_points_needed_plugin_block`: the same for plugin
  commands.

They are not in `initserver`. `servergetvariables` reads them, a fresh guest
identity may run it, and it costs no points (measured on TeamSpeak 3 3.13.8 and
TeamSpeak 6 6.0.0-beta13.1).

Measured costs, the same on both servers:

| Command                          | Points |
| -------------------------------- | ------ |
| `servergetvariables`             | 0      |
| `permget`                        | 5      |
| `channellist`                    | 5      |
| `clientupdate client_away=0`     | 15     |
| `sendtextmessage` to the channel | 15     |

Past `command_block` the server answers `error id=524 msg=client\sis\sflooding
extra_msg=retry\sin\s1985ms` and does not run the command; `ip_block` is the
server's own threshold for blocking incoming connections, which this SDK has
not exercised. `src/client/antiflood.integration.test.ts`
is the test that measures the table.

[yat.qa](https://yat.qa/ressourcen/voice-client-anti-flood/) keeps a fuller list
of costs per command, with a tick of half a second. That list is theirs, not
ours, and nothing here is checked against it.

`b_client_ignore_antiflood` (`PermissionName.ClientIgnoreAntiflood`) is the
permission whose description is "Ignore antiflood measurements". On a server you
run, granting it to your bot's server group is the complete fix, and none of the
code below is then needed.

## ServerQuery flood

A raw TCP or SSH query client that sends faster than
`serverinstance_serverquery_flood_commands` commands per
`serverinstance_serverquery_flood_time` gets error 524 with
`extra_msg=please\swait\sN\sseconds` and the command is not run; `floodWaitMs`
reads N. The instance's settings are in `instanceinfo`, which `editInstance`
changes.

## Recipes

These are line middleware for `lineMiddleware`, in
[`examples/flood-control.ts`](https://github.com/HoneyBBQ/teamspeak-js/blob/main/examples/flood-control.ts),
[`examples/query-keepalive.ts`](https://github.com/HoneyBBQ/teamspeak-js/blob/main/examples/query-keepalive.ts)
and
[`examples/query-events.ts`](https://github.com/HoneyBBQ/teamspeak-js/blob/main/examples/query-events.ts).
Their values are a starting point, not a measured optimum.

### A token bucket

The SDK's former built-in: 4 commands a second, a burst of 8, starting with 5,
with a pause that holds every line.

```typescript
const pacer = new Pacer();
const client = new Client(identity, addr, "Bot", { lineMiddleware: [paced(pacer)] });
```

`Pacer.take(cost, signal)` waits for tokens and rejects when the signal aborts,
so a command's timeout and a disconnect end the wait.

### Sending a refused command again

Wait twice the wait the server named, at most three times, within the command's
signal, and tell the pacer to hold every line meanwhile. The server's wait is a
lower bound, so the recipe adds a margin; twice is its choice, not a measured
optimum. List it before the bucket, so a resend takes a token too.

```typescript
const pacer = new Pacer();
const client = new Client(identity, addr, "Bot", {
  lineMiddleware: [resendOnFlood(pacer), paced(pacer)],
});
```

### A bucket weighted by cost

Charge each command what it costs, with the rate and the burst read from the
server's thresholds by `servergetvariables`:

```typescript
const pacer = new Pacer({ perSecond: 5, burst: 50, start: 50 }); // until sized
const client = new Client(identity, addr, "Bot", {
  lineMiddleware: [resendOnFlood(pacer), paced(pacer, costOf)],
});
await client.connect();
await sizeFromServer(pacer, client);
```

Points are charged by `costOf`: the measured costs above, and 15, the dearest
measured here, for a command not in the table (some cost more on the third-party
list). Until `sizeFromServer` runs, the bucket refills 5 points a second with a
burst of 50. `sizeFromServer` then refills `tick_reduce` points a second, which
takes a tick as one second, and allows a burst of 80% of `command_block`. The
tick was not measured here; the third-party list says half a second, so one
second errs on the slow side.

### Idle sessions, raw TCP and SSH

The server closes a raw TCP or SSH query session that sent no command for 300
seconds. Notifications received do not count: a session that received them and
sent nothing was closed all the same, and one that sent a command every 200
seconds stayed open (`src/query/idle.integration.test.ts`). WebQuery has no
session. `keepAlive` in `examples/query-keepalive.ts` sends `version` when no
command went out for two minutes:

```typescript
const held: { query?: QueryClient } = {};
const idle = keepAlive(() => held.query!);
const query = new QueryClient({ transport, lineMiddleware: [idle.middleware] });
held.query = query;
```

### ServerQuery events

A query client registers for nothing unless `events` names categories:
`{ categories: ["textserver", "textprivate"] }`. Raw TCP on TeamSpeak 3 and SSH
on TeamSpeak 6 accept `server`, `channel`, `textserver`, `textchannel` and
`textprivate`; `bans` is accepted on TeamSpeak 6 only, and TeamSpeak 3 refuses it
with 1539; `tokenused` is accepted by both and has no typed event. WebQuery
accepts none, and a client constructed with `events` over it throws. Registering
also lists the clients once, which fills the groups and the invoker of a message;
a client that names no `events` does neither.
