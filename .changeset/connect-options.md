---
"@honeybbq/teamspeak": minor
---

`ClientOptions` takes a `privilegeKey`, which the server redeems while the client joins, and `metaData`, which other clients see in their record of it; `updateClient` takes `metaData` too. `disconnect()` takes a `reasonMessage` that bystanders receive in `clientLeave`. The goodbye now carries `reasonid=8`, without which both servers drop the message.
