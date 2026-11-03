---
"@honeybbq/teamspeak": minor
---

`getOwnPermissions(client, permissions)` reads several of this connection's own permissions with one `permget` and answers one entry per permission, in the order asked; a permission whose value is 0 is answered with 0, and one the server does not know refuses the whole command with 2562. TS6's WebQuery answers a row that names a permission by name with the permission of an earlier row named by id, so a list that mixes ids and names is sent as two commands and put back in the order asked.

`client.roundTrip` is the keepalive round trip of the voice connection, `{ meanMs, deviationMs }` over the last 10 pongs, or `undefined` when the client is not connected or no pong has come back yet (the first comes about 5 seconds after connecting). It is the ping this client reports to the server, so it is what other clients see as its ping. The new `RoundTripEstimate` type describes it.
