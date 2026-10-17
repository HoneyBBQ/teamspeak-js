---
"@honeybbq/teamspeak": minor
---

The client reports changes to channels and to the server as typed events, and the voice client reports its subscriptions, plugin commands and typing.

New events on every client: `channelCreated`, `channelEdited`, `channelMoved`, `channelDeleted`, `channelDescriptionChanged`, `channelPasswordChanged` and `serverEdited`. A ServerQuery client receives them through its `channel` and `server` categories, which are registered by default; `QueryEventsOption` lists what each category delivers. New events on the voice client: `channelSubscribed`, `channelUnsubscribed`, `pluginCommand` and `clientChatComposing`. Neither TeamSpeak 3 over raw ServerQuery nor TeamSpeak 6 over SSH sends a ServerQuery connection these four, nor `clientUpdated`, the group events or `clientChannelGroupChanged`, so the ServerQuery client does not offer them.

`channelCreated` and `channelEdited` carry `changes`, holding only the properties the server sent, under the names `createChannel` and `editChannel` take; for a new channel, a property that is absent has the server's default. `applyChannelChanges` merges one into a record. `serverEdited` carries the changed server properties by their `virtualserver_` names, and none for a welcome message change.

The answer to `getChannelDescription` arrives as an edit with reason `Reason.ChannelUpdate` and no invoker, which is not a change: it produces no `channelEdited`, and still reaches `notification` and the command.

`sendPluginCommand` sends a plugin command to the channel, the server or one client, `sendChatComposing` tells a client that we are typing a private message to it, and `closePrivateChat` tells it that we closed the chat. A ServerQuery connection cannot send them. Each function's documentation says who receives what, as measured on both servers.

A ServerQuery client lists the clients with `-away` and `-voice` when it connects, so the records it learns carry away and mute state.

Every notification is still delivered as `notification`, after its typed event. Code that switches over event names, in event middleware or elsewhere, needs a default case, as it always did.
