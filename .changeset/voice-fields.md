---
"@honeybbq/teamspeak": minor
---

`VoiceDataEvent` gains `session` (the new `client.session`, which counts the sessions the client has completed, from 1), `whisper` (the packet type was VoiceWhisper), `seq` (the speaker's own packet counter, which wraps: compare with `((a - b) << 16 >> 16)`) and `receivedAt` (`performance.now()` milliseconds, taken when the datagram is read from the socket). Reorder a speaker's frames by (`session`, `clientID`, `whisper`) and then `seq`. The guide now recommends `for await (const v of client.events("voiceData", { signal }))` for receiving voice.

`client.events()` returns an `EventIterator`, an async iterator with a `dropped` count: for `voiceData`, how many frames its full buffer dropped.

**Behaviour change:** when an `events("voiceData")` buffer is full, it now drops the oldest buffered frame instead of the newest, so a consumer that catches up gets the most recent audio. Dropped voice is also reported in full: a burst that ended inside the ten-second warning interval used to be left out of the log.
