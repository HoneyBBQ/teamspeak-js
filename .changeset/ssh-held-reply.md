---
"@honeybbq/teamspeak": patch
---

Over SSH, a TeamSpeak 6 server can hold the end of a reply until the client writes again; the SSH transport now writes an empty line when a command has waited 2 seconds, and once a second after, which releases it.
