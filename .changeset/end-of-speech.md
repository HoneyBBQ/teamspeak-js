---
"@honeybbq/teamspeak": patch
---

The end of someone's speech reaches `voiceData` listeners: the server relays the empty frame a client sends with `sendVoice(new Uint8Array(0), codec)` as a packet with no audio, and the client dropped it. It is now an event whose `data` is empty. Skip it if you decode every event's `data`: an empty one is the end of speech, not a frame. Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0.
