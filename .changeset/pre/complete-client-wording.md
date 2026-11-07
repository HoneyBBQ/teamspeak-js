---
"@honeybbq/teamspeak": patch
---

Docs: the package description, its keywords, the README and the `client` entry point's doc comment present the SDK as a complete TeamSpeak client, with voice, ServerQuery and screen share, instead of calling it independent; the README's disclaimer keeps saying it is an independent implementation. The guide gains a section on sending voice and whispers, the streams page is reorganised with an overview of its events and errors and a section on running WebRTC in Node and Electron, and `examples/` gains `voice-echo.ts` and `stream-watch.ts`.
