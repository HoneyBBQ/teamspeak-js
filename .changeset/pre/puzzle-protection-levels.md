---
"@honeybbq/teamspeak": patch
---

A client can now connect to a TeamSpeak server that is under a burst of connections. Such a server raises its protection level and asks for a bigger Init1 puzzle: 100000 squarings at level 1 and 1000000 at level 2, where it asks for 10000 when calm. The client refused anything above 100000, so it could not connect at all. The cap is now 4000000, four times the highest level either server asks for. The puzzle is solved in slices that give the event loop back, so timers and other connections keep running meanwhile, and a cancelled `connect()` stops solving and rejects with its own reason. A level above the cap rejects with the new `PuzzleTooHardError`, a `HandshakeError` that carries the `level` asked for and the `maxLevel` allowed.
