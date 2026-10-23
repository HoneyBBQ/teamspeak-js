---
"@honeybbq/teamspeak": patch
---

A `clientek` datagram that was lost no longer fails the connection. A packet sent again goes out under the key it first went out under: `clientek` is sent under the dummy key and crypto init completes right after, and its resend used to take the session key, which the server cannot decrypt, so the handshake ran into its timeout. Connecting now succeeds with the resend.
