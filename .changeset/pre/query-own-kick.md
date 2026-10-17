---
"@honeybbq/teamspeak": patch
---

A ServerQuery client now recognises when it is kicked from a channel, and emits `kicked` for it, whether or not the `nickname` option is set and while an older session with the same nickname is still on the server.

It used to find its own client id by matching `nickname` against the client list. With no `nickname` it never learned the id, so `kicked` never fired. When a session that had just disconnected was still listed under the same nickname, it took that one for itself, and the kick went unreported. It now asks the server with `whoami` while connecting, which adds one command to the connect.
