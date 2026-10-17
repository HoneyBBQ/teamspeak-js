---
"@honeybbq/teamspeak": patch
---

`getClientConnectionInfo` no longer fails with `NoDataError` when the server sends the end of the answer before the figures. TeamSpeak 6 does this now and then when several commands are in flight; the figures follow a moment later. The voice client now takes the `notifyconnectioninfo` row that names the client asked about, whichever side of the command's `error` it falls on, and waits for it until the command's timeout or signal gives up.
