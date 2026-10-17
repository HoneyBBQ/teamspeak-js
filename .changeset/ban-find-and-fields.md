---
"@honeybbq/teamspeak": minor
---

`findBans` looks bans up by address, nickname, uid or myTeamSpeak id (`banfind`, TS6 only: TS3 has no such command, and TS6's WebQuery answers it as unknown). A ban can be made with a `mytsid` and a `lastNickname`, and `BanEntry` has the `mytsid` TS6 reports. `listBans` takes `start` and `limit` to page the list. A privilege key can be made with a `customSet` of custom client properties, which `PrivilegeKey` reports back; the set is escaped twice on the wire, because the server's own example, escaped once, cuts a value at its first space.
