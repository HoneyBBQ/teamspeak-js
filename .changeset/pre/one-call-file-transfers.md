---
"@honeybbq/teamspeak": minor
---

Files: `uploadFile` and `downloadFile` (from `@honeybbq/teamspeak/client`) negotiate a transfer and move its bytes in one call, over a voice `Client`, or over a `QueryClient` on raw TCP or SSH when given the file transfer host as `host`; WebQuery refuses every file command (error 5120) on both servers. `uploadFile` takes bytes, or a `Readable` with its `size`; `downloadFile` returns the bytes, or writes into a `dest` stream, and refuses a file over `maxSize` (256 MiB) when it would hold it in memory. `listFilesRecursive` (from the package) lists a directory and everything under it, each entry with its full path, down to `maxDepth` levels (16 by default).

`Client.uploadFileData` and `Client.downloadFileData` now accept `idleTimeoutMs`, which they always passed on.

Docs: `createDirectory` does not make missing parents, as its doc comment said; on TeamSpeak 3 and 6 a path whose parent is missing is refused with error 2052.
