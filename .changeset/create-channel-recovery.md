---
"@honeybbq/teamspeak": minor
---

`createChannel` looks the channel up by name and parent when the server's answer carries no `cid`, instead of failing a creation that succeeded.
