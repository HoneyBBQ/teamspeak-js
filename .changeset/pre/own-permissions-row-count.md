---
"@honeybbq/teamspeak": patch
---

`getOwnPermissions` refuses an answer with more rows than permissions asked, as it already refused one with fewer: the rows are matched to the permissions by position, so an extra row leaves no telling which answers which. Both throw `NoDataError`, as Go's `GetOwnPermissions` does.
