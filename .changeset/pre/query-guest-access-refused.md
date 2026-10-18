---
"@honeybbq/teamspeak": patch
---

`ErrorCode` now names the codes WebQuery refuses access with: `APIKeyOutOfScope` (5120), `APIKeyInvalid` (5122) and `APIKeyMissing` (5124). A query client connecting with `guest: true` to a server that offers no guest access, such as any TeamSpeak 3 server, now rejects with a `GuestAccessError` that says so and keeps the server's refusal as its `cause` (and its code, over WebQuery). The `serverID` option of the WebQuery transport is documented correctly: TeamSpeak 3 runs every command on a virtual server even when none is named.
