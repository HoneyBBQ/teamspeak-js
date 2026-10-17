---
"@honeybbq/teamspeak": minor
---

The voice client reports changes to other clients as typed events, and keeps its record of them current.

New events: `clientUpdated`, `clientServerGroupAdded`, `clientServerGroupRemoved` and `clientChannelGroupChanged`. A TeamSpeak 3 ServerQuery connection does not receive these from the server, so the ServerQuery client does not offer them.

`clientUpdated` carries `changes`, holding only the properties the server sent, under the names `updateClient` takes; a property that is absent did not change. `applyClientChanges` and `applyChannelChanges` merge a change into a record and return a new one.

`TextMessageEvent.invokerGroups` no longer goes stale: the voice client updates what it knows of a client when its groups change, and refreshes its channel group when that changes in the channel the client is in. A ServerQuery client still reads groups from the listing it took when it connected.

`ClientEntry` gains optional `databaseID`, `awayMessage`, `isInputMuted`, `isOutputMuted`, `talkPower`, `description`, `avatar`, `country`, `version`, `platform` and others, and `Channel` gains `isMaxClientsUnlimited`, `deleteDelayMs`, `namePhonetic` and others. They are `undefined` where the answer did not carry them, such as a field no `listClients` flag brings; `getChannelInfo` fills the channel ones.

Every notification is still delivered as `notification`, after its typed event. Code that switches over event names, in event middleware or elsewhere, needs a default case, as it always did.
