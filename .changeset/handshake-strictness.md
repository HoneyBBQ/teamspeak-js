---
"@honeybbq/teamspeak": patch
---

Three handshake details now behave the same as in the Go SDK. Traffic counted for `setconnectioninfo` includes only datagrams that decrypted, not noise. An empty `Init1` packet is ignored, like a malformed step, instead of failing the attempt: it carries no authentication, so anyone could send one. `Crypt.setSharedSecret` throws a `HandshakeError` for an alpha that is not 10 bytes, an empty beta, or a secret shorter than the IV, where it padded them with zeros.
