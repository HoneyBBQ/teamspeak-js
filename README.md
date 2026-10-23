<p align="center">
  <a href="https://honeybbq.github.io/teamspeak-js/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/HoneyBBQ/teamspeak-js/main/docs/assets/banner-dark.svg">
      <img alt="teamspeak-js" src="https://raw.githubusercontent.com/HoneyBBQ/teamspeak-js/main/docs/assets/banner-light.svg" width="460">
    </picture>
  </a>
</p>

<p align="center">
  <strong>An independent TeamSpeak client protocol library written in pure TypeScript.</strong><br>
  Works with TeamSpeak 3 and TeamSpeak 6 servers. No proprietary SDK or code.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@honeybbq/teamspeak"><img alt="npm version" src="https://img.shields.io/npm/v/@honeybbq/teamspeak"></a>
  <a href="https://github.com/HoneyBBQ/teamspeak-js/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/HoneyBBQ/teamspeak-js/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/HoneyBBQ/teamspeak-js"><img alt="OpenSSF Scorecard" src="https://api.scorecard.dev/projects/github.com/HoneyBBQ/teamspeak-js/badge"></a>
  <a href="https://github.com/HoneyBBQ/teamspeak-js/blob/main/package.json"><img alt="Node.js version" src="https://img.shields.io/node/v/@honeybbq/teamspeak"></a>
  <a href="https://github.com/HoneyBBQ/teamspeak-js/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
</p>

<p align="center">
  <a href="https://honeybbq.github.io/teamspeak-js/">Docs</a> ·
  <a href="https://honeybbq.github.io/teamspeak-js/documents/guide.html">Guide</a> ·
  <a href="https://github.com/HoneyBBQ/teamspeak-js/blob/main/CHANGELOG.md">Changelog</a> ·
  <a href="https://honeybbq.github.io/teamspeak-js/documents/migrating-to-1.0.html">Migrating to 1.0</a>
</p>

## Why this library

- **The voice protocol, end to end.** ECDH key exchange, the RSA puzzle, EAX-encrypted transport, and Opus voice (codecs 4 and 5), in TypeScript with no native addons.
- **ServerQuery too.** The same typed commands run over raw TCP, SSH (with host-key verification) or WebQuery, so an administration script and a voice bot share one vocabulary.
- **Typed commands and events.** Every command the voice protocol answers is a typed function, and the server's notifications arrive as typed events with pluggable middleware.
- **File transfers.** Upload, download and delete files on the server, with avatars and icons covered.
- **TeamSpeak 6 screen-share signalling.** Find, publish and watch streams, with SDP and ICE as plain strings for any WebRTC stack.
- **Built for long-running bots.** Opt-in reconnection tuned for TeamSpeak's antiflood ban, and a token-bucket rate limiter that keeps you clear of flood kicks.
- **Identities and server facts.** Generate, import, export and upgrade identities; read the server version, its uid hash (SHA-1 on TS3, SHA-256 on TS6) and its name, icon and banner.
- **TeamSpeak 3 and 6, ESM with types.** Pure TypeScript, zero native dependencies, full declarations, and a custom-transport hook for proxies and tests.

## Install

```bash
npm install @honeybbq/teamspeak
```

