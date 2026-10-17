---
"@honeybbq/teamspeak": minor
---

The client answers `notifyconnectioninforequest` with `setconnectioninfo`, from what it has measured: the keepalive round trip, packets and bytes by class and direction, and bandwidth. `getClientConnectionInfo` reads another client's figures, and `verifyServerPassword` and `verifyChannelPassword` check a password without joining or moving.
