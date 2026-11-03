---
"@honeybbq/teamspeak": minor
---

`isValueOf(table, value)` checks a value against any of the SDK's tables and narrows it to the table's type, for a value read back from storage or a configuration file before it is passed as a parameter: `if (isValueOf(BannerMode, saved)) editChannel(client, cid, { bannerMode: saved })`. The tables hold the server's own numbers and strings, so a stored value reads back unchanged; `isValueOf` does not convert, so `"2"` is not `2`.

`editServer`, `editInstance` and `createServer` take a number, a bigint or a boolean (sent as 1 or 0) as well as a string for a raw property, so a table's constant goes in as it is, and an editor offers the `virtualserver_*` or `serverinstance_*` names of `PropertyName` for the keys (`ServerSettings`, `InstanceSettings`, `PropertyValue`). A value that is not a string was left out before. `getPermissionIDByName` offers the names of `PermissionName`, and still takes any other.
