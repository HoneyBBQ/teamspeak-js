---
"@honeybbq/teamspeak": major
---

`ClientDatabaseEditOptions.nickname` and `ServerGroupClientListOptions.uids` are gone: neither ever worked. `editClientDatabase(c, cldbid, { nickname })` sent `client_nickname`, which `clientdbedit` does not take, and both TeamSpeak 3 and TeamSpeak 6 answered error 1542 (missing required parameter); the command only edits `description`, and there is no way to change a stored nickname through it. `listServerGroupClients(c, sgid, { uids })` sent `-uid`, which `servergroupclientlist` ignores, so the rows stayed `cldbid` only. Pass `names: true` instead: the server then returns each member's nickname and unique identifier together, so `ServerGroupMember.uid` is filled by `names`.
