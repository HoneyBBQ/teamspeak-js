---
"@honeybbq/teamspeak": minor
---

`ResolverOptions.resolveSrv` takes over the resolver's SRV lookups (`_ts3._udp.<host>` and `_tsdns._tcp.<domain>`), for DNS over HTTPS, another DNS server or a test. It is called with the full name and the resolution's signal and returns `SrvRecord`s, which is now exported from `@honeybbq/teamspeak/client`; a rejection or an empty list means no record, and one that ignores the signal cannot hold resolution up.

`ResolverOptions.fetch` replaces the global `fetch` for the nickname lookup, for a proxy or a test. A `resolveSrv` or `fetch` that is not a function throws a TypeError.
