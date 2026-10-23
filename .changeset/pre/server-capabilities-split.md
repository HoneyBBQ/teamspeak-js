---
"@honeybbq/teamspeak": major
---

`client.serverCapabilities` keeps only what lasts the connection, and reports the server's protocol extensions. `extensions` lists the names in `virtualserver_capability_extensions`, in the server's order: `["FILETIME", "STREAM_P2P"]` on TeamSpeak 6, empty on TeamSpeak 3. Test one with `extensions.includes("STREAM_P2P")`. The SDK does not refuse a command because a name is missing.

`name`, `iconID` and `hostBannerImageURL` are no longer on `ServerCapabilities`. They were read once in the handshake and went stale when the server was edited. Read them from the view, which follows the edits: `client.view.serverName`, `client.view.serverIconID` (the unsigned CRC32 as before, `undefined` for none) and `client.view.serverBannerImageURL`. `welcomeMessage`, `hostMessage` and `hostMessageMode` stay, since they are what the server greeted this connection with.
