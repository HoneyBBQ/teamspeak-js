---
"@honeybbq/teamspeak": minor
---

Query: `QueryClient.stats` reports the current connection: its kind (`tcp`, `ssh` or `web`), where it points (never a password or an api key), when it opened and the bytes written and read, for a metrics exporter; a client with no connection, or a `custom` transport that keeps no counts, reports zeros. A `custom` transport may offer `stats()` to take part.

Version helpers: `serverFamilyForVersion` (from the package) names the generation a version string belongs to, as `QueryClient.serverFamily` and the voice client's capabilities do; `uidAlgorithmForVersion` and `MAX_SECURITY_LEVEL` (from `/client`) are now exported.
