---
"@honeybbq/teamspeak": major
---

File transfers are checked against the server and support resume.

- An upload resolves once the server has closed the transfer connection, which it does when it has the file, not when the local socket finished. `uploadAvatar` and `uploadIcon` therefore announce a file the server holds. A connection that closes early, or stays open for the idle limit, fails the upload.
- An upload counts its bytes: a stream that gives fewer or more than `size` fails the call. `uploadFileData` takes the size and the position from the negotiation, so `data` must give exactly `info.size - info.seekPosition` bytes. `FileUploadInfo` gains `size`, and `FileDownloadInfo` gains `seekPosition`.
- Resume works: `uploadFile(..., { resume: true })` sends only what the server does not hold (`data` is still the whole file), and `downloadFile(..., { seekPosition })` fetches from that offset. A download from `seekPosition` expects `size - seekPosition` bytes, which is what the servers send; before, any seek failed as a short download.
- `downloadFileData` and `downloadFile` with `dest` no longer end or destroy your stream, as documented, so one stream can take several downloads. Errors still reject the call.
- `downloadFile` over `maxSize` stops the transfer it negotiated; before, it was left open on the server.
- A port outside 1 to 65535 in a negotiation fails the transfer before any dial.
- **Breaking:** `FileUploadInfo.ip` and `FileDownloadInfo.ip` are gone. Neither server sends one, over ServerQuery or the voice protocol, and transfers always dialled the connection's host. If you read `info.ip`, use the host you connected to. Code that builds a `FileUploadInfo` by hand needs `size`, and a `FileDownloadInfo` needs `seekPosition`.
