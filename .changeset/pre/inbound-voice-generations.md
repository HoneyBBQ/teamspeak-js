---
"@honeybbq/teamspeak": patch
---

Voice, whisper, ping and pong now follow the generation of their own inbound 16-bit packet ids, so audio from the server keeps decrypting after a packet id wraps from 65535 to 0, also when packets were lost across the wrap.
