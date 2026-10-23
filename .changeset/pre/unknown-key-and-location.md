---
"@honeybbq/teamspeak": major
---

Two rows with a kind this SDK does not name are passed through instead of misread or dropped. A `PrivilegeKey` of a type other than `PrivilegeKeyType.ServerGroup` or `ChannelGroup` has `serverGroupID`, `channelGroupID` and `channelID` all `undefined` and its number in `type`; any type but 1 used to be read as a server group key. A `PermissionLocation` from `permfind` or `permoverview` with an unknown target is returned, with its number in `target` and the raw `id1` and `id2`, where `findPermission` and `getPermissionOverview` used to drop it. Because of that, `location.target === PermissionTarget.Channel` no longer narrows the union to the channel kind: check that the field you read is there (`"channelID" in location`) or handle the rest in a `default` case. `TextMessageEvent.invokerGroups` now says what holds for a ServerQuery client: the groups of the listing taken on connecting, kept by enter, leave and move only.
