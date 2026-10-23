# Architecture

```
src/
├── core/              # Shared (@honeybbq/teamspeak): command language, ids, errors, typed commands
├── versions/          # Client versions (@honeybbq/teamspeak/versions)
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
├── stream/            # TeamSpeak 6 streams (@honeybbq/teamspeak/stream)
└── query/             # The ServerQuery client (@honeybbq/teamspeak/query)
examples/
└── connect.ts  # Minimal connection example
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
