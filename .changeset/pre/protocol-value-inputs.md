---
"@honeybbq/teamspeak": major
---

Two inputs take a value table instead of a bare `number` or `string`. `ChannelSettings.bannerMode`, so `createChannel` and `editChannel`, is a `BannerMode`: pass a constant such as `BannerMode.AdjustKeepAspect`, or 0, 1 or 2. `BindingListOptions.subsystem` is a `BindingSubsystem`: pass `BindingSubsystem.Query`, or `"voice"`, `"query"` or `"filetransfer"`. A banner mode outside 0-2 or any other subsystem was always refused by the server, with error 1538. What the SDK reads back keeps its plain type.
