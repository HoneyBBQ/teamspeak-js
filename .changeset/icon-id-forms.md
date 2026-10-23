---
"@honeybbq/teamspeak": patch
---

Icon ids above 2^31 are read in every form the server sends them. The voice protocol announces a channel's new icon in `notifychanneledited` as the negative 32-bit id sign-extended to 64 bits (`18446744072424443899` for the icon `3009859579`), which was read as no icon, so `channelEdited` and the view reported none. It is now read as the same unsigned id as `channelinfo`'s and `servergrouplist`'s forms, wherever an icon id is parsed.
