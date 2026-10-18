---
"@honeybbq/teamspeak": patch
---

Query: the `web` transport reaches WebQuery over HTTPS. The built-in `fetch` uses `node:https` for an `https:` URL, such as TeamSpeak 3's port 10443, and verifies the certificate against Node's trust store; it never skips that check. A private CA is trusted with `NODE_EXTRA_CA_CERTS` or a `fetch` you pass. A URL with any scheme but `http:` or `https:` now throws a `TypeError` when the client is built, unless you pass your own `fetch`.
