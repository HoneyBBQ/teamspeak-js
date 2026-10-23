---
"@honeybbq/teamspeak": patch
---

`uploadFile` no longer mistakes a transfer that was cut short for a stored file, and a transfer whose dial fails no longer lingers on the server.

- After the server closes the transfer connection, `uploadFile` asks for the file's size with `ftgetfileinfo` (one extra command) and fails with a `FileTransferError` when the server holds a different size, or no such file. The servers never report a completed upload (the voice protocol's `notifystatusfiletransfer` comes only for failures, after the close, and ServerQuery sends nothing), so this is the only way to tell a stored file from a transfer someone stopped. A client without browse power gets 2568 for the command and resolves on the close as before.
- When the TCP connection to the file transfer port is refused or times out within 5 seconds of the negotiation, `uploadFile` and `downloadFile` stop the negotiated transfer on the server; left alone, the server keeps it for about 10 seconds. The dial's error is still the one thrown. Not done once the connection opened.
- An upload whose connection the server closed while bytes were still being written now fails with a `FileTransferError`, not the socket's own error.
