---
"@honeybbq/teamspeak": patch
---

A command or notification name may have an underscore in it, as TeamSpeak 6 names its S3 file transfer commands (`s3ft_getpresignedurl`) and their answers (`notify_presigned_urls`). Such a line used to be read as a nameless data row, so the answer was attributed by position, a raw command's name was empty for line middleware and tracing, and an answer the server sends without an `error` after it was handed to the next command.
