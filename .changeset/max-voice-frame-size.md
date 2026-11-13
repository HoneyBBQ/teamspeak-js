---
"@honeybbq/teamspeak": minor
---

`MAX_VOICE_FRAME_SIZE` (`484`) in `@honeybbq/teamspeak/client` names the largest audio frame `sendVoice` accepts: 500 bytes minus the 8-byte tag, 5-byte header and 3-byte voice header. A larger voice packet is dropped by the server without an error, while whispers are not limited this way. Found by ulaski.
