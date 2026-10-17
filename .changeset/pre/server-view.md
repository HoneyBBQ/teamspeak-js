---
"@honeybbq/teamspeak": minor
---

The voice client reads the server for you. `client.view` holds the channel tree in the server's order (`channels`, `channel`, `children`, `path`), the clients the client has been told about (`clients`, `client`, `clientsIn`) and its own record (`self`), and follows the server's notifications on its own. `view.status` is `"empty"`, `"loading"`, `"live"` or `"stale"`, `view.revision` counts every change, and `await view.whenReady()` or the new `viewReady` event tells you the welcome is done; it rejects if the connection ends first. After a disconnect the last view stays readable as `"stale"`, and the next `connect()` clears it. The view is experimental. Its `totalClients` and `totalFamilyClients` are `undefined`, because the server counts a channel's clients once, in the welcome, and never again: count `clientsIn(id)` instead.

The server changes the order of a channel's neighbours without saying so, so a record's `order` can go stale. `ChannelTree` (exported from the package root) applies the channel events with the server's rules and derives `order` from the position, and the view uses it. You can use it too, on a ServerQuery connection: `ChannelTree.from(await listChannels(q))`, then `tree = tree.apply(event)` for `channelCreated`, `channelEdited`, `channelMoved` and `channelDeleted`.

Fixed: after `channelUnsubscribed` the client kept the clients of that channel, and `invokerGroups` kept reading them. The server never says they left, so the client now forgets them (this client's own record stays); a client that comes into view again arrives as a new `clientEnter`. Code that follows the events alone has to do the same.
