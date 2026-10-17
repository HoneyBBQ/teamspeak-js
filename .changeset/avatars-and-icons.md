---
"@honeybbq/teamspeak": minor
---

Avatar and icon helpers. `uploadAvatar` hashes an image, uploads it and sets the client's avatar flag; `downloadAvatar` reads any client's avatar from `avatarFileName(uid)`, the name the server stores it under (`avatar_` and the unique id in the letters a to p, which is not the MD5 name); `removeAvatar` deletes your own. `uploadIcon` sends an icon under its CRC-32 id (`iconIDOf`), `downloadIcon` and `removeIcon` read and delete one, and `setChannelIcon`, `setServerGroupIcon`, `setChannelGroupIcon`, `setClientIcon` and `setServerIcon` point a record at it. `Client` has a `host` getter.
