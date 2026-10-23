---
"@honeybbq/teamspeak": major
---

`Channel.description` is `string | undefined` and absent unless the answer carried it. `channellist` and the channel notifications never carry the text, so `listChannels`, `client.view` and the events used to report `""` for a channel that may well have a description; they now leave it out. `getChannelInfo` carries it, and so does the voice client's `getChannelDescription`; `channelDescriptionChanged` still says the text changed without sending it. Replace `channel.description` with `(await getChannelInfo(client, channel.id)).description` where you need the text, and treat `undefined` as "not known", not "empty".
