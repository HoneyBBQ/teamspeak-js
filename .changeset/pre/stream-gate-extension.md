---
"@honeybbq/teamspeak": major
---

`Streams` goes by what the server says it supports, not by its version: `supported`, `publish` and `watch` need the server to name `STREAM_P2P` among its extensions (`client.serverCapabilities.extensions`), as TeamSpeak 6 does. A server that does not name it gets a `StreamsUnsupportedError` before anything is sent, whatever its version, and the error now carries the `extensions` the server named. A client double passed to `new Streams(...)` needs `serverCapabilities.extensions`; a voice `Client` already has it.
