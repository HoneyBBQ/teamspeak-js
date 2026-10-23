---
"@honeybbq/teamspeak": patch
---

A client that reconnects now asks for the nickname it was given, not the one the server called it. When the requested name was taken the server assigns a suffixed one ("bot" becomes "bot1"), and the reconnect used to ask for "bot1" and get "bot12" while the old session still held it, drifting further on every drop; an admin's rename stuck across reconnects in the same way. Every connection attempt now sends the requested name, which a successful `clientupdate` of the client's own nickname changes. The nickname the server reports for the client, in `clientEnter`, `clientUpdated`, the view and the trace, is unchanged.
