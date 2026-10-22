---
"@honeybbq/teamspeak": patch
---

`Streams.publish` matches the server's announcement to its own call by the command's `return_code`, not by the stream's name. Two publishes of one name, or a publish after one that timed out, can no longer get each other's stream, and a call that gave up still has the stream it started stopped. Calls no longer wait for one another. `client.send("setupstream", …)` now resolves with the announcement row of the stream it started, and waits for it, where it used to resolve at once with no rows. The command counter is no longer reset on reconnect, so an answer left over from an earlier connection cannot match a new command.