1.0 is in beta and published under the `latest` and `beta` tags; Node.js 22.12 or newer is required. Upgrading from 0.x? See [Migrating to 1.0](https://honeybbq.github.io/teamspeak-js/documents/migrating-to-1.0.html).

## Quick start

```typescript
import { Client, generateIdentity } from "@honeybbq/teamspeak/client";

const identity = await generateIdentity(8);
const client = new Client(identity, "localhost", "TSBot", {
  serverPassword: process.env.TEAMSPEAK_SERVER_PASSWORD,
  defaultChannel: "Lobby",
});

client.on("connected", ({ reconnected }) => {
  console.log(reconnected ? "Reconnected" : "Connected");
});
client.on("textMessage", (msg) => console.log(`[${msg.invokerName}]: ${msg.message}`));
client.on("disconnected", ({ error, willReconnect }) => {
  console.log("Disconnected:", error?.message ?? "clean", willReconnect ? "(reconnecting)" : "");
});

await client.connect({ signal: AbortSignal.timeout(15_000) });
process.on("SIGINT", () => void client.disconnect());
```

## Entry points

| Import                         | What it is                                                                                   | Docs                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@honeybbq/teamspeak`          | What every connection shares: the command language, ids, errors, typed commands, event types | [Design](https://honeybbq.github.io/teamspeak-js/documents/design.html)               |
| `@honeybbq/teamspeak/client`   | The voice client, identities, file transfers, diagnostics and the retry policy               | [Guide](https://honeybbq.github.io/teamspeak-js/documents/guide.html)                 |
| `@honeybbq/teamspeak/stream`   | TeamSpeak 6 screen-share signalling; no WebRTC code                                          | [Streams](https://honeybbq.github.io/teamspeak-js/documents/streams.html)             |
| `@honeybbq/teamspeak/query`    | The ServerQuery client over raw TCP, SSH or WebQuery; `@experimental`                        | [ServerQuery](https://honeybbq.github.io/teamspeak-js/documents/serverquery.html)     |
| `@honeybbq/teamspeak/versions` | Client versions a server accepts, for the `version` option                                   | [Configuration](https://honeybbq.github.io/teamspeak-js/documents/configuration.html) |

## Documentation

The full API reference is at [honeybbq.github.io/teamspeak-js](https://honeybbq.github.io/teamspeak-js/). The pages below are the long-form guides.

- [Guide](https://honeybbq.github.io/teamspeak-js/documents/guide.html): connecting, events, commands, file transfers and identities.
- [Configuration](https://honeybbq.github.io/teamspeak-js/documents/configuration.html): options, client version, tracing, diagnostics, reconnection, custom transports and server capabilities.
- [Streams](https://honeybbq.github.io/teamspeak-js/documents/streams.html): TeamSpeak 6 screen-share signalling, and interop with the TeamSpeak 6 client.
- [ServerQuery](https://honeybbq.github.io/teamspeak-js/documents/serverquery.html): the query client and its SSH host-key policy.
- [Design](https://honeybbq.github.io/teamspeak-js/documents/design.html): errors, ids, absent values, events, stability, and the server behaviour the SDK works around.
- [Compatibility](https://honeybbq.github.io/teamspeak-js/documents/compatibility.html): supported environments and the differences from the Go SDK.
- [Architecture](https://honeybbq.github.io/teamspeak-js/documents/architecture.html): source layout and entry points.
- [Migrating to 1.0](https://honeybbq.github.io/teamspeak-js/documents/migrating-to-1.0.html), [voice protocol responses](https://honeybbq.github.io/teamspeak-js/documents/voice-protocol-responses.html) and [ServerQuery responses](https://honeybbq.github.io/teamspeak-js/documents/serverquery-responses.html): reference material.

## Compatibility

| Target      | Supported                                                             |
| ----------- | --------------------------------------------------------------------- |
| TeamSpeak 3 | Voice protocol and ServerQuery                                        |
| TeamSpeak 6 | Voice protocol, ServerQuery and screen-share signalling               |
| Node.js     | 22.12 and newer; CI tests 22.12, 24 and 26. ESM only; TypeScript 5.2+ |

Details in [the compatibility page](https://honeybbq.github.io/teamspeak-js/documents/compatibility.html).

## Related

- **[teamspeak-go](https://github.com/honeybbq/teamspeak-go)** — The original Go implementation this library is ported from

## Acknowledgments

Protocol knowledge was primarily informed by the [TSLib](https://github.com/Splamy/TS3AudioBot) implementation in [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) by Splamy. Huge thanks to the TS3AudioBot project and its contributors.

The error code names and descriptions, the permission names and descriptions, and the table of client versions with their signatures draw on [tsdeclarations](https://github.com/ReSpeak/tsdeclarations) by [ReSpeak](https://github.com/ReSpeak), used under the MIT licence; see [THIRD_PARTY_NOTICES.md](https://github.com/HoneyBBQ/teamspeak-js/blob/main/THIRD_PARTY_NOTICES.md). Thanks to ReSpeak for documenting the protocol in the open.

## Contributing

See [CONTRIBUTING.md](https://github.com/HoneyBBQ/teamspeak-js/blob/main/.github/CONTRIBUTING.md) for setup, checks and the integration suite.

## License

[MIT](https://github.com/HoneyBBQ/teamspeak-js/blob/main/LICENSE)

---

<sub>TeamSpeak is a registered trademark of [TeamSpeak Systems, Inc.](https://teamspeak.com/). This project is not affiliated with, endorsed by, or associated with TeamSpeak Systems, Inc. in any way.</sub>

<sub>This library is an **independent implementation** built from public documentation, open-source implementations, observation of network traffic, and independent research. It contains no TeamSpeak proprietary code, headers, libraries, or binaries.</sub>

<sub>The project implements the client side only and does not implement a TeamSpeak server.</sub>
