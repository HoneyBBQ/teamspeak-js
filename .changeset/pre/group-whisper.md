---
"@honeybbq/teamspeak": minor
---

`sendWhisper` can name channels as well as clients (`WhisperTargets.channels`), and the new `sendGroupWhisper` whispers to a server group, a channel group, the channel commanders or everyone, within the channels a scope picks. `GroupWhisperType` and `GroupWhisperScope` name the packet's two enums, and `GroupWhisperTarget` ties the group id to the type that takes it.
