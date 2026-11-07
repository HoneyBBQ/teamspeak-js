# Architecture

```
src/
├── core/              # Shared (@honeybbq/teamspeak): command language, ids, errors, typed commands
│   ├── command/           # Escaping, parsing and building command lines; ids
│   ├── api/               # The typed commands, run on any executor
│   ├── notifications.ts   # The notifications a server pushes, read as events
│   ├── events.ts          # The event types every client receives
│   ├── middleware.ts      # Command and line middleware, and the chain they make
│   ├── channel-tree.ts    # The channels of a server as an ordered tree
│   ├── reconnect.ts       # The reconnection policy and its backoff
│   ├── errors.ts          # TeamspeakError, ServerError and the shared errors
│   └── *-name.ts          # Command, notification, permission and property names
├── client/            # The voice client (@honeybbq/teamspeak/client)
│   ├── client.ts          # The Client: lifecycle, events, commands, voice, file transfers
│   ├── commands.ts        # Matching the server's answers to the commands that asked
│   ├── events.ts          # The event middleware chain
│   ├── view.ts            # The server view: its channels and clients, kept current
│   ├── handshake.ts       # The handshake's command steps, clientinitiv to clientinit
│   ├── capabilities.ts    # What the connected server is: family, version, uid hash
│   ├── reconnect.ts       # Server errors where retrying cannot help
│   ├── transfer.ts        # File transfer data connections
│   ├── connection-info.ts # Answering the server's connection-info requests
│   ├── trace.ts           # The connect phases and trace hooks
│   ├── diagnostics.ts     # The diagnostics_channel tracing points
│   ├── types.ts           # Options, the event map, voice and whisper types
│   ├── api/               # Commands only the voice protocol has; file, avatar and icon helpers
│   ├── crypto/            # ECDH, EAX encryption, identities
│   ├── handshake/         # Crypto handshake and license verification
│   ├── transport/         # UDP packets, acks, generation windows, QuickLZ, traffic counters
│   ├── discovery/         # SRV / TSDNS / direct address resolution
│   └── testing/           # A fake server for the tests; not published
├── query/             # The ServerQuery client (@honeybbq/teamspeak/query)
│   ├── client.ts          # The QueryClient: login, commands, events, reconnection
│   ├── tcp.ts             # Raw TCP transport
│   ├── ssh.ts             # SSH transport, with knownhosts.ts for host-key checks
│   ├── web.ts             # WebQuery transport over HTTP
│   └── lines.ts           # Splitting a byte stream into query lines
├── stream/            # TeamSpeak 6 streams (@honeybbq/teamspeak/stream)
│   ├── streams.ts         # Streams: discovery, publishing, watching
│   ├── published.ts       # A published stream and its join requests
│   ├── peer.ts            # The signalling peers: a view and a viewer
│   └── wire.ts            # The value tables and signalling messages on the wire
└── versions/          # Client versions (@honeybbq/teamspeak/versions)
examples/
├── connect.ts          # Minimal connection example
├── voice-echo.ts       # Sending back every voice frame heard in the channel
├── stream-watch.ts     # Watching a TeamSpeak 6 screen share from Node, with werift
├── flood-control.ts    # Line middleware recipes: pacing and resending
├── query-keepalive.ts  # Keeping a ServerQuery session open
└── query-events.ts     # Registering for ServerQuery events
```

## Entry points

| Import from                    | What it is                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@honeybbq/teamspeak`          | What every TeamSpeak connection shares: the command language, ids, errors, the typed commands, the event types and the status and reconnection types |
| `@honeybbq/teamspeak/client`   | The voice client, identities, file transfers, diagnostics and its retry policy                                                                       |
| `@honeybbq/teamspeak/versions` | Client versions a server accepts, for the client's `version` option; data only, one export each                                                      |
| `@honeybbq/teamspeak/stream`   | TeamSpeak 6 streams, the screen share: finding, publishing and watching them; signalling only, no WebRTC code                                        |
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
