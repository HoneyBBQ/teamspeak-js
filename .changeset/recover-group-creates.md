---
"@honeybbq/teamspeak": patch
---

`createServerGroup`, `createChannelGroup`, and `copyServerGroup` / `copyChannelGroup` onto a new group look the group up by name and type when the server's answer carries no id, instead of failing a creation that succeeded. A `NoDataError` from `addPrivilegeKey` or `addAPIKey` now says plainly that the command took effect, so it is not retried blindly.
