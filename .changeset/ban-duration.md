---
"@honeybbq/teamspeak": minor
---

`ClientLeaveEvent`, `KickedEvent`, and `RemovedError` now carry `banDurationMs` when a client is banned from the server (`bantime`, in milliseconds: `0` for a permanent ban, and `undefined` for a kick or any other leave). `RemovedError` accepts `banDurationMs` as an optional fourth constructor argument. `docs/configuration.md` adds a reconnection recipe showing how to schedule a rejoin after a temporary ban or back off on a connection-flood block. Reported by ulaski.
