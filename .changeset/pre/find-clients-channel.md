---
"@honeybbq/teamspeak": minor
---

`findClients` takes `channelID` and `channelUID` to report where each match is, as `ClientMatch.channelID` and `channelUID`. They report and do not filter, and TS6 only: TS3 accepts the flags and sends neither. `FileUploadInfo` and `FileDownloadInfo` carry the `ip` the server sends when the file transfer is not reachable at the command connection's address, undefined otherwise. `listChannels` also asks for `-secondsempty` and `-banners`; `Channel` has no field for them yet.
