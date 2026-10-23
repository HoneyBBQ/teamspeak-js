---
"@honeybbq/teamspeak": minor
---

`StreamInfo.transport` says how a stream's media travels, from the `mode` the server announces: `"p2p"` for peer to peer, the one mode this SDK publishes and watches, or the number for a mode it has no name for. `watch` refuses a stream in another mode with the new `StreamTransportUnsupportedError` (`streamId`, `transport`) before sending anything, where it used to ask the publisher and fail later. A stream whose mode the server has not said is watched as before.
