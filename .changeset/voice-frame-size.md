---
"@honeybbq/teamspeak": patch
---

`sendVoice` throws a `RangeError` for a frame over 484 bytes (`MAX_VOICE_FRAME_SIZE`) instead of sending it. A voice packet is at most 500 bytes, and the server dropped a larger one without an error, so listeners heard a gap. Opus in VBR mode at a high bitrate can exceed the limit on dense passages; encode at a constant bitrate or a lower one, use shorter frames, or pass `max_data_bytes = 484` to libopus's `opus_encode` to keep every frame under it. Whispers are not affected.
