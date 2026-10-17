---
"@honeybbq/teamspeak": minor
---

The query client can connect as a TeamSpeak 6 guest, which beta13 and later accept without any setup: pass `guest: true` in the `ssh` transport (logs in as the user `guest` with no password) or the `web` transport (sends no api key). It is an explicit choice: a missing `username`, `password` or `apiKey` still throws, and the error now names `guest: true` as the way to connect without one. A guest runs with the Guest Server Query group's permissions, so `version` and `whoami` answer and admin commands are refused; pass `events: false` for an SSH guest that may not register for notifications.
