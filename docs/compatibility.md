# Compatibility

The package follows semver from 1.0. A few sets are open by nature and may
gain members in a minor release: the events (`EventMap`, `ServerEventName`),
`ClientStatus`, `ServerFamily`, `UIDAlgorithm`, `ErrorCode`, `Reason` and the
enumeration tables. Write a `switch` over any of them with a default case. A
field the server sends as a number that one of those tables names — a codec, a
text message's target mode, a group type — is a plain `number`, since a server
may send a value newer than the table.

`DatagramSocket` describes the part of a socket the client uses; should a
later release use more, the new members will be optional.

## Supported environments

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

## Differences from the Go SDK

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
