---
"@honeybbq/teamspeak": minor
---

`findClientDatabaseByUID` finds database ids by unique identifier (`clientdbfind -uid`), next to `findClientDatabase`, which searches nicknames. On TS3 and TS6, over ServerQuery and the voice protocol alike, the pattern is SQL `LIKE` over the whole uid, ignoring case: without `%` (any run of characters) or `_` (any one character) it must be the entire uid, so a prefix needs a trailing `%`. No match is `[]`, and a server answers at most 50 ids.
