---
"@honeybbq/teamspeak": minor
---

Four more value tables, for what a server reads and writes as bare numbers and strings: `BannerMode` (`channel_banner_mode` and `virtualserver_hostbanner_mode`), `CodecEncryptionMode` (`virtualserver_codec_encryption_mode`), `VirtualServerStatus` (`virtualserver_status`) and `BindingSubsystem` (`bindinglist`'s `subsystem`). Compare `VirtualServer.status` and `WhoAmI.serverStatus` with `VirtualServerStatus`. The client adds `ResolveSource`, the values the built-in resolver sets in `ResolvedAddr.source`.

`CommandName` names `clientchatclosed`, `clientchatcomposing` and `plugincmd`, the voice-only commands the SDK sends, so command middleware can compare against them.

A stopped server a ServerQuery client selected with `-virtual` reports `online virtual`, not `virtual online` as the `VirtualServerStatus` property description said.
