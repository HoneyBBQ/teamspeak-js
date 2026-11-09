---
"@honeybbq/teamspeak": minor
---

`ServerExtension` names the extensions a server lists in `virtualserver_capability_extensions` (`serverCapabilities.extensions`), as TeamSpeak 6 6.0.0-beta13.1 sends them: `FileTime` (`"FILETIME"`), `StreamP2P` (`"STREAM_P2P"`, which streams need) and `S3` (`"s3"`, which S3 file transfer needs). Test one with `extensions.includes(ServerExtension.S3)`.
