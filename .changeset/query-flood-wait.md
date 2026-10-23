---
"@honeybbq/teamspeak": patch
---

A `QueryClient` over raw TCP or SSH no longer fails a command the server refused as flooding (`error id=524`, `please wait 1 seconds`) when the pause fits in the command's timeout: it holds the queue for the pause the server names and sends the command again, up to three times. The server does not run a refused command, and asking again before the pause is over only prolongs it (and then the address is banned for the instance's `serverquery_ban_time`). A pause longer than the command has left, such as a ban, still fails the command with the server's error at once. WebQuery is unchanged: the server closes the connection of a flooding client without an answer.
