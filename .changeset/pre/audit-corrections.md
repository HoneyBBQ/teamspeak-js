---
"@honeybbq/teamspeak": patch
---

`findBans` on a voice client returned no rows on TeamSpeak 6, because its answer, `notifybanfind`, was not in the response table; it now returns the matching bans, and `NotificationName.BanFind` names the notification. `listClients` takes `icon: true` to send `-icon`, which fills `ClientEntry.iconID`. `createChannel` and `editChannel` take `bannerURL` and `bannerMode`. `ServerCapabilities.hostMessageMode` is typed as `HostMessageMode`; a value the table does not name still passes through as sent.
