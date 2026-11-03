---
"@honeybbq/teamspeak": minor
---

`Resolver`, `ResolverOptions` and `lookupTSDNS` are exported from `@honeybbq/teamspeak/client`. `new Resolver().resolve("ts.example.com")` shows where an address leads, the way the client resolves it, and `lookupTSDNS(server, host)` asks one TSDNS server for the targets of a name: a list of entries as the server gave them, empty when it has no record, and a rejection when the connection fails, no answer comes in three seconds or the signal aborts.

The official TSDNS server ends its answer by closing the connection, with no line break, and the resolver never read such an answer: it waited out the timeout and counted it as no answer. It is read now. An answer that lists several targets gives one `ResolvedAddr` each, in order. An entry without a port means 9987, and the port `$PORT` means the port of the address being resolved, as TeamSpeak reads them; `lookupTSDNS` returns the entries as the server sent them.

`ResolverOptions.nicknameService` sets the nickname lookup endpoint (an http: or https: URL, `https://named.myteamspeak.com/lookup` by default), for a test double or a mirror; it is used only with `nicknameLookup`.
