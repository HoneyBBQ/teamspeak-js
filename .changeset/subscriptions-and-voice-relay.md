---
"@honeybbq/teamspeak": patch
---

Documentation, from live measurement on TeamSpeak 3 3.13.8 and 6 6.0.0-beta13.1. `subscribeChannel` and `CommandName.ChannelSubscribe` said a subscription brings the channel's voice; it does not, voice reaches only the clients in the channel. The subscription functions and the view now say that joining or moving into a channel subscribes to it without a `channelSubscribed`, that leaving keeps the subscription, and that the channel this client is in cannot be unsubscribed from. `sendVoice`, `sendWhisper`, `updateClient`'s fields and the guide's new "What the server relays" say when the server drops voice: a speaker without talk power (channel voice only), away, input-muted or without input hardware, and a listener output-muted or without output hardware.
