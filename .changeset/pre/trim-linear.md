---
"@honeybbq/teamspeak": patch
---

Trimming a ServerQuery line's `\r` and a web query URL's trailing `/` takes linear time. A server that sent a very long run of `\r` could stall the query client for seconds with a pattern that retried from each one.
