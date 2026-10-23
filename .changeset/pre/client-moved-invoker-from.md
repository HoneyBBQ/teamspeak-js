---
"@honeybbq/teamspeak": major
---

`clientMoved` names no invoker when the server names none. A client's own move (reason 0) carries no invoker on TeamSpeak 3 and TeamSpeak 6, and `invokerID`, `invokerName` and `invokerUID` are now `0`, `""` and `""` for it on both clients; the voice and ServerQuery clients used to fill the name and uid from the roster, so a client that moved itself looked as if it had moved itself by name. Test `event.reason === Reason.None` (or `invokerID === 0`) for "moved on its own". In exchange `fromChannelID` is filled when the server sends no `cfid`, as TeamSpeak 3 does on every move: it is then the channel the client was known to be in, which is otherwise lost because the roster and `client.view` are updated before the event is delivered. It is absent only for a client that was not known.
