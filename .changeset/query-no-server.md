---
"@honeybbq/teamspeak": patch
---

A `QueryClient` made with no `server` now connects, as its documentation says, instead of failing `connect()` with `ServerError 1024 invalid serverID`. With no server selected the server refuses `servernotifyregister` and `clientlist`, so the client skips them and serves the instance-level commands (`instanceinfo`, `serverlist`, `use`); the first successful `use()` registers the `events` and reads the client list, as `connect()` does with a `server`. `stopFileTransfer` and the ServerQuery notes now say that a transfer of your own that has finished, or that nobody connected to for about 10 seconds after it was negotiated, no longer exists either, so stopping it crashes TeamSpeak 6 too (measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0).
