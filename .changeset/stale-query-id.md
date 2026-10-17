---
"@honeybbq/teamspeak": patch
---

`QueryClient` reads its own client id and the client list again after `use()`, and forgets both after `logout()` and after a `use()` the server refuses, which leaves the connection on no server. Before, a kick on the server it had just selected was missed, and the roster still named the old server's clients. `registerNotifications()` lists the clients again once the server accepts it. A reconnect starts over from the constructor options and does not repeat a `use()` made by hand.

`clientgetvariables`, `getconnectioninfo` and `channelgetdescription` over the voice protocol take only the row that echoes the `clid` or `cid` that was asked about. Another client's update, or the client's own mute broadcast, no longer comes back as the answer.
