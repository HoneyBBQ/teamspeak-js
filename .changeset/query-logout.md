---
"@honeybbq/teamspeak": minor
---

`QueryClient` has `logout()` and `unregisterNotifications()`, the counterparts of `login()` and `registerNotifications()`. `logout` also deselects the virtual server; WebQuery refuses both, as its api key is the login and nothing is registered there.
