---
"@honeybbq/teamspeak": minor
---

A command from the server that stays missing for 5 seconds while later ones arrive now ends the connection with the new `ConnectionStalledError`, where the client skipped it: the answer or notification was lost without a trace, and a missing first fragment misparsed the ones after it. The server sends a command again until it is acknowledged, so a hole that stays means a broken connection; the default reconnect policy retries it and starts from a consistent state. Catch it with `instanceof ConnectionStalledError`, or read it as the `cause` of `disconnected`.
