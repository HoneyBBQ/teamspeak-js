---
"@honeybbq/teamspeak": patch
---

Stream events wait for a listener again after the last one unsubscribes, up to the same bound, instead of going nowhere. Signalling that a publisher still sends for a stream whose view the app has left or closed is ignored instead of being reported to `error` one message at a time.
