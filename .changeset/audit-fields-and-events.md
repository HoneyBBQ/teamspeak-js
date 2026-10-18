---
"@honeybbq/teamspeak": minor
---

Events: `ClientMovedEvent.fromChannelID` (`cfid`; absent on TS3, which sends none on a move), and `ClientLeaveEvent.fromChannelID` and `targetChannelID`. `ClientEnterEvent` is now an interface extending `ClientEntry` with `fromChannelID` and `reason`, which the roster and `view.clients` records do not carry. The voice client delivers `clientChatClosed`. `NotificationName.BanUpdate` names `notifybanupdate`, which stays untyped: its forms differ (an addition carries the row, a deletion the id, a delete-all neither). `"tokenused"` is a `QueryEventCategory`, never registered by default.

Records: `Channel.emptyForMs` (undefined for a channel with a client in it, which both servers report as -1), `storageQuota` and `filePath`; `ClientEntry.talkRequestedAt`; `ClientDatabaseEntry.loginName`, `avatarHash` and the four traffic totals of `getClientDatabaseInfo`; `ClientDatabaseName.uid`; `getClientUIDInfoByID` for the nickname and myTeamSpeak id beside the uid; `WhoAmI.serverUUID` and `originServerID`; `VirtualServer.uuid`, `guestCanCreateChannels`, `guestCanCreateHomebase` and `weblistEnabled`; `TempPassword.targetChannelPassword`, a secret.
