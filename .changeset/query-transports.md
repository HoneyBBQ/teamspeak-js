---
"@honeybbq/teamspeak": minor
---

ServerQuery transports: the session is kept open, a bad line or key is refused, and WebQuery is stricter.

Added: `keepAliveMs` on `QueryClient` sends `version` when a raw TCP or SSH session has been idle for that long (two minutes by default, `0` turns it off). The server closes a query session that sent no command for 300 seconds (measured on TeamSpeak 3 3.13.8 over raw TCP and SSH, and on TeamSpeak 6 6.0.0-beta13.1 over SSH), so a long-lived connection used to drop on its own. `LineTooLongError`: a raw TCP or SSH connection ends with it when the server sends a line longer than 256 MiB. `QueryTransport.send` takes an optional `{ signal }`, aborted when the command stops waiting; a custom transport may ignore it.

Changed: a parameter name must be letters, digits and underscores, with one leading `-` for a flag; `editServer`, `editInstance` and `createServer` throw a `TypeError` for any other settings key instead of escaping it into something the server would misread. `listFilesRecursive`'s `maxDepth` now counts levels as `find -maxdepth` does: pass 1 where you passed 0 (the starting directory only), 2 where you passed 1, and so on; 0 is refused. `connectSsh` refuses the user name `guest` with a password with a `TypeError`, since TeamSpeak 6 logs that user in as a guest whatever the password; use `guest: true`. The client's initial roster is read the same way in both SDKs, and the roster is a snapshot kept up to date by the enter, leave and move notifications only.

Fixed: a refused `login` or `use` at connect time now ends the reconnect loop with the server's own error, as `defaultShouldRetry` documents (the check was never called), and 1033 (server is not running) is among the refusals not retried. WebQuery sets a per-request abort tied to the command's timeout and to `close()`, never follows a redirect (a 3xx is a `WebQueryHttpError`; the api key stayed a header on a followed redirect), and writes a JSON null, nested value or boolean in an answer row as empty, `0` or `1` instead of `null`, `[object Object]` or `true`. A line is scanned once however many chunks it arrives in; a 62 MiB line took 35 seconds before.
