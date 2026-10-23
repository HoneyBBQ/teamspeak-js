---
"@honeybbq/teamspeak": patch
---

A change notification that clears a value is no longer lost. `notifyclientupdated client_icon_id=0` and `notifychanneledited channel_icon_id=0` now leave `client.view` and the channel tree without the icon, where they kept the old one. `ClientChanges` and `ChannelChanges` hold a key for everything the notification carried, so a cleared value is a key holding `undefined`: `"iconID" in changes` is true and `changes.iconID` is `undefined`. The same holds for `emptyForMs` (-1 on the wire) and `talkRequestedAt`. `applyClientChanges` and `applyChannelChanges` remove such a property from the record and keep one the changes lack. If you merge changes into your own records, treat a key holding `undefined` as "cleared", not "unchanged".
