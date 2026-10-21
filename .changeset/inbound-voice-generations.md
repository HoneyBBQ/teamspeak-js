---
"@honeybbq/teamspeak": patch
---

Voice, whisper, ping and pong now track their inbound 16-bit packet id generations independently, so encrypted audio continues after a packet id wraps from 65535 to 0.
