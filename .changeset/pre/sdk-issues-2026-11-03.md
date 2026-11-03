---
"@honeybbq/teamspeak": patch
---

`uploadFile` with a `Uint8Array` reports `progress` as the bytes go out, every 64 KiB, instead of once with the whole size before any was sent. `NotificationName.ClientNeededPermissions` now says what the server sends: this client's own values of a fixed set of permissions, while it joins and when its groups change, and never for a refused command. `ChannelTree` is marked `@experimental`, as the server view it comes from is.
