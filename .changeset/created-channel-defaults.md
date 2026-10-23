---
"@honeybbq/teamspeak": patch
---

A channel created while a client is connected now holds the server's defaults in `view.channel(id)`, as the next welcome lists it, instead of zeros: codec 4, quality 5, no client limit, and the rest of what the notification does not carry.
