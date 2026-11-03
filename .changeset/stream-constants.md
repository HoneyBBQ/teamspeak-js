---
"@honeybbq/teamspeak": minor
---

`@honeybbq/teamspeak/stream` names its events and values as constants: `streams.on(StreamsEventName.Started, (info) => { ... })`, `StreamSource.Screen`, `StreamEndCause.Server` and the like. The string names keep working and mean the same, so existing code needs no change.
