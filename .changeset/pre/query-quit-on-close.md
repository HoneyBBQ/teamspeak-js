---
"@honeybbq/teamspeak": patch
---

A query client now says `quit` before it closes a raw TCP or SSH connection, and waits a moment for the server to end the session. A TeamSpeak 3 server could keep an SSH session whose client had simply gone away, and enough of them locked the address out of new connections.
