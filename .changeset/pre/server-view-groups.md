---
"@honeybbq/teamspeak": minor
---

The view of a voice client now holds the groups and the server's properties, and tells you when it changed. `view.serverGroups` and `view.channelGroups` are the server's group lists in its order, replaced whole when the server sends a new one (after a group is added, renamed, copied or deleted); `view.groupsLoaded` is `true` once both have arrived, which is just after `viewReady`, so a UI that needs them waits for it. A group's permissions are not announced and are not in the view. `view.server` holds the `virtualserver_*` properties by the names `getServerInfo` uses, from the server's welcome, patched by `serverEdited` and merged with every `getServerVariables` answer. The server does not spell out every edit: a new welcome message, host message or client limit arrives as an empty `serverEdited`, so call the new `getServerVariables(client)` after one to bring those up to date. It returns the whole answer, counters included; `view.server` never holds the counters and statistics that change by themselves, such as clients online and uptime.

The new `viewChanged` event, `{ revision }`, is delivered once after the typed events of whatever arrived together, so a UI that redraws from the view needs one listener. It is not sent while the view is loading, nor when the revision is the one `viewReady` or the last `viewChanged` gave, and it is sent once when the view goes stale. It never replaces the typed events.

`channelDeleted` and `clientLeave` now carry `previous`, the channel or client as the view held it just before, so a listener can say what was removed. It is absent when the client did not know it, and always absent on a ServerQuery client. All of this is experimental.
