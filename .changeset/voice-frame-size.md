---
"@honeybbq/teamspeak": patch
---

`sendVoice` throws a `RangeError` for a frame over 484 bytes instead of sending it. A voice packet is at most 500 bytes, and the server dropped a larger one without an error, so listeners heard a gap. Opus in VBR mode at a high bitrate goes over the limit on dense music (at 128 kbit/s stereo, up to 16% of a track's frames); encode at a constant bitrate, or a lower one, to keep every frame under it. Whispers are not affected.
