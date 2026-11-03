---
"@honeybbq/teamspeak": minor
---

`ServerFamily`, `ConnectionTrafficClass`, `UIDAlgorithm`, `ViewStatus`, `FileTransferStage` and `QueryEventCategory` are now constants as well as types, and `QueryEventName` from `@honeybbq/teamspeak/query` names the query client's events: `client.on(QueryEventName.TextMessage, (message) => { ... })`. The string values keep working and mean the same, so existing code needs no change.
