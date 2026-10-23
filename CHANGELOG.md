# @honeybbq/teamspeak

Until 1.0.0-beta.4 this package was published as `@honeybbq/teamspeak-core`, and
`@honeybbq/teamspeak-client` was a second package. The sections below, down to
the last version heading, are the core's history; the client's is at the bottom.

## 1.0.0-beta.19

### Major Changes

- [#134](https://github.com/HoneyBBQ/teamspeak-js/pull/134) [`57833d3`](https://github.com/HoneyBBQ/teamspeak-js/commit/57833d36ba401f64ecad49c0324646a1d54a25d3) - `client.serverCapabilities` keeps only what lasts the connection, and reports the server's protocol extensions. `extensions` lists the names in `virtualserver_capability_extensions`, in the server's order: `["FILETIME", "STREAM_P2P"]` on TeamSpeak 6, empty on TeamSpeak 3. Test one with `extensions.includes("STREAM_P2P")`. The SDK does not refuse a command because a name is missing.

  `name`, `iconID` and `hostBannerImageURL` are no longer on `ServerCapabilities`. They were read once in the handshake and went stale when the server was edited. Read them from the view, which follows the edits: `client.view.serverName`, `client.view.serverIconID` (the unsigned CRC32 as before, `undefined` for none) and `client.view.serverBannerImageURL`. `welcomeMessage`, `hostMessage` and `hostMessageMode` stay, since they are what the server greeted this connection with.

- [#136](https://github.com/HoneyBBQ/teamspeak-js/pull/136) [`364faa8`](https://github.com/HoneyBBQ/teamspeak-js/commit/364faa86874a0f06a225c0a34ee32fa3382391f0) - `Streams` goes by what the server says it supports, not by its version: `supported`, `publish` and `watch` need the server to name `STREAM_P2P` among its extensions (`client.serverCapabilities.extensions`), as TeamSpeak 6 does. A server that does not name it gets a `StreamsUnsupportedError` before anything is sent, whatever its version, and the error now carries the `extensions` the server named. A client double passed to `new Streams(...)` needs `serverCapabilities.extensions`; a voice `Client` already has it.

### Minor Changes

- [#142](https://github.com/HoneyBBQ/teamspeak-js/pull/142) [`81c88ed`](https://github.com/HoneyBBQ/teamspeak-js/commit/81c88eddef0c6dbd37e2c76c30ebad6a5d4f67d2) - `StreamInfo.transport` says how a stream's media travels, from the `mode` the server announces: `"p2p"` for peer to peer, the one mode this SDK publishes and watches, or the number for a mode it has no name for. `watch` refuses a stream in another mode with the new `StreamTransportUnsupportedError` (`streamId`, `transport`) before sending anything, where it used to ask the publisher and fail later. A stream whose mode the server has not said is watched as before.

- [#140](https://github.com/HoneyBBQ/teamspeak-js/pull/140) [`89dff4b`](https://github.com/HoneyBBQ/teamspeak-js/commit/89dff4bceaf7695038d77652b2cac18b9f51fa4c) - `ServerError.failedPermission` names the permission a refusal lacked, as WebQuery reports it in `status.failed_permission` (for example `b_serverinstance_info_view` for a guest's `hostinfo`). Over WebQuery the permission was dropped, so a refusal never said which one; the voice protocol and raw or SSH ServerQuery still report an id, in `failedPermissionID`. The name is kept as the server sent it, and is `undefined` when the server named none.

### Patch Changes

- [#138](https://github.com/HoneyBBQ/teamspeak-js/pull/138) [`3bff8e8`](https://github.com/HoneyBBQ/teamspeak-js/commit/3bff8e808ae4f8663fec086c7bef64af6a162a97) - A change notification that clears a value is no longer lost. `notifyclientupdated client_icon_id=0` and `notifychanneledited channel_icon_id=0` now leave `client.view` and the channel tree without the icon, where they kept the old one. `ClientChanges` and `ChannelChanges` hold a key for everything the notification carried, so a cleared value is a key holding `undefined`: `"iconID" in changes` is true and `changes.iconID` is `undefined`. The same holds for `emptyForMs` (-1 on the wire) and `talkRequestedAt`. `applyClientChanges` and `applyChannelChanges` remove such a property from the record and keep one the changes lack. If you merge changes into your own records, treat a key holding `undefined` as "cleared", not "unchanged".

- [#141](https://github.com/HoneyBBQ/teamspeak-js/pull/141) [`ab9393a`](https://github.com/HoneyBBQ/teamspeak-js/commit/ab9393a82b6921dde7d279387689377ddf1382b5) - A channel created while a client is connected now holds the server's defaults in `view.channel(id)`, as the next welcome lists it, instead of zeros: codec 4, quality 5, no client limit, and the rest of what the notification does not carry.

- [#137](https://github.com/HoneyBBQ/teamspeak-js/pull/137) [`339323f`](https://github.com/HoneyBBQ/teamspeak-js/commit/339323f9492645471e928b8bcd9790047b5c6511) - Icon ids above 2^31 are read in every form the server sends them. The voice protocol announces a channel's new icon in `notifychanneledited` as the negative 32-bit id sign-extended to 64 bits (`18446744072424443899` for the icon `3009859579`), which was read as no icon, so `channelEdited` and the view reported none. It is now read as the same unsigned id as `channelinfo`'s and `servergrouplist`'s forms, wherever an icon id is parsed.

- [#139](https://github.com/HoneyBBQ/teamspeak-js/pull/139) [`c7fc424`](https://github.com/HoneyBBQ/teamspeak-js/commit/c7fc424804cece314b0a4b765eb376406a717c6f) - A client that reconnects now asks for the nickname it was given, not the one the server called it. When the requested name was taken the server assigns a suffixed one ("bot" becomes "bot1"), and the reconnect used to ask for "bot1" and get "bot12" while the old session still held it, drifting further on every drop; an admin's rename stuck across reconnects in the same way. Every connection attempt now sends the requested name, which a successful `clientupdate` of the client's own nickname changes. The nickname the server reports for the client, in `clientEnter`, `clientUpdated`, the view and the trace, is unchanged.

## 1.0.0-beta.18

### Minor Changes

- [#128](https://github.com/HoneyBBQ/teamspeak-js/pull/128) [`44ee319`](https://github.com/HoneyBBQ/teamspeak-js/commit/44ee319b0e7d47592d4394882d9757e58a79e7b2) - `findClientDatabaseByUID` finds database ids by unique identifier (`clientdbfind -uid`), next to `findClientDatabase`, which searches nicknames. On TS3 and TS6, over ServerQuery and the voice protocol alike, the pattern is SQL `LIKE` over the whole uid, ignoring case: without `%` (any run of characters) or `_` (any one character) it must be the entire uid, so a prefix needs a trailing `%`. No match is `[]`, and a server answers at most 50 ids.

## 1.0.0-beta.17

### Patch Changes

- [#126](https://github.com/HoneyBBQ/teamspeak-js/pull/126) [`49731f7`](https://github.com/HoneyBBQ/teamspeak-js/commit/49731f716b323d83635462f925771ab166214f1f) - Stream events wait for a listener again after the last one unsubscribes, up to the same bound, instead of going nowhere. Signalling that a publisher still sends for a stream whose view the app has left or closed is ignored instead of being reported to `error` one message at a time.

- [#124](https://github.com/HoneyBBQ/teamspeak-js/pull/124) [`7c8c9e9`](https://github.com/HoneyBBQ/teamspeak-js/commit/7c8c9e90763eca2883e5ac9205b0c97201d90682) - Trimming a ServerQuery line's `\r` and a web query URL's trailing `/` takes linear time. A server that sent a very long run of `\r` could stall the query client for seconds with a pattern that retried from each one.

## 1.0.0-beta.16

### Minor Changes

- [#121](https://github.com/HoneyBBQ/teamspeak-js/pull/121) [`45643e6`](https://github.com/HoneyBBQ/teamspeak-js/commit/45643e6db3b946d2a2137fef5b73f2058b19736f) - Streams: a `JoinRequest` now has `on("closed", ({ cause }) => …)`, emitted once when a request nobody had answered ends, with the cause `"withdrawn"` (the viewer took it back, left the stream or went out of view) or `"ended"` (the stream ended or was disposed), so an application can drop the request from its UI without polling `state`. It is not emitted for a request that is accepted or denied, and a listener added late still receives it. `Streams` has a `"warning"` event, kept for the first listener as errors are, with `{ code, streamId, clientId, message }`; the first code is `"offer-without-audio"`, for an offer given to `JoinRequest.accept` or `ViewerPeer.sendOffer` with no `m=audio` section, which is sent unchanged. The TeamSpeak 6 client 6.0.0-beta5 never answers a video-only offer, and its Join button then does nothing. The README gains an interop section for the TeamSpeak 6 client: always offer audio, trim the codecs, accept every request, and what a channel switch does.

- [#122](https://github.com/HoneyBBQ/teamspeak-js/pull/122) [`ce058fb`](https://github.com/HoneyBBQ/teamspeak-js/commit/ce058fb31d9cb620ef73e2eb6850a7dd23d2249a) - The `@honeybbq/teamspeak/stream` entry point is no longer `@beta`: its exports follow the package's semver like the rest. TeamSpeak does not document the stream protocol; it was verified against the TeamSpeak 6 server 6.0.0-beta13.1 and the TeamSpeak 6 client 6.0.0-beta5, and a TeamSpeak update may break it.

## 1.0.0-beta.15

### Minor Changes

- [#110](https://github.com/HoneyBBQ/teamspeak-js/pull/110) [`79fa5f9`](https://github.com/HoneyBBQ/teamspeak-js/commit/79fa5f9edcb820ebf19d48a513d3aa3b4a2b73a8) - Streams, experimental: `@honeybbq/teamspeak/stream` does the signalling of a TeamSpeak 6 screen share. `Streams` attaches to a connected or connecting `Client` and finds the streams of the clients in view (a client that sets `client_is_streaming` is asked for them with `requeststreaminfo`, so a stream that started before you came is found too); `publish` starts a stream and emits a `request` for each client that asks to watch, to `accept` with an SDP offer or `deny`; `watch` asks to watch and resolves with the publisher's offer. Peers carry the SDP answer, ICE candidates and any other signalling message as strings, so any WebRTC stack plugs in: the package has no WebRTC dependency, and the video itself is the application's. Candidates and answers that arrive before a listener is added are kept for the first one.

  The protocol is undocumented by TeamSpeak and was measured on TeamSpeak 6 6.0.0-beta13.1 only, not against the native client, so every export is `@beta`. A TeamSpeak 3 server does not answer the stream commands at all: `publish` and `watch` throw a `StreamsUnsupportedError` before sending. The server drops a command line over about 9.2 KB without an answer, so stream commands throw a `StreamPayloadTooLargeError` instead of timing out. It also enforces neither the viewer limit nor the accessibility of a stream, lets anyone stop any stream, and relays requests from every channel: deciding who watches is the publisher's job, and `Streams` sends `stopstream` only for streams it published.

  The core names the stream commands (`CommandName.SetupStream`, `JoinStreamRequest`, `RespondJoinStreamRequest`, `StreamSignaling`, `StopStream`, `RequestStreamInfo`), their notifications (`NotificationName.StreamStarted`, `StreamInfo`, `StreamStopped`, `StreamClientJoined`, `StreamClientLeft`, `StreamSignaling`, `JoinStreamRequest`, `RespondJoinStreamRequest`) and the error codes `ErrorCode.StreamNotFound` (5635), `StreamNotParticipating` (5636), `StreamAlreadyJoined` (5638) and `StreamJoinRequestRedacted` (5639).

  A stream whose `publish` gave up after the command went out is stopped when the server announces it, `dispose()` stops what it published and leaves what it watched while connected, and a client that stops streaming has its streams dropped with the cause `"gone"`. A requester out of view is looked up with `clientgetuidfromclid`, so `rememberDenied` works for it; the remembered uids are bounded to the 1024 most recent.

### Patch Changes

- [#116](https://github.com/HoneyBBQ/teamspeak-js/pull/116) [`d5aad27`](https://github.com/HoneyBBQ/teamspeak-js/commit/d5aad271ad28331d3b12936a8febc63a1e279d42) - Voice, whisper, ping and pong now follow the generation of their own inbound 16-bit packet ids, so audio from the server keeps decrypting after a packet id wraps from 65535 to 0, also when packets were lost across the wrap.

- [#109](https://github.com/HoneyBBQ/teamspeak-js/pull/109) [`bf6de0d`](https://github.com/HoneyBBQ/teamspeak-js/commit/bf6de0d45d628e78c34974bb9513a83a248e18a8) - Docs: the package description, the README and the `client` entry point's doc comment call the SDK an independent implementation instead of a clean-room one, and the README's disclaimer says it implements the client side only.

- [#119](https://github.com/HoneyBBQ/teamspeak-js/pull/119) [`c0b4a1b`](https://github.com/HoneyBBQ/teamspeak-js/commit/c0b4a1ba286d0ff086aa013927542e34b0d62345) - `Streams.publish` matches the server's announcement to its own call by the command's `return_code`, not by the stream's name. Two publishes of one name, or a publish after one that timed out, can no longer get each other's stream, and when a call gives up, by timeout or abort, its command stays open for five more seconds and a stream announced in that time is stopped. A call aborted or timed out before its command leaves the throttle still sends it and then stops the stream, so other clients may see it start and stop. `dispose()` during a `publish` stops the stream the server announces afterwards, while the client is connected. Calls no longer wait for one another. `client.send("setupstream", …)` now resolves with the announcement row of the stream it started, and waits for it, where it used to resolve at once with no rows. The command counter is no longer reset on reconnect, so an answer left over from an earlier connection cannot match a new command.

## 1.0.0-beta.14

### Minor Changes

- [#102](https://github.com/HoneyBBQ/teamspeak-js/pull/102) [`10fd2ce`](https://github.com/HoneyBBQ/teamspeak-js/commit/10fd2ce2478a191dd703b9281aec158dffe62ea0) - Commands that take a list now take one: `kickClients`, `moveClients` and `banClients` (which returns every ban id the server reports) for several clients; `addClientsToServerGroup` and `removeClientsFromServerGroup` for group membership; and `addChannelPermissions`, `addChannelGroupPermissions`, `addChannelClientPermissions`, `addClientPermissions`, `addServerGroupPermissions` and `addServerGroupPermissionsByType`, with a `delete…` twin for each, for permission batches. Each sends one command with a row per item. `continueOnError` sends `-continueonerror` on the commands the server documents it for.

  The server answers a batch with one status, never one per item, so these resolve to nothing, and each doc comment says what was measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1: what a failing item leaves applied, and which error the switch leaves. A permission batch with an unknown permission, an unreadable value or a missing key is refused whole; one with a row the caller lacks the power for is applied in order, stopping at that row, or skipping it with the switch. For kick, move and ban the switch hides the failure, and for group membership it reports the last one.

  Docs: `getPermissionIDByName` rejects with error 2562 for a name the server does not know, as it always did; its doc comment said it resolved to `undefined`.

- [#103](https://github.com/HoneyBBQ/teamspeak-js/pull/103) [`b2de662`](https://github.com/HoneyBBQ/teamspeak-js/commit/b2de6620856c5810dce0f787e062b387ffd25f36) - Files: `uploadFile` and `downloadFile` (from `@honeybbq/teamspeak/client`) negotiate a transfer and move its bytes in one call, over a voice `Client`, or over a `QueryClient` on raw TCP or SSH when given the file transfer host as `host`; WebQuery refuses every file command (error 5120) on both servers. `uploadFile` takes bytes, or a `Readable` with its `size`; `downloadFile` returns the bytes, or writes into a `dest` stream, and refuses a file over `maxSize` (256 MiB) when it would hold it in memory. `listFilesRecursive` (from the package) lists a directory and everything under it, each entry with its full path, down to `maxDepth` levels (16 by default).

  `Client.uploadFileData` and `Client.downloadFileData` now accept `idleTimeoutMs`, which they always passed on.

  Docs: `createDirectory` does not make missing parents, as its doc comment said; on TeamSpeak 3 and 6 a path whose parent is missing is refused with error 2052.

### Patch Changes

- [#105](https://github.com/HoneyBBQ/teamspeak-js/pull/105) [`c8afbbe`](https://github.com/HoneyBBQ/teamspeak-js/commit/c8afbbead65b700d43fb8dfb5a477a8979de122c) - A ServerQuery client no longer loses the rows of an answer that TeamSpeak 6 writes after the `error` line over SSH, and no longer hands them to the next command. Measured on TeamSpeak 6 beta13.1, about one `channelcreate` in ten and one `servergroupadd` in eight were answered that way (a quarter of the creates while other sessions were creating channels, and with them one command in five was given a stray row as its own answer), as were `banclient` answers when events were registered and, rarely, a `clientlist`. The row follows the `error` line by well under a millisecond, in the same stream: nothing arrives on the SSH channel's stderr. TeamSpeak 3 never did it, over raw TCP or SSH, and WebQuery answers whole.

  Now, for the commands that return what they made (channels, groups, bans, privilege keys, API keys, virtual servers) and for reads (`…list`, `…info`, `get…`, `whoami`, `version`), a successful answer that has no rows yet is held for up to 250 ms, and one with rows is held until they stop (25 ms), and nothing is sent in the meantime, so the rows are attributed to their own command. A create whose row still has not come resolves as before, and that row, should it arrive later, is dropped instead of becoming the next command's answer. Ids of a successful `banclient` that the server did not send at all are still not recovered: a ban has no field that ties it to the call, so `banClient` documents that the list may be empty.

## 1.0.0-beta.13

### Minor Changes

- [#96](https://github.com/HoneyBBQ/teamspeak-js/pull/96) [`a6d8daf`](https://github.com/HoneyBBQ/teamspeak-js/commit/a6d8daf7e8aa583a844874a3e972d4c9ddec0132) - Events: `ClientMovedEvent.fromChannelID` (`cfid`; absent on TS3, which sends none on a move), and `ClientLeaveEvent.fromChannelID` and `targetChannelID`. `ClientEnterEvent` is now an interface extending `ClientEntry` with `fromChannelID` and `reason`, which the roster and `view.clients` records do not carry. The voice client delivers `clientChatClosed`. `NotificationName.BanUpdate` names `notifybanupdate`, which stays untyped: its forms differ (an addition carries the row, a deletion the id, a delete-all neither). `"tokenused"` is a `QueryEventCategory`, never registered by default.

  Records: `Channel.emptyForMs` (undefined for a channel with a client in it, which both servers report as -1), `storageQuota` and `filePath`; `ClientEntry.talkRequestedAt`; `ClientDatabaseEntry.loginName`, `avatarHash` and the four traffic totals of `getClientDatabaseInfo`; `ClientDatabaseName.uid`; `getClientUIDInfoByID` for the nickname and myTeamSpeak id beside the uid; `WhoAmI.serverUUID` and `originServerID`; `VirtualServer.uuid`, `guestCanCreateChannels`, `guestCanCreateHomebase` and `weblistEnabled`; `TempPassword.targetChannelPassword`, a secret.

- [#97](https://github.com/HoneyBBQ/teamspeak-js/pull/97) [`559e536`](https://github.com/HoneyBBQ/teamspeak-js/commit/559e536c124dcdd7e6d3d9bde552673f3e2a8ce7) - Query: `QueryClient.stats` reports the current connection: its kind (`tcp`, `ssh` or `web`), where it points (never a password or an api key), when it opened and the bytes written and read, for a metrics exporter; a client with no connection, or a `custom` transport that keeps no counts, reports zeros. A `custom` transport may offer `stats()` to take part.

  Version helpers: `serverFamilyForVersion` (from the package) names the generation a version string belongs to, as `QueryClient.serverFamily` and the voice client's capabilities do; `uidAlgorithmForVersion` and `MAX_SECURITY_LEVEL` (from `/client`) are now exported.

### Patch Changes

- [#95](https://github.com/HoneyBBQ/teamspeak-js/pull/95) [`5340eaa`](https://github.com/HoneyBBQ/teamspeak-js/commit/5340eaa13628e396ddf5c9a865ebf9da88e01117) - `findBans` on a voice client returned no rows on TeamSpeak 6, because its answer, `notifybanfind`, was not in the response table; it now returns the matching bans, and `NotificationName.BanFind` names the notification. `listClients` takes `icon: true` to send `-icon`, which fills `ClientEntry.iconID`. `createChannel` and `editChannel` take `bannerURL` and `bannerMode`. `ServerCapabilities.hostMessageMode` is typed as `HostMessageMode`; a value the table does not name still passes through as sent.

- [#99](https://github.com/HoneyBBQ/teamspeak-js/pull/99) [`f5d9ec7`](https://github.com/HoneyBBQ/teamspeak-js/commit/f5d9ec7ce749be87619d5b9ee3b530ce33d387b7) - `banClient`'s documentation says what the servers do: two bans, one for the uid and one for the address, and an answer that TeamSpeak 6 has left without any `banid` though both bans were made, so the bans are found by listing them before and after.

- [#93](https://github.com/HoneyBBQ/teamspeak-js/pull/93) [`31d412b`](https://github.com/HoneyBBQ/teamspeak-js/commit/31d412b14fb81ef90f68b90848d13fa0f487c387) - Client: a `connect()` that the caller's signal ends says what it was waiting for. `connect()` still rejects with the signal's own reason, as before, so nothing that matches it changes. The `attemptFailed` trace hook gets `waitingFor`, such as `the server's answer to clientek`, finer than `phase`, and the client logs the same when an attempt ends. A TeamSpeak 6 server sometimes never answers `clientek`, and the attempt then ended on the caller's deadline with no sign of where it stopped.

- [#92](https://github.com/HoneyBBQ/teamspeak-js/pull/92) [`db7c5d2`](https://github.com/HoneyBBQ/teamspeak-js/commit/db7c5d2acbe1cc86f3412e13d69578b38d881e8a) - Query: the `web` transport reaches WebQuery over HTTPS. The built-in `fetch` uses `node:https` for an `https:` URL, such as TeamSpeak 3's port 10443, and verifies the certificate against Node's trust store; it never skips that check. A private CA is trusted with `NODE_EXTRA_CA_CERTS` or a `fetch` you pass. A URL with any scheme but `http:` or `https:` now throws a `TypeError` when the client is built, unless you pass your own `fetch`.

## 1.0.0-beta.12

### Major Changes

- [#90](https://github.com/HoneyBBQ/teamspeak-js/pull/90) [`53fe50d`](https://github.com/HoneyBBQ/teamspeak-js/commit/53fe50d41b1a80df1210006c22e79e5f9fc0f26f) - The raw TCP login moves from the `QueryClient` options into the `tcp` transport. `QueryClientOptions.login` is gone; give the account as `transport.login`, next to the `host`, the way SSH and WebQuery already carry their credentials. How to connect and authenticate is the transport's, and what to do on the session (`server`, `nickname`, `events`, `reconnect`) stays on the client. The type now says what was only a runtime rule before: `login` exists on the `tcp` arm and on no other, so a login beside an SSH or WebQuery transport no longer type-checks.

  ```ts
  // before
  new QueryClient({
    transport: { kind: "tcp", host: "ts.example.com" },
    login: { name: "serveradmin", password },
    server: { id: 1 },
  });

  // after
  new QueryClient({
    transport: { kind: "tcp", host: "ts.example.com", login: { name: "serveradmin", password } },
    server: { id: 1 },
  });
  ```

  A caller in plain JavaScript who still passes the top-level `login` gets a `TypeError` that names `transport.login`, rather than a client that connects without logging in. `transport.login` on any kind other than `tcp` throws too. The login is still sent after every reconnect, and `client.login(name, password)` is unchanged.

  A `custom` transport no longer takes a `login`: its `open` builds the connection, so it logs in there, or the application calls `client.login()` once connected. To keep the client's own login and reconnects, open the connection with `kind: "tcp"` and its `connect` function instead.

### Minor Changes

- [#87](https://github.com/HoneyBBQ/teamspeak-js/pull/87) [`9124332`](https://github.com/HoneyBBQ/teamspeak-js/commit/912433236b87cf80827c26fd3bb4c57ac3d342b7) - The view of a voice client now holds the groups and the server's properties, and tells you when it changed. `view.serverGroups` and `view.channelGroups` are the server's group lists in its order, replaced whole when the server sends a new one (after a group is added, renamed, copied or deleted); `view.groupsLoaded` is `true` once both have arrived, which is just after `viewReady`, so a UI that needs them waits for it. A group's permissions are not announced and are not in the view. `view.server` holds the `virtualserver_*` properties by the names `getServerInfo` uses, from the server's welcome, patched by `serverEdited` and merged with every `getServerVariables` answer. The server does not spell out every edit: a new welcome message, host message or client limit arrives as an empty `serverEdited`, so call the new `getServerVariables(client)` after one to bring those up to date. It returns the whole answer, counters included; `view.server` never holds the counters and statistics that change by themselves, such as clients online and uptime.

  The new `viewChanged` event, `{ revision }`, is delivered once after the typed events of whatever arrived together, so a UI that redraws from the view needs one listener. It is not sent while the view is loading, nor when the revision is the one `viewReady` or the last `viewChanged` gave, and it is sent once when the view goes stale. It never replaces the typed events.

  `channelDeleted` and `clientLeave` now carry `previous`, the channel or client as the view held it just before, so a listener can say what was removed. It is absent when the client did not know it, and always absent on a ServerQuery client. All of this is experimental.

### Patch Changes

- [#89](https://github.com/HoneyBBQ/teamspeak-js/pull/89) [`a9cedaa`](https://github.com/HoneyBBQ/teamspeak-js/commit/a9cedaa417cebf8aec2ec700fb1ab12c434829ca) - A client can now connect to a TeamSpeak server that is under a burst of connections. Such a server raises its protection level and asks for a bigger Init1 puzzle: 100000 squarings at level 1 and 1000000 at level 2, where it asks for 10000 when calm. The client refused anything above 100000, so it could not connect at all. The cap is now 4000000, four times the highest level either server asks for. The puzzle is solved in slices that give the event loop back, so timers and other connections keep running meanwhile, and a cancelled `connect()` stops solving and rejects with its own reason. A level above the cap rejects with the new `PuzzleTooHardError`, a `HandshakeError` that carries the `level` asked for and the `maxLevel` allowed.

- [#88](https://github.com/HoneyBBQ/teamspeak-js/pull/88) [`9e4776d`](https://github.com/HoneyBBQ/teamspeak-js/commit/9e4776dffdacd7ba2c8640168932c092db2393a8) - `ErrorCode` now names the codes WebQuery refuses access with: `APIKeyOutOfScope` (5120), `APIKeyInvalid` (5122) and `APIKeyMissing` (5124). A query client connecting with `guest: true` to a server that offers no guest access, such as any TeamSpeak 3 server, now rejects with a `GuestAccessError` that says so and keeps the server's refusal as its `cause` (and its code, over WebQuery). The `serverID` option of the WebQuery transport is documented correctly: TeamSpeak 3 runs every command on a virtual server even when none is named.

- [#88](https://github.com/HoneyBBQ/teamspeak-js/pull/88) [`9e4776d`](https://github.com/HoneyBBQ/teamspeak-js/commit/9e4776dffdacd7ba2c8640168932c092db2393a8) - A query client now says `quit` before it closes a raw TCP or SSH connection, and waits a moment for the server to end the session. A TeamSpeak 3 server could keep an SSH session whose client had simply gone away, and enough of them locked the address out of new connections.

## 1.0.0-beta.11

### Minor Changes

- [#83](https://github.com/HoneyBBQ/teamspeak-js/pull/83) [`d365edc`](https://github.com/HoneyBBQ/teamspeak-js/commit/d365edc9a5bd1cb44f5be04948f42dd53eef21d7) - The voice client reads the server for you. `client.view` holds the channel tree in the server's order (`channels`, `channel`, `children`, `path`), the clients the client has been told about (`clients`, `client`, `clientsIn`) and its own record (`self`), and follows the server's notifications on its own. `view.status` is `"empty"`, `"loading"`, `"live"` or `"stale"`, `view.revision` counts every change, and `await view.whenReady()` or the new `viewReady` event tells you the welcome is done; it rejects if the connection ends first. After a disconnect the last view stays readable as `"stale"`, and the next `connect()` clears it. The view is experimental. Its `totalClients` and `totalFamilyClients` are `undefined`, because the server counts a channel's clients once, in the welcome, and never again: count `clientsIn(id)` instead.

  The server changes the order of a channel's neighbours without saying so, so a record's `order` can go stale. `ChannelTree` (exported from the package root) applies the channel events with the server's rules and derives `order` from the position, and the view uses it. You can use it too, on a ServerQuery connection: `ChannelTree.from(await listChannels(q))`, then `tree = tree.apply(event)` for `channelCreated`, `channelEdited`, `channelMoved` and `channelDeleted`.

  Fixed: after `channelUnsubscribed` the client kept the clients of that channel, and `invokerGroups` kept reading them. The server never says they left, so the client now forgets them (this client's own record stays); a client that comes into view again arrives as a new `clientEnter`. Code that follows the events alone has to do the same.

### Patch Changes

- [#84](https://github.com/HoneyBBQ/teamspeak-js/pull/84) [`6d51718`](https://github.com/HoneyBBQ/teamspeak-js/commit/6d51718f637d9a8b5e14f22b3fe12369d685fb35) - `getClientConnectionInfo` no longer fails with `NoDataError` when the server sends the end of the answer before the figures. TeamSpeak 6 does this now and then when several commands are in flight; the figures follow a moment later. The voice client now takes the `notifyconnectioninfo` row that names the client asked about, whichever side of the command's `error` it falls on, and waits for it until the command's timeout or signal gives up.

- [#82](https://github.com/HoneyBBQ/teamspeak-js/pull/82) [`bd80a32`](https://github.com/HoneyBBQ/teamspeak-js/commit/bd80a322a4136f75469500fae53b62a1b7b8bf1a) - Over SSH, a TeamSpeak 6 server can hold the end of a reply until the client writes again; the SSH transport now writes an empty line when a command has waited 2 seconds, and once a second after, which releases it.

## 1.0.0-beta.10

### Minor Changes

- [#78](https://github.com/HoneyBBQ/teamspeak-js/pull/78) [`4f13ea5`](https://github.com/HoneyBBQ/teamspeak-js/commit/4f13ea5d81d8244a00d7437f5df3a5c70010b1bb) - Avatar and icon helpers. `uploadAvatar` hashes an image, uploads it and sets the client's avatar flag; `downloadAvatar` reads any client's avatar from `avatarFileName(uid)`, the name the server stores it under (`avatar_` and the unique id in the letters a to p, which is not the MD5 name); `removeAvatar` deletes your own. `uploadIcon` sends an icon under its CRC-32 id (`iconIDOf`), `downloadIcon` and `removeIcon` read and delete one, and `setChannelIcon`, `setServerGroupIcon`, `setChannelGroupIcon`, `setClientIcon` and `setServerIcon` point a record at it. `Client` has a `host` getter.

- [#72](https://github.com/HoneyBBQ/teamspeak-js/pull/72) [`08ea67c`](https://github.com/HoneyBBQ/teamspeak-js/commit/08ea67c9cbea4b510419be11709063425791a0a5) - `ClientOptions` takes a `privilegeKey`, which the server redeems while the client joins, and `metaData`, which other clients see in their record of it; `updateClient` takes `metaData` too. `disconnect()` takes a `reasonMessage` that bystanders receive in `clientLeave`. The goodbye now carries `reasonid=8`, without which both servers drop the message.

- [#72](https://github.com/HoneyBBQ/teamspeak-js/pull/72) [`08ea67c`](https://github.com/HoneyBBQ/teamspeak-js/commit/08ea67c9cbea4b510419be11709063425791a0a5) - The client answers `notifyconnectioninforequest` with `setconnectioninfo`, from what it has measured: the keepalive round trip, packets and bytes by class and direction, and bandwidth. `getClientConnectionInfo` reads another client's figures, and `verifyServerPassword` and `verifyChannelPassword` check a password without joining or moving.

- [#72](https://github.com/HoneyBBQ/teamspeak-js/pull/72) [`08ea67c`](https://github.com/HoneyBBQ/teamspeak-js/commit/08ea67c9cbea4b510419be11709063425791a0a5) - `createChannel` looks the channel up by name and parent when the server's answer carries no `cid`, instead of failing a creation that succeeded.

- [#72](https://github.com/HoneyBBQ/teamspeak-js/pull/72) [`08ea67c`](https://github.com/HoneyBBQ/teamspeak-js/commit/08ea67c9cbea4b510419be11709063425791a0a5) - `sendWhisper` can name channels as well as clients (`WhisperTargets.channels`), and the new `sendGroupWhisper` whispers to a server group, a channel group, the channel commanders or everyone, within the channels a scope picks. `GroupWhisperType` and `GroupWhisperScope` name the packet's two enums, and `GroupWhisperTarget` ties the group id to the type that takes it.

- [#73](https://github.com/HoneyBBQ/teamspeak-js/pull/73) [`a445291`](https://github.com/HoneyBBQ/teamspeak-js/commit/a445291b47d04f82c809b4f658340d91da06a7da) - The client reports changes to channels and to the server as typed events, and the voice client reports its subscriptions, plugin commands and typing.

  New events on every client: `channelCreated`, `channelEdited`, `channelMoved`, `channelDeleted`, `channelDescriptionChanged`, `channelPasswordChanged` and `serverEdited`. A ServerQuery client receives them through its `channel` and `server` categories, which are registered by default; `QueryEventsOption` lists what each category delivers. New events on the voice client: `channelSubscribed`, `channelUnsubscribed`, `pluginCommand` and `clientChatComposing`. Neither TeamSpeak 3 over raw ServerQuery nor TeamSpeak 6 over SSH sends a ServerQuery connection these four, nor `clientUpdated`, the group events or `clientChannelGroupChanged`, so the ServerQuery client does not offer them.

  `channelCreated` and `channelEdited` carry `changes`, holding only the properties the server sent, under the names `createChannel` and `editChannel` take; for a new channel, a property that is absent has the server's default. `applyChannelChanges` merges one into a record. `serverEdited` carries the changed server properties by their `virtualserver_` names, and none for a welcome message change.

  The answer to `getChannelDescription` arrives as an edit with reason `Reason.ChannelUpdate` and no invoker, which is not a change: it produces no `channelEdited`, and still reaches `notification` and the command.

  `sendPluginCommand` sends a plugin command to the channel, the server or one client, `sendChatComposing` tells a client that we are typing a private message to it, and `closePrivateChat` tells it that we closed the chat. A ServerQuery connection cannot send them. Each function's documentation says who receives what, as measured on both servers.

  A ServerQuery client lists the clients with `-away` and `-voice` when it connects, so the records it learns carry away and mute state.

  Every notification is still delivered as `notification`, after its typed event. Code that switches over event names, in event middleware or elsewhere, needs a default case, as it always did.

- [#80](https://github.com/HoneyBBQ/teamspeak-js/pull/80) [`355fe25`](https://github.com/HoneyBBQ/teamspeak-js/commit/355fe253e9261d4302a5ba491cce8b4ed078f79d) - `muteClients` and `unmuteClients` stop and resume hearing other clients on a voice connection: the server no longer forwards the muted clients' voice to the caller, while everyone else still hears them. Both take one or more client ids.

- [#77](https://github.com/HoneyBBQ/teamspeak-js/pull/77) [`18c9f4b`](https://github.com/HoneyBBQ/teamspeak-js/commit/18c9f4be37d407a0cf1ab1c55745c0363bd8c77c) - `PermissionName` names the `i_needed_modify_power_*` permissions, one per permission and called `NeededModifyPower` followed by that permission's name, such as `PermissionName.NeededModifyPowerVirtualServerCanonicalNameManage`. The seven TeamSpeak 6 permissions that had no name for their twin are covered with the rest.

- [#77](https://github.com/HoneyBBQ/teamspeak-js/pull/77) [`18c9f4b`](https://github.com/HoneyBBQ/teamspeak-js/commit/18c9f4be37d407a0cf1ab1c55745c0363bd8c77c) - The query client can connect as a TeamSpeak 6 guest, which beta13 and later accept without any setup: pass `guest: true` in the `ssh` transport (logs in as the user `guest` with no password) or the `web` transport (sends no api key). It is an explicit choice: a missing `username`, `password` or `apiKey` still throws, and the error now names `guest: true` as the way to connect without one. A guest runs with the Guest Server Query group's permissions, so `version` and `whoami` answer and admin commands are refused; pass `events: false` for an SSH guest that may not register for notifications.

### Patch Changes

- [#76](https://github.com/HoneyBBQ/teamspeak-js/pull/76) [`e00eec7`](https://github.com/HoneyBBQ/teamspeak-js/commit/e00eec79547d2dd5d76339aea7b2e7168441698c) - `createServerGroup`, `createChannelGroup`, and `copyServerGroup` / `copyChannelGroup` onto a new group look the group up by name and type when the server's answer carries no id, instead of failing a creation that succeeded. A `NoDataError` from `addPrivilegeKey` or `addAPIKey` now says plainly that the command took effect, so it is not retried blindly.

- [#75](https://github.com/HoneyBBQ/teamspeak-js/pull/75) [`3e50041`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e50041ddb7b567f593d9cdedc9dd5d54cd40307) - `QueryClient` reads its own client id and the client list again after `use()`, and forgets both after `logout()` and after a `use()` the server refuses, which leaves the connection on no server. Before, a kick on the server it had just selected was missed, and the roster still named the old server's clients. `registerNotifications()` lists the clients again once the server accepts it. A reconnect starts over from the constructor options and does not repeat a `use()` made by hand.

  `clientgetvariables`, `getconnectioninfo` and `channelgetdescription` over the voice protocol take only the row that echoes the `clid` or `cid` that was asked about. Another client's update, or the client's own mute broadcast, no longer comes back as the answer.

## 1.0.0-beta.9

### Major Changes

- [#66](https://github.com/HoneyBBQ/teamspeak-js/pull/66) [`dab88f6`](https://github.com/HoneyBBQ/teamspeak-js/commit/dab88f60928f5e94e9d8b82e6a1bce0498ec0d59) - `ClientDatabaseEditOptions.nickname` and `ServerGroupClientListOptions.uids` are gone: neither ever worked. `editClientDatabase(c, cldbid, { nickname })` sent `client_nickname`, which `clientdbedit` does not take, and both TeamSpeak 3 and TeamSpeak 6 answered error 1542 (missing required parameter); the command only edits `description`, and there is no way to change a stored nickname through it. `listServerGroupClients(c, sgid, { uids })` sent `-uid`, which `servergroupclientlist` ignores, so the rows stayed `cldbid` only. Pass `names: true` instead: the server then returns each member's nickname and unique identifier together, so `ServerGroupMember.uid` is filled by `names`.

### Minor Changes

- [#68](https://github.com/HoneyBBQ/teamspeak-js/pull/68) [`3e1bbd5`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e1bbd572f9305634b8da0b9916b0cff333c6129) - `findBans` looks bans up by address, nickname, uid or myTeamSpeak id (`banfind`, TS6 only: TS3 has no such command, and TS6's WebQuery answers it as unknown). A ban can be made with a `mytsid` and a `lastNickname`, and `BanEntry` has the `mytsid` TS6 reports. `listBans` takes `start` and `limit` to page the list. A privilege key can be made with a `customSet` of custom client properties, which `PrivilegeKey` reports back; the set is escaped twice on the wire, because the server's own example, escaped once, cuts a value at its first space.

- [#68](https://github.com/HoneyBBQ/teamspeak-js/pull/68) [`3e1bbd5`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e1bbd572f9305634b8da0b9916b0cff333c6129) - The commands that could only be sent as raw lines now have typed functions. API keys: `addAPIKey`, `listAPIKeys`, `deleteAPIKey`. ServerQuery logins: `addQueryLogin`, `listQueryLogins`, `deleteQueryLogin`, and `setQueryLogin` for the voice protocol. Custom client properties: `setCustomProperty`, `deleteCustomProperty`, `listCustomProperties`, `findCustomProperty`. Also `sendOfflineMessage`, `getOwnPermission` (`permget`), and `addServerGroupPermissionByType` and `deleteServerGroupPermissionByType` for every group of a type on every virtual server. The key an API key creation returns, the password of a login and the administrator key of a new server are ordinary fields of the result, secrets the server shows only once: store them, and do not log them.

  For an instance administrator over ServerQuery: `listServers`, `createServer`, `startServer`, `stopServer`, `deleteServer`, `stopInstance`, `sendGlobalMessage`, and `createServerSnapshot` and `deployServerSnapshot` with a password, `keepFiles` and the channel mapping. A voice client's Server Admin gets error 2568 for all of them. An unlicensed TS3 or TS6 runs one virtual server, and refuses another with 2816. `APIKeyID` and `asAPIKeyID`, `APIKeyScope` and `GroupAutoUpdateType` come with them.

- [#68](https://github.com/HoneyBBQ/teamspeak-js/pull/68) [`3e1bbd5`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e1bbd572f9305634b8da0b9916b0cff333c6129) - `findClients` takes `channelID` and `channelUID` to report where each match is, as `ClientMatch.channelID` and `channelUID`. They report and do not filter, and TS6 only: TS3 accepts the flags and sends neither. `FileUploadInfo` and `FileDownloadInfo` carry the `ip` the server sends when the file transfer is not reachable at the command connection's address, undefined otherwise. `listChannels` also asks for `-secondsempty` and `-banners`; `Channel` has no field for them yet.

- [#67](https://github.com/HoneyBBQ/teamspeak-js/pull/67) [`4429dc0`](https://github.com/HoneyBBQ/teamspeak-js/commit/4429dc0a008c43beed5aa0a90b9b9ea29bff628e) - The voice client reports changes to other clients as typed events, and keeps its record of them current.

  New events: `clientUpdated`, `clientServerGroupAdded`, `clientServerGroupRemoved` and `clientChannelGroupChanged`. A TeamSpeak 3 ServerQuery connection does not receive these from the server, so the ServerQuery client does not offer them.

  `clientUpdated` carries `changes`, holding only the properties the server sent, under the names `updateClient` takes; a property that is absent did not change. `applyClientChanges` and `applyChannelChanges` merge a change into a record and return a new one.

  `TextMessageEvent.invokerGroups` no longer goes stale: the voice client updates what it knows of a client when its groups change, and refreshes its channel group when that changes in the channel the client is in. A ServerQuery client still reads groups from the listing it took when it connected.

  `ClientEntry` gains optional `databaseID`, `awayMessage`, `isInputMuted`, `isOutputMuted`, `talkPower`, `description`, `avatar`, `country`, `version`, `platform` and others, and `Channel` gains `isMaxClientsUnlimited`, `deleteDelayMs`, `namePhonetic` and others. They are `undefined` where the answer did not carry them, such as a field no `listClients` flag brings; `getChannelInfo` fills the channel ones.

  Every notification is still delivered as `notification`, after its typed event. Code that switches over event names, in event middleware or elsewhere, needs a default case, as it always did.

- [#68](https://github.com/HoneyBBQ/teamspeak-js/pull/68) [`3e1bbd5`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e1bbd572f9305634b8da0b9916b0cff333c6129) - `QueryClient` has `logout()` and `unregisterNotifications()`, the counterparts of `login()` and `registerNotifications()`. `logout` also deselects the virtual server; WebQuery refuses both, as its api key is the login and nothing is registered there.

- [#68](https://github.com/HoneyBBQ/teamspeak-js/pull/68) [`3e1bbd5`](https://github.com/HoneyBBQ/teamspeak-js/commit/3e1bbd572f9305634b8da0b9916b0cff333c6129) - A raw `exec` over the voice protocol now returns the rows of `tokenadd`, `tokenlist`, `apikeyadd`, `apikeylist`, `permget`, `getconnectioninfo`, `clientgetvariables`, `servergetvariables` and `clientsetserverquerylogin`. The server answers each with a notification (`notifytokenadd`, `notifyapikeyadd`, `notifypermget`, `notifyconnectioninfo`, `notifyclientupdated`, `notifyserverupdated` and the like) and the client used to report an empty success. `CommandName` and `NotificationName` name them.

## 1.0.0-beta.8

### Patch Changes

- [#63](https://github.com/HoneyBBQ/teamspeak-js/pull/63) [`26cd3ef`](https://github.com/HoneyBBQ/teamspeak-js/commit/26cd3ef26c196341ed936da1e8b818e229629223) - A ServerQuery client now recognises when it is kicked from a channel, and emits `kicked` for it, whether or not the `nickname` option is set and while an older session with the same nickname is still on the server.

  It used to find its own client id by matching `nickname` against the client list. With no `nickname` it never learned the id, so `kicked` never fired. When a session that had just disconnected was still listed under the same nickname, it took that one for itself, and the kick went unreported. It now asks the server with `whoami` while connecting, which adds one command to the connect.

## 1.0.0-beta.7

1.0.0-beta.5 and 1.0.0-beta.6 were never published; their changes shipped in 1.0.0-beta.7.

### Minor Changes

- [#56](https://github.com/HoneyBBQ/teamspeak-js/pull/56) [`db9f2c5`](https://github.com/HoneyBBQ/teamspeak-js/commit/db9f2c5a9bccf59b74e6cc277f2071d9fb238d8a) - The ServerQuery client is published, as `@honeybbq/teamspeak/query`.

  It runs the same typed commands the core already exports — `listChannels`,
  `createChannel`, `moveClient` and the rest — over a ServerQuery connection
  instead of a voice one, plus the commands only an administrator has. The
  transport is one of three: raw TCP (`{ kind: "tcp", host }`, the default port
  10011, TeamSpeak 3 only), SSH (`{ kind: "ssh", host, username, password,
  knownHosts }`), or TeamSpeak 6's WebQuery (`{ kind: "web", url, apiKey }`).
  `custom` takes an opener of your own.

  ```typescript
  import { QueryClient } from "@honeybbq/teamspeak/query";
  import { listChannels } from "@honeybbq/teamspeak";

  const client = new QueryClient({
    transport: { kind: "tcp", host: "ts.example.com" },
    login: { name: "serveradmin", password: process.env.QUERY_PASSWORD! },
    server: { id: 1 },
  });
  await client.connect();
  console.log(await listChannels(client));
  await client.disconnect();
  ```

  The server's notifications arrive as the core's typed events — `textMessage`,
  `clientEnter`, `clientLeave`, `clientMoved`, `kicked` and `notification` —
  over raw TCP and SSH. WebQuery has no session for the server to push one down
  and refuses to register for them, so the client does not try, and a listener
  for a server event on that transport throws a `TypeError` rather than staying
  silent. `connected` and `disconnected` work on every transport.

  A channel password is taken as it is written: ServerQuery hashes it
  server-side, where the voice protocol wants `base64(sha1(password))`. The
  client does that conversion for you, so a password moves between the two
  unchanged.

  SSH checks the server's host key before it sends the login, and has no default
  for how, because the login is normally `serveradmin`'s and a client that accepts
  any key hands it to whatever answers the port. Give exactly one of `knownHosts`
  (the path of an OpenSSH `known_hosts` file, with plain, `[host]:port` and hashed
  entries and `@revoked` honoured), `hostKey` (your own check, which throws to
  refuse a key) or `insecureIgnoreHostKey: true`; with none of them the client
  refuses to be built, naming all three. A key that is refused fails the
  connection with an `SshHostKeyError` before anything is sent.

  `ssh2` is an optional peer dependency. Raw TCP and WebQuery need nothing but
  Node, so it is only installed if you use the SSH transport; without it that
  transport throws a `MissingDependencyError` naming the package, and the other
  two keep working.

  Reconnecting is opt-in, as for the voice client, and shares the same
  `ReconnectOptions`. Its default retries everything except what cannot change:
  a `login` or `use` the server refused, an SSH account it will not
  authenticate, and an SSH host key that was refused.

  This entry is marked `@experimental`. It is new, and its API may change in a
  minor release: the options, the transport union and the event map are all
  still settling. Pin a version and read the changelog if you depend on it.

## 1.0.0-beta.6

### Major Changes

- [#52](https://github.com/HoneyBBQ/teamspeak-js/pull/52) [`d1f1208`](https://github.com/HoneyBBQ/teamspeak-js/commit/d1f1208ce162f588c27ce614264e79ccd7153cae) - The last API changes before 1.0, for anyone on a beta:

  - `CommandOptions.timeout` is `timeoutMs`, like every other duration. Write `{ timeoutMs: 5_000 }`; `timeout` is no longer read.
  - `getClientInfo` is `getClientProperties`. It still answers the raw property map.
  - `addServerGroupPermission(client, sgid, { permission, value, negated, skip })` is `addServerGroupPermission(client, sgid, permission, value, { negated, skip })`, as its siblings. `ServerGroupPermission` is gone; the options are `ServerGroupPermissionOptions`.
  - `getClientIDs` answers `ClientMatch[]` (`id`, `nickname`) instead of `ClientID[]`: read `match.id`. `getClientNameByDBID` answers a `ClientDatabaseName` (`databaseID`, `name`) instead of a string: read `.name`.
  - `updateMessageFlag(client, id, read)` is `updateMessageFlag(client, id, { read })`, a `MessageFlags`.
  - `connected` delivers a `ConnectedEvent` (`reconnected`), and `disconnected` a `DisconnectedEvent` (`error`, `willReconnect`) instead of the bare error: write `client.on("disconnected", ({ error }) => …)`.
  - `TextMessageEvent.invokerGroups` is `undefined` for a sender the client has not seen, where it was `[]`. Check it before use. `ClientMovedEvent` has a `reasonMessage`.
  - `resolveNicknames: true` is `nicknameLookup: true`.
  - `sendWhisper(data, [clid], codec)` is `sendWhisper(data, { clients: [clid] }, codec)`. The client's whisper has no channel targets, so `WhisperTargets` has only `clients`. `sendVoice` takes a reserved `VoiceOptions` after the codec.
  - `packetChannel` is `incomingChannel`, `honeybbq:teamspeak:packet` is `honeybbq:teamspeak:incoming`, and `PacketTrace` is `IncomingTrace`: it reports every command the server sends, not packets.

- [#54](https://github.com/HoneyBBQ/teamspeak-js/pull/54) [`92c5496`](https://github.com/HoneyBBQ/teamspeak-js/commit/92c5496f313b73b0dd747636e6035570ec2a7773) - The types every client shares moved from `@honeybbq/teamspeak/client` to `@honeybbq/teamspeak`, so a second client can use them without a second home for each. For anyone on a beta, import each of these from `@honeybbq/teamspeak`:

  - `ClientStatus`, `Unsubscribe`, `Listener`, `ConnectedEvent`, `DisconnectedEvent` and `ServerFamily`.
  - `ReconnectOptions`, `BackoffPolicy`, `defaultBackoffPolicy` and `backoffDelay`. `defaultShouldRetry` stays in `@honeybbq/teamspeak/client`.
  - `AlreadyConnectedError`.

  `Listener` now takes the event map as well: `Listener<EventMap, "textMessage">`. `client.on` infers payloads as before. `EventMap` stays in the client and extends the new `ServerEventMap` and `SessionEventMap`, which the core exports; it has the same keys and payloads.

### Minor Changes

- [#49](https://github.com/HoneyBBQ/teamspeak-js/pull/49) [`75d6034`](https://github.com/HoneyBBQ/teamspeak-js/commit/75d6034473aa27639f215a2372890c66f1fd3600) - The `version` option of `Client` chooses the platform, version and signature that `clientinit` sends, and `@honeybbq/teamspeak/versions` exports the versions a server accepts, one constant each: `new Client(identity, addr, nick, { version: Windows_3_6_2_1695203293 })`. Without the option the client sends what it always did. `ClientVersion` is exported from `@honeybbq/teamspeak`.

- [#50](https://github.com/HoneyBBQ/teamspeak-js/pull/50) [`3cea2a1`](https://github.com/HoneyBBQ/teamspeak-js/commit/3cea2a163bc2c3202b829bb6f51a84cb846a167c) - `HostMessageMode` from `@honeybbq/teamspeak` names the host message modes: `None`, `Log`, `Modal` and `ModalQuit`. Compare `capabilities.hostMessageMode` with them: `capabilities.hostMessageMode === HostMessageMode.ModalQuit`. The field stays a `number`, since a server may send a value the table does not name.

## 1.0.0-beta.5

### Major Changes

- [#46](https://github.com/HoneyBBQ/teamspeak-js/pull/46) [`65ae22b`](https://github.com/HoneyBBQ/teamspeak-js/commit/65ae22b2c97d6e40f5346c3bab618224b33574e8) - `getChannelInfo` used to report `totalClients`, `totalFamilyClients` and `neededSubscribePower` as 0, whatever the channel held. The server does not send them for a single channel, so they are now `undefined` there. Use `listChannels` for live counts.

  `Binding.port` is now `number | undefined`: it is undefined when the server reports no port. `Binding.subsystem` is now filled in, with the subsystem you asked for or `voice`.

- [#42](https://github.com/HoneyBBQ/teamspeak-js/pull/42) [`4283667`](https://github.com/HoneyBBQ/teamspeak-js/commit/4283667904bc9be87489fd6fd5e1d45e6f0f757f) - `@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` are now one package, `@honeybbq/teamspeak`, with two entry points. The ServerQuery client will join it as a third in a 1.x release.

  Each entry exports only its own symbols, so the client entry no longer re-exports the core:

  | You imported                                                                                                       | Import it from now on        |
  | ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
  | `Client`, `Identity`, `ClientStatus`, the client's errors, `commandChannel`, ... from `@honeybbq/teamspeak-client` | `@honeybbq/teamspeak/client` |
  | `listChannels`, `ErrorCode`, `TeamspeakError`, ids, events, ... from `@honeybbq/teamspeak-client`                  | `@honeybbq/teamspeak`        |
  | anything from `@honeybbq/teamspeak-core`                                                                           | `@honeybbq/teamspeak`        |

  ```ts
  // before
  import { Client, listChannels, ErrorCode } from "@honeybbq/teamspeak-client";
  // after
  import { Client } from "@honeybbq/teamspeak/client";
  import { listChannels, ErrorCode } from "@honeybbq/teamspeak";
  ```

  Replace `@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` with `@honeybbq/teamspeak` in your `package.json`. Nothing else about the API changed.

  `@honeybbq/teamspeak-core` and `@honeybbq/teamspeak-client` are deprecated on npm and get no further releases; 1.0 is published only as `@honeybbq/teamspeak`. `@honeybbq/teamspeak-core/internal` is gone.

### Minor Changes

- [#44](https://github.com/HoneyBBQ/teamspeak-js/pull/44) [`9f72ca4`](https://github.com/HoneyBBQ/teamspeak-js/commit/9f72ca467ea562a1e2c883584cdfa16f37366350) - `EventName` from `@honeybbq/teamspeak/client` names the client's events as constants: `client.on(EventName.TextMessage, (message) => { ... })`. The string names keep working and mean the same, so existing code needs no change.

### Patch Changes

- [#42](https://github.com/HoneyBBQ/teamspeak-js/pull/42) [`0fec038`](https://github.com/HoneyBBQ/teamspeak-js/commit/0fec038efd7bb8df83a40d3b4e907297ce36fb11) - `ErrorCode.ProvisioningNoPermission` is 0x111a (4378), the code the server reports. It was 0x111 (273), so comparing a `ServerError`'s code with it never matched.

## 1.0.0-beta.4

### Patch Changes

- 0649001: File transfers, cancellation and a few error details now behave the way the platform's own APIs do:

  - A file transfer that moves no byte for `idleTimeoutMs` (30 seconds unless set; 0 turns it off) fails with a `FileTransferError`. Before, a server that went silent held it until the caller's signal ended it. Writing the transfer key now honours the signal and the dial timeout too.
  - A download that sends more than the size the server announced fails after that size, without writing the excess, and one that ends short of it fails. Both used to succeed.
  - `client.events()` rejects with the signal's reason when the signal aborts, as Node's `events.on` does, instead of ending quietly. Calling `next()` again before the previous call settles no longer loses a call. The iterator also stops listening when a disconnect ends it, not only when the loop calls `return()`.
  - SRV records are tried in the order RFC 2782 gives: by priority, then by weight. Before, the order was the one the DNS answer arrived in.
  - `Resolver.resolve("")` throws an `InvalidAddressError` rather than a plain `Error`.
  - An error's `name` is no longer an own enumerable property, so `JSON.stringify(err)` and `Object.keys(err)` treat it as they treat a built-in error's.
  - Timeouts and the flood throttle measure time with a monotonic clock, so a change of the system clock cannot stall or burst them.

## 1.0.0-beta.3

### Major Changes

- b13a0bc: Node 22.12 or newer is required; Node 20 reached its end of life in April 2026.

### Minor Changes

- b13a0bc: The event types are now part of core, so a future ServerQuery client shares them; the client package exports them as before.

### Patch Changes

- b13a0bc: `listChannels` now returns the fields its type declares. It used to send a bare `channellist`, so the topic was always empty and the permanent, default and password flags, the codec, the client limit and the icon were always zero or false. It now asks for all of them. Each channel also gains five fields: `isSemiPermanent`, `maxFamilyClients`, `totalClients`, `totalFamilyClients` and `neededSubscribePower`. The description and unique identifier are still not part of `channellist`; `getChannelInfo` has them.

## 1.0.0-beta.2

### Minor Changes

- def7d6d: `PermissionName` names every permission TeamSpeak 3.13 and 6 servers list, for `permissionByName`: `permissionByName(PermissionName.ClientTalkPower)`. It is a frozen table and a union type of its values, like `ErrorCode`; `permissionByName` still takes any string, so a permission the table lacks works as before. Seven exist only on TeamSpeak 6 and say so.
- 3d32e71: `CommandName`, `NotificationName` and `PropertyName` name what TeamSpeak 3.13 and 6 servers send on the wire, so a raw line or a property key no longer has to be spelled from memory: `client.exec(CommandName.ServerGroupList)`, `n.name === NotificationName.ChannelEdited`, `info[PropertyName.VirtualServerName]`. Each is a frozen table and a union type of its values, like `PermissionName`. `NotificationEvent.name` and `CommandRequest.command` accept these names with autocompletion and still take any string, since a server may send names the tables lack.

### Patch Changes

- 4326d90: A line of rows that each named a field of their own made the rows grow with the square of the line: TeamSpeak leaves out of a row the fields unchanged from the one before, so every row took on all the fields of all the rows before it, and one line of a few hundred kilobytes from a server, or from anyone who could forge its first packets, expanded to gigabytes. The rows of a line are now held to a size in proportion to the line itself; past it, rows carry only the fields they were sent with. The rows of a real server's line never come near it.

  After the 16-bit packet id wrapped, a command the server sent again because its acknowledgement was lost, with an id just behind the receive window, was taken for one far ahead of it and dropped unanswered, so the server went on sending it. It is now recognised as already delivered and acknowledged again.

  `parseUint64`, and with it the channel id of `notifyclientmoved`, accepted a sign, a hex prefix and any number of digits. A `ctid` of `-1` made the handler throw a `RangeError`, which dropped the other rows of the same datagram and could fail a connection still being set up. Only plain decimal digits from 0 to 2^64-1 are read now; anything else reads as 0, as it does everywhere else.

- 3d32e71: A parameter named `__proto__` was lost when a line was parsed, because the parameters went into a plain object, whose `__proto__` setter swallowed it. They now go into an object with no prototype, so every key the server sends is kept as sent.
- def7d6d: `listPermissions` gave every permission the id 0 over the voice protocol, whose `notifypermissionlist` sends no `permid`. There a permission's id is its place in the list, counting from 1 — the `failed_permid` of refused commands confirms it on TeamSpeak 3 and 6 — and `id` is now that. Over ServerQuery the id the server sends is used.

## 1.0.0-beta.1

### Major Changes

- 080e352: `banClient` resolves to a `BanID[]`: the id of every ban it made. The server bans a client on several counts at once — its address, its uid and, on TS6, its myTeamSpeak id — and over ServerQuery answers one `banid` row each, of which only the first was returned. Over the voice protocol, which reports no ids, the list is empty. `addBan`, which makes one ban, still resolves to its id, or `undefined` over the voice protocol.
- de63526: A ban's fields are a `BanFields` — `ip`, `name`, `uid`, `reason`, `durationMs` — which does not extend `CommandOptions`. `addBan` takes it (as `BanOptions`) and its `signal` and `timeout` as the separate last argument; a `signal` set on the ban used to type-check and was never read. `BanClientOptions` is `BanFields`' duration and reason with `CommandOptions`. The commands that send content — `createChannel`, `editChannel`, `updateClient`, `editClient`, `editClientDatabase`, `addServerGroupPermission` — now say that the content and the trailing options are separate arguments.
- 515eed6: The client's lifecycle, commands and events, in line with teamspeak-go:

  - `connect({ signal })` resolves once the handshake completes and rejects with the cause when it fails; `waitConnected()` is gone. Aborting the signal abandons the attempt. `disconnect({ signal })` bounds the goodbye, and a `connect()` it interrupts rejects with `NotConnectedError` instead of waiting forever. `Client` is `AsyncDisposable`.
  - `exec(line, { signal, timeout })` and `execNoWait(line, { signal })` replace `execCommand`, `execCommandWithResponse` and `sendCommandNoWait`. `CommandExecutor.send` takes the same options.
  - `on()` returns a function that removes the listener (also a `Disposable`), and `once()` is new. Listeners run one at a time in arrival order; a listener removed while its event was queued does not get it. Event middleware receives `{ name, payload }` rather than a payload whose kind it had to guess, and is set with the `eventMiddleware` and `commandMiddleware` options only (`useCommandMiddleware` and `useEventMiddleware` are gone).
  - A kick, a ban or the server stopping ends the session at once, and `disconnected` receives a `RemovedError`; a server that stops answering is a `ConnectionTimeoutError`. `disconnected` is `undefined` only after `disconnect()`. Channel kicks, which arrive as a move, now reach `kicked`, which receives a `KickedEvent`. `reasonid` is `reason`, with names in the new `Reason` table.
  - `defaultShouldRetry` replaces `isPermanentFailure`, and does not retry a kick or a ban. `defaultBackoffPolicy` is frozen, `backoffDelay(policy, attempt)` no longer takes a random source, and a jittered delay stays under `maxDelayMs`.
  - The default logger is silent, and `TEAMSPEAK_TRACE_RAW` no longer writes traffic to stderr. `ClientStatus` is a string union. The unused `ChannelInfo` and `ClientState` types are gone, and an IPv6 address is no longer mistaken for one with a port.

- 243db7a: `CommandMiddleware` wraps the typed command layer instead of the wire: it is `(next: CommandExecutor["send"]) => CommandExecutor["send"]`, sees each request and its options, and returns the rows or throws. A middleware can now time, retry or answer a command itself; the old line middleware could only drop one, which left the command waiting out its timeout. Raw `exec`/`execNoWait` lines and the handshake's own commands do not pass through it.
- 9000278: `encodeRequest` and `parseServerCapabilities` are no longer exported. Only the clients encode a `CommandRequest` — a `CommandExecutor` or command middleware is handed the request itself, and `client.send()` encodes it — and only the client reads `initserver`, whose result is `client.serverCapabilities`. `unknownServerCapabilities()` stays public.
- c9e5790: - `EAXTagMismatchError` and `FakeSignatureMismatchError` are no longer exported: they never reached a caller. `CryptoInitError` is now thrown, for a handshake that fails on what the server sent.
  - `TeamspeakError` and every subclass answer `instanceof` across two installed copies of the package, matched by the kinds each instance carries under a shared `Symbol.for("@honeybbq/teamspeak.error")` brand: every class declares a fixed static `kind`, so the match survives a minifier that renames classes.
  - `getClientInfo` throws a `TeamspeakError`, not a plain `Error`, when the server returns no data; a whisper with no or too many targets throws a `RangeError`.
  - `ErrorCode`, `Reason`, `ClientStatus`, every enumeration, `noopLogger` and `consoleLogger` are frozen, as `defaultBackoffPolicy` already was: `ErrorCode.OK = 5` used to stick, for every caller in the process.
- 72ef59a: New branded ids: `BanID`, `MessageID`, `ServerID`, `ClientFileTransferID` and `ServerFileTransferID`, with `asBanID` and the like. They type `BanEntry.id`, `addBan`, `banClient`, `deleteBan`, `OfflineMessage.id`, `getMessage`, `deleteMessage`, `updateMessageFlag`, `WhoAmI.serverID`, `getServerIDByPort`, the transfer ids of `FileUploadInfo`, `FileDownloadInfo` and `ActiveTransfer`, and `stopFileTransfer`. `PermissionLocation` (and so `PermissionOverviewEntry`) is a union discriminated on `target`, with `serverGroupID`, `databaseID`, `channelID` and `channelGroupID` where `id1` and `id2` were; a row with a target `PermissionTarget` does not name is left out. `ServerError.failedPermissionId` is `failedPermissionID`, a `PermissionID`. `ServerGroup.sortID` and `ChannelGroup.sortID` are numbers.
- d91b1cd: A command that exists to return data throws the new `NoDataError` (a `TeamspeakError` with its own kind, carrying the `command`) when the server answers without it: `createChannel`, `createServerGroup`, `copyServerGroup`, `createChannelGroup`, `copyChannelGroup`, `addPrivilegeKey`, `initFileUpload`, `initFileDownload`, `getFileInfo`, `getChannelInfo`, `getClientInfo`, `getClientUIDByID`, `getClientDBIDByUID`, `getClientNameByDBID`, `getClientNameByUID`, `getClientDatabaseInfo`, `getMessage`, `viewLog`, `getServerInfo`, `getHostInfo`, `getInstanceInfo`, `getVersion`, `whoAmI`, `getConnectionInfo` and `getServerIDByPort`. They used to return an id of 0 or an object of empty fields, which read like a real answer; `getClientInfo` threw a plain `TeamspeakError`.
- d5f3640: `listTokens`, `addToken`, `deleteToken` and `useToken` are gone: they did what `listPrivilegeKeys`, `addPrivilegeKey`, `deletePrivilegeKey` and `usePrivilegeKey` do, under the commands' older names.
- 3f1a4a5: One name per concept, as the Go SDK has them: `Identity.publicKeyBase64()` is `publicKey()`; the `TokenType` table is `PrivilegeKeyType`; a `Channel`'s `uniqueIdentifier` is `uid`, of the new `ChannelUID` brand (`asChannelUID`), which keeps it apart from a client's `UID`.
- eba8ac3: Required arguments are positional and everything optional is in one options object, the last argument, which extends `CommandOptions` (`signal`, `timeout`). No command takes a positional optional any more: `moveClient(c, clid, cid, { password })`, `kickClient(c, clid, reason, { reasonMessage })`, `moveChannel(c, cid, parent, { order })`, `deleteChannel(c, cid, { force })`, `deleteServerGroup`/`deleteChannelGroup(c, id, { force })`, `addClientPermission(c, dbid, perm, value, { skip })`, `listFiles(c, cid, path, { password })` (the path is now required), `getFileInfo`/`deleteFile`/`createDirectory(…, { password })`, `stopFileTransfer(c, id, { removePartialFile })`, `listComplaints(c, { targetDatabaseID })` and `listBindings(c, { subsystem })`. `listClients`, `renameFile`, `initFileUpload`, `initFileDownload`, `banClient`, `viewLog`, `listClientDatabase`, `listServerGroupClients` and `listChannelGroupClients` take their own options and the command options in one object. The executor receives only `signal` and `timeout`.
- 93fe79f: Renamed for consistency: `ClientDatabasePage` is now `ClientDatabasePageOptions`, `ChannelGroupClientFilter` is `ChannelGroupClientListOptions`, and `PageOptions` is `PagingOptions`, so every options type ends in `Options`. `TimedOutError` is now `ConnectionTimeoutError`, which says which timeout it is, apart from a command's `CommandTimeoutError`.
- 6b68340: Parameters are encoded as the Go SDK encodes them. `renameFile` always sends `cpw` and sends `tcid` and `tcpw` together, only when the file moves to another channel. `viewLog` always sends `reverse` and `instance`, and `lines` only above 0. An id of 0 where it filters or targets — `createChannel`'s `parentID`, `listChannelGroupClients`' filters, `listComplaints`' `targetDatabaseID` — is omitted, as is `listBindings`' empty `subsystem`. A permission with id 0, which names none, is refused before anything is sent. A file transfer refused after its command succeeded reports the server's `extra_msg` as the ServerError's `extraMessage`.
- d2a4831: `ServerError` carries the server's code as a number, `code`, in place of the string `id`, along with `extraMessage` and `failedPermissionId`. The new `ErrorCode` table names every code (`err.code === ErrorCode.ChannelInvalidPassword`).

  Reconnecting no longer retries a wrong server or channel password: the list of permanent refusals named the wrong codes (1029, 1030, 2569) and now names the real ones (1028, 781, 2568, plus the two bans). An `error` line without an `id` is now a refusal (`ErrorCode.Undefined`), not a success.

- eb6556e: The typed commands, settled for 1.0 and in line with teamspeak-go:

  - Every typed command takes a last, optional `{ signal, timeout }` (`CommandOptions`), passed to the executor. Where a command already has an options object of its own, `CommandOptions` comes after it.
  - Options objects use camelCase names, each mapped to its wire parameter by a table, so a key the type does not name is no longer forwarded onto the wire: `createChannel(client, { name, parentID, topic, password, codec, maxClients, order, isPermanent, deleteDelayMs, ... })`, and likewise `ChannelEditOptions`, `ClientUpdateOptions` (`nickname`, `isAway`, `awayMessage`, `isInputMuted`, ...), `ClientEditOptions`, `ClientDatabaseEditOptions`, `BanOptions`, `LogViewOptions`, `FileRenameOptions`, `ChannelGroupClientListOptions` and `ClientDatabasePageOptions` (`start`, `limit`). An unset field is omitted and `""` is sent empty. `editServer` and `editInstance` still take raw wire properties, now as `Readonly<Record<string, string>>`.
  - A permission is a `Permission`, built with `permissionByID` or `permissionByName`, in place of every `permid`/`permsid` pair: `addChannelPermission(client, cid, permission, value)`, `addClientPermission(client, cldbid, permission, value, skip)`, `addServerGroupPermission(client, sgid, { permission, value, negated, skip })`, `findPermission(client, permission)`. Permission lists return `PermissionEntry { permission, value, negated, skip }`, and `listClientPermissions` returns them too instead of raw rows. `PermissionID` and `IconID` are `number` brands; an icon id is the unsigned CRC32 also when the server sends it signed, and is `undefined` for none.
  - New enumerations `GroupType`, `GroupNameMode`, `TokenType`, `ClientType`, `Codec` and `PermissionTarget`, and `LogLevel` and `TextMessageTarget` now have types. `createServerGroup`, `createChannelGroup` and the copies take a required `GroupType`. `kickClient(client, clid, reason, reasonMessage?)` accepts only `Reason.KickChannel` or `Reason.KickServer`.
  - `sendTextMessage` is replaced by `sendPrivateMessage(client, clid, message)`, `sendChannelMessage(client, message)` and `sendServerMessage(client, message)`; a channel message always reaches the sender's own channel, so it takes none.
  - Timestamps are `Date`s, `undefined` where the server sends 0, and named `...At` (`createdAt`, `lastConnectedAt`, `modifiedAt`, `sentAt`, `startsAt`, `endsAt`); TS6's millisecond and nanosecond file times read correctly. Durations are milliseconds with an `Ms` suffix (`durationMs`, `idleTimeMs`, `runtimeMs`, `deleteDelayMs`, `connectedTimeMs`), rounded to the wire's unit when sent, a positive one never to 0. A ban of 0 is permanent.
  - `iterateClientDatabase(client, { pageSize, signal, timeout })` walks the whole client database page by page; `listClientDatabase(client, { start, limit })` reads one page.
  - Results are `readonly` and named: `ChannelMatch`, `ClientMatch`, `ClientDatabaseName`, `ServerGroupMember`, `ServerGroupRef`, `ChannelGroupMembership`, `Binding`, `ServerVersion`, `PermissionInfo`, `PermissionLocation`, `PermissionOverviewEntry`, `LogPage`. `whoAmI` returns a `WhoAmI`, `getConnectionInfo` a `ServerConnectionInfo` (the virtual server's traffic, not the connection's), `listPermissions` `PermissionInfo[]`, `getPermissionOverview` typed entries and always asks for every permission. `Channel.order` is the `ChannelID` it sorts after. `ClientEntry.serverGroups` is a list of `ServerGroupID`s. `FileEntry.isDirectory` replaces `type`, whose documented meaning was reversed. `PrivilegeKey` and `PrivilegeKeyOptions` name the group and channel (`serverGroupID`, or `channelGroupID` and `channelID`) instead of `id1`/`id2`, whose documentation was swapped.
  - Fixes: a list the server reports empty with error 1281 (`listBans` on a server with no bans, and the like) returns `[]` instead of throwing. `viewLog` returns the log's lines, which it read from a field the server never sends, and its positions are numbers. `addTempPassword` sends the caller's password — it sent an empty one — and returns nothing. `findClientDatabase` returns database ids, the only thing the server reports. `addBan` and `banClient` return `undefined` rather than `0n` when the server reports no id, and an empty ban pattern is never sent.

- 426ee5c: `initFileUpload` does not replace a file already at the path unless passed `overwrite: true`. It used to by default, so an upload to a name that was taken destroyed the file there.
- 2aad9ea: The branded id constructors validate: `asClientID`, `asClientFileTransferID` and `asServerFileTransferID` take an integer from 0 to 65535, `asPermissionID` one from 0 to 2^32−1, `asIconID` one from −2^31 to 2^32−1, and the bigint ids — `asChannelID`, `asClientDBID`, `asServerGroupID`, `asChannelGroupID`, `asBanID`, `asMessageID`, `asServerID` — one from 0 to 2^64−1; anything else throws a `RangeError`. They used to brand whatever they were given. Ids read from the server never throw: one outside its range reads as 0.
- 7c30135: The command language's plumbing is no longer public API: `parseCommand`, `buildCommand`, `buildCommandOrdered` and the `Command` and `EscapedString` types are gone from the package entry. `escape` and `unescape` remain, for raw lines sent with `exec`, and `escape` returns `string`. The builders now escape parameter names as well as values.

### Patch Changes

- cde0711: `CommandRequest`'s optional `params`, `rows` and `passwords` accept `undefined`, so a command middleware can build a request with them unset under `exactOptionalPropertyTypes`.
- b60dfff: `deleteFile` with several paths now works: the names were sent as one `name` parameter holding `/a|/b`, a single path the server refused; they are rows of the command (`name=/a|name=/b`), as TS3 and TS6 expect. A `CommandRequest` can carry such rows in its new `rows` field.
- 9ff18a0: Every list and find answers an empty list for the server's "database empty result set" (1281) instead of throwing it: `listChannels`, `listClients`, `getClientIDs`, `listFiles`, `listChannelGroups`, `listPermissions`, `listServerGroups`, `listBindings` and `getServerGroupsByClient` now do too. `findClients` and `findChannels` answer `[]` when they find nothing, which the server reports as 512 and 768.
- f9e4490: `instanceof` across two copies of the package no longer depends on class names, which a consumer's minifier renames (`esbuild --minify` made every cross-copy check false). Each error class declares a fixed static `kind`, an instance carries its class's kinds and those it extends under the `Symbol.for("@honeybbq/teamspeak.error")` brand, and `instanceof` compares kinds, so a `ServerError` from one copy is still a `TeamspeakError` of the other.
- cc098a7: Documented which sets may grow in a minor release — the events, `ClientStatus`, `ServerFamily`, `UIDAlgorithm`, `ErrorCode`, `Reason` and the enumeration tables — so a `switch` over one needs a default case. Doc comments of exported symbols describe behaviour, not history.
- 019f765: The packages ship their `LICENSE` (the client's had none) and their TypeScript sources, so source maps and declaration maps resolve to real files, and the JavaScript is no longer minified: class names such as `Client` and `ConnectionTimeoutError` read as themselves in stack traces and `util.inspect()`.

## @honeybbq/teamspeak-client (before 1.0.0-beta.5)

## 1.0.0-beta.4

### Major Changes

- 0649001: `CryptoInitError` is renamed `HandshakeError`, to match the Go SDK's `ErrHandshake`: `connect()` rejects with it when the handshake fails on what the server sent.

### Minor Changes

- baf482f: Add `trace` to `ClientOptions`: hooks called synchronously at each milestone of a client's life, for timing, metrics, logs and progress displays. For every connection attempt, the reconnect loop's included, they report `resolveStart`, `resolveDone` (with every candidate the resolver gave), `connectStart`, `connectDone` (with the local address), `handshakeDone` (with the RSA puzzle's level and duration, the packets sent again, and the server's public key for pinning), `sessionStart` (with the accepted nickname, talk power and the `initserver` parameters without any secret) and `welcomeDone` (with the channel the client landed in and the channels and clients delivered), or `attemptFailed` with the phase (`ConnectPhase`: `open`, `handshake` or `join`); then `disconnectStart`, `disconnectDone` and `sessionEnd` when a session ends, and `reconnectScheduled` and `reconnectStopped` for the reconnect loop. Every attempt ends with exactly one of `sessionStart` and `attemptFailed`, and every session with exactly one `sessionEnd`. `uploadFileData`, `downloadFileData` and `dialFileTransfer` take a `trace` of their own in `FileTransferOptions` (`dialStart`, `dialDone`, `progress`, `done`, `failed`; the transfer key is never reported), and so do the client's methods that forward to them. A hook that throws is reported like a throwing listener and never affects the connection or the transfer. `ServerCapabilities` gains `serverID`, `serverUID`, `hostMessage` and `hostMessageMode`.

### Patch Changes

- 4f7283c: `disconnect()` waited a full second every time. It waited for an error line in answer to its goodbye, but TeamSpeak 3 and 6 answer `clientdisconnect` with a `notifyclientleftview` about the client itself and no error line. That announcement now ends the wait, so a disconnect takes a few milliseconds.
- 0649001: File transfers, cancellation and a few error details now behave the way the platform's own APIs do:

  - A file transfer that moves no byte for `idleTimeoutMs` (30 seconds unless set; 0 turns it off) fails with a `FileTransferError`. Before, a server that went silent held it until the caller's signal ended it. Writing the transfer key now honours the signal and the dial timeout too.
  - A download that sends more than the size the server announced fails after that size, without writing the excess, and one that ends short of it fails. Both used to succeed.
  - `client.events()` rejects with the signal's reason when the signal aborts, as Node's `events.on` does, instead of ending quietly. Calling `next()` again before the previous call settles no longer loses a call. The iterator also stops listening when a disconnect ends it, not only when the loop calls `return()`.
  - SRV records are tried in the order RFC 2782 gives: by priority, then by weight. Before, the order was the one the DNS answer arrived in.
  - `Resolver.resolve("")` throws an `InvalidAddressError` rather than a plain `Error`.
  - An error's `name` is no longer an own enumerable property, so `JSON.stringify(err)` and `Object.keys(err)` treat it as they treat a built-in error's.
  - Timeouts and the flood throttle measure time with a monotonic clock, so a change of the system clock cannot stall or burst them.

- Updated dependencies [0649001]
  - @honeybbq/teamspeak-core@1.0.0-beta.4

## 1.0.0-beta.3

### Major Changes

- b13a0bc: Node 22.12 or newer is required; Node 20 reached its end of life in April 2026.

### Patch Changes

- b13a0bc: `listChannels` now returns the fields its type declares. It used to send a bare `channellist`, so the topic was always empty and the permanent, default and password flags, the codec, the client limit and the icon were always zero or false. It now asks for all of them. Each channel also gains five fields: `isSemiPermanent`, `maxFamilyClients`, `totalClients`, `totalFamilyClients` and `neededSubscribePower`. The description and unique identifier are still not part of `channellist`; `getChannelInfo` has them.
- Updated dependencies [b13a0bc]
- Updated dependencies [b13a0bc]
- Updated dependencies [b13a0bc]
  - @honeybbq/teamspeak-core@1.0.0-beta.3

## 1.0.0-beta.2

### Minor Changes

- def7d6d: `PermissionName` names every permission TeamSpeak 3.13 and 6 servers list, for `permissionByName`: `permissionByName(PermissionName.ClientTalkPower)`. It is a frozen table and a union type of its values, like `ErrorCode`; `permissionByName` still takes any string, so a permission the table lacks works as before. Seven exist only on TeamSpeak 6 and say so.
- 3d32e71: `CommandName`, `NotificationName` and `PropertyName` name what TeamSpeak 3.13 and 6 servers send on the wire, so a raw line or a property key no longer has to be spelled from memory: `client.exec(CommandName.ServerGroupList)`, `n.name === NotificationName.ChannelEdited`, `info[PropertyName.VirtualServerName]`. Each is a frozen table and a union type of its values, like `PermissionName`. `NotificationEvent.name` and `CommandRequest.command` accept these names with autocompletion and still take any string, since a server may send names the tables lack.

### Patch Changes

- 4326d90: A line of rows that each named a field of their own made the rows grow with the square of the line: TeamSpeak leaves out of a row the fields unchanged from the one before, so every row took on all the fields of all the rows before it, and one line of a few hundred kilobytes from a server, or from anyone who could forge its first packets, expanded to gigabytes. The rows of a line are now held to a size in proportion to the line itself; past it, rows carry only the fields they were sent with. The rows of a real server's line never come near it.

  After the 16-bit packet id wrapped, a command the server sent again because its acknowledgement was lost, with an id just behind the receive window, was taken for one far ahead of it and dropped unanswered, so the server went on sending it. It is now recognised as already delivered and acknowledged again.

  `parseUint64`, and with it the channel id of `notifyclientmoved`, accepted a sign, a hex prefix and any number of digits. A `ctid` of `-1` made the handler throw a `RangeError`, which dropped the other rows of the same datagram and could fail a connection still being set up. Only plain decimal digits from 0 to 2^64-1 are read now; anything else reads as 0, as it does everywhere else.

- a27c5d7: A connection attempt could hang until its timeout when the server dropped a packet of the handshake, which it does under load: only the first packet was ever sent again. Every handshake step is now resent until the server answers the last one.
- 3d32e71: A parameter named `__proto__` was lost when a line was parsed, because the parameters went into a plain object, whose `__proto__` setter swallowed it. They now go into an object with no prototype, so every key the server sends is kept as sent.
- def7d6d: `listPermissions` gave every permission the id 0 over the voice protocol, whose `notifypermissionlist` sends no `permid`. There a permission's id is its place in the list, counting from 1 — the `failed_permid` of refused commands confirms it on TeamSpeak 3 and 6 — and `id` is now that. Over ServerQuery the id the server sends is used.
- Updated dependencies [4326d90]
- Updated dependencies [3d32e71]
- Updated dependencies [def7d6d]
- Updated dependencies [def7d6d]
- Updated dependencies [3d32e71]
  - @honeybbq/teamspeak-core@1.0.0-beta.2

## 1.0.0-beta.1

### Major Changes

- f8f9789: The client's state is read through getters, as `status` already was: `clientID`, `channelID`, `serverCapabilities`, and `uid`, which replaces `uniqueIdentifier()`.
- 515eed6: The client's lifecycle, commands and events, in line with teamspeak-go:

  - `connect({ signal })` resolves once the handshake completes and rejects with the cause when it fails; `waitConnected()` is gone. Aborting the signal abandons the attempt. `disconnect({ signal })` bounds the goodbye, and a `connect()` it interrupts rejects with `NotConnectedError` instead of waiting forever. `Client` is `AsyncDisposable`.
  - `exec(line, { signal, timeout })` and `execNoWait(line, { signal })` replace `execCommand`, `execCommandWithResponse` and `sendCommandNoWait`. `CommandExecutor.send` takes the same options.
  - `on()` returns a function that removes the listener (also a `Disposable`), and `once()` is new. Listeners run one at a time in arrival order; a listener removed while its event was queued does not get it. Event middleware receives `{ name, payload }` rather than a payload whose kind it had to guess, and is set with the `eventMiddleware` and `commandMiddleware` options only (`useCommandMiddleware` and `useEventMiddleware` are gone).
  - A kick, a ban or the server stopping ends the session at once, and `disconnected` receives a `RemovedError`; a server that stops answering is a `ConnectionTimeoutError`. `disconnected` is `undefined` only after `disconnect()`. Channel kicks, which arrive as a move, now reach `kicked`, which receives a `KickedEvent`. `reasonid` is `reason`, with names in the new `Reason` table.
  - `defaultShouldRetry` replaces `isPermanentFailure`, and does not retry a kick or a ban. `defaultBackoffPolicy` is frozen, `backoffDelay(policy, attempt)` no longer takes a random source, and a jittered delay stays under `maxDelayMs`.
  - The default logger is silent, and `TEAMSPEAK_TRACE_RAW` no longer writes traffic to stderr. `ClientStatus` is a string union. The unused `ChannelInfo` and `ClientState` types are gone, and an IPv6 address is no longer mistaken for one with a port.

- 243db7a: `CommandMiddleware` wraps the typed command layer instead of the wire: it is `(next: CommandExecutor["send"]) => CommandExecutor["send"]`, sees each request and its options, and returns the rows or throws. A middleware can now time, retry or answer a command itself; the old line middleware could only drop one, which left the command waiting out its timeout. Raw `exec`/`execNoWait` lines and the handshake's own commands do not pass through it.
- 9000278: `encodeRequest` and `parseServerCapabilities` are no longer exported. Only the clients encode a `CommandRequest` — a `CommandExecutor` or command middleware is handed the request itself, and `client.send()` encodes it — and only the client reads `initserver`, whose result is `client.serverCapabilities`. `unknownServerCapabilities()` stays public.
- c9e5790: - `EAXTagMismatchError` and `FakeSignatureMismatchError` are no longer exported: they never reached a caller. `CryptoInitError` is now thrown, for a handshake that fails on what the server sent.
  - `TeamspeakError` and every subclass answer `instanceof` across two installed copies of the package, matched by the kinds each instance carries under a shared `Symbol.for("@honeybbq/teamspeak.error")` brand: every class declares a fixed static `kind`, so the match survives a minifier that renames classes.
  - `getClientInfo` throws a `TeamspeakError`, not a plain `Error`, when the server returns no data; a whisper with no or too many targets throws a `RangeError`.
  - `ErrorCode`, `Reason`, `ClientStatus`, every enumeration, `noopLogger` and `consoleLogger` are frozen, as `defaultBackoffPolicy` already was: `ErrorCode.OK = 5` used to stick, for every caller in the process.
- e6a8765: Event types are named after their event: `TextMessageEvent` (was `TextMessage`), `ClientEnterEvent` (was `ClientInfo`, still a `ClientEntry`), `ClientLeaveEvent` (was `ClientLeftViewEvent`), `VoiceDataEvent` (was `VoiceData`) and `NotificationEvent` (was `RawNotification`). The client an event is about is `clientID` in `ClientMovedEvent` and `ClientLeaveEvent` (was `id`). `TextMessageEvent.targetMode` and `VoiceDataEvent.codec` are `number`, since a server may send a value the `TextMessageTarget` and `Codec` tables do not name.
- d9a641c: - Events and the client's own accessors use the branded ids: `clientID()` is a `ClientID`, `channelID()` a `ChannelID`, `uniqueIdentifier()` a `UID`, and every event's ids, uids and groups are branded. `clientEnter` delivers the same `ClientEntry` record `listClients` returns. `VoiceData.clientId` is `clientID`, and `sendVoice`/`sendWhisper` take a `Codec` and `ClientID`s.
  - `events(name, { signal })` iterates an event with `for await`.
  - `socketFactory` returns a `DatagramSocket`, the few methods the client uses, rather than a `node:dgram` socket; `fileTransferSocketFactory` returns any `Duplex`.
  - File transfers take `{ signal }`: `uploadFileData`, `downloadFileData` and `dialFileTransfer` take an options object as their last argument (the socket factory moves into it), dialing is bounded, and a stream error during the key handshake no longer escapes as an unhandled `error` event.
- 82a4546: `Identity` is immutable and opaque. `upgradeToLevel(level, { signal })` returns a new identity rather than changing this one, and a level above 160 (the width of SHA-1) is refused with a `RangeError`, as it is by `generateIdentity`. `offset` is read-only, the `privateKey` property is gone (`export()` is the one way to the secret), and the constructor is private. `identity.uid(algorithm)` is new. `parseIdentity` throws only `InvalidIdentityError`, with the underlying failure as its cause. `getUidFromPublicKey(publicKey, algorithm = "sha1")` is `uidFromPublicKey(publicKey, algorithm)`, which takes the algorithm explicitly and returns a `UID`; its type, `UIDAlgorithm`, is exported.
- a0bd288: `Identity.toString()` returned the private key, so an identity interpolated into a log line leaked it. `toString()`, `toJSON()` and `util.inspect()` now describe the identity without its key, and `export()` is the one way to get the secret form. `identityFromString` is renamed `parseIdentity`. `generateIdentity()` is async and takes `{ signal }`, keeping the event loop running at high levels; `generateIdentitySync()` keeps the old behaviour. `upgradeToLevel()` takes `{ signal }` as an options object.
- 72ef59a: New branded ids: `BanID`, `MessageID`, `ServerID`, `ClientFileTransferID` and `ServerFileTransferID`, with `asBanID` and the like. They type `BanEntry.id`, `addBan`, `banClient`, `deleteBan`, `OfflineMessage.id`, `getMessage`, `deleteMessage`, `updateMessageFlag`, `WhoAmI.serverID`, `getServerIDByPort`, the transfer ids of `FileUploadInfo`, `FileDownloadInfo` and `ActiveTransfer`, and `stopFileTransfer`. `PermissionLocation` (and so `PermissionOverviewEntry`) is a union discriminated on `target`, with `serverGroupID`, `databaseID`, `channelID` and `channelGroupID` where `id1` and `id2` were; a row with a target `PermissionTarget` does not name is left out. `ServerError.failedPermissionId` is `failedPermissionID`, a `PermissionID`. `ServerGroup.sortID` and `ChannelGroup.sortID` are numbers.
- d91b1cd: A command that exists to return data throws the new `NoDataError` (a `TeamspeakError` with its own kind, carrying the `command`) when the server answers without it: `createChannel`, `createServerGroup`, `copyServerGroup`, `createChannelGroup`, `copyChannelGroup`, `addPrivilegeKey`, `initFileUpload`, `initFileDownload`, `getFileInfo`, `getChannelInfo`, `getClientInfo`, `getClientUIDByID`, `getClientDBIDByUID`, `getClientNameByDBID`, `getClientNameByUID`, `getClientDatabaseInfo`, `getMessage`, `viewLog`, `getServerInfo`, `getHostInfo`, `getInstanceInfo`, `getVersion`, `whoAmI`, `getConnectionInfo` and `getServerIDByPort`. They used to return an id of 0 or an object of empty fields, which read like a real answer; `getClientInfo` threw a plain `TeamspeakError`.
- d5f3640: `listTokens`, `addToken`, `deleteToken` and `useToken` are gone: they did what `listPrivilegeKeys`, `addPrivilegeKey`, `deletePrivilegeKey` and `usePrivilegeKey` do, under the commands' older names.
- 3f1a4a5: One name per concept, as the Go SDK has them: `Identity.publicKeyBase64()` is `publicKey()`; the `TokenType` table is `PrivilegeKeyType`; a `Channel`'s `uniqueIdentifier` is `uid`, of the new `ChannelUID` brand (`asChannelUID`), which keeps it apart from a client's `UID`.
- eba8ac3: Required arguments are positional and everything optional is in one options object, the last argument, which extends `CommandOptions` (`signal`, `timeout`). No command takes a positional optional any more: `moveClient(c, clid, cid, { password })`, `kickClient(c, clid, reason, { reasonMessage })`, `moveChannel(c, cid, parent, { order })`, `deleteChannel(c, cid, { force })`, `deleteServerGroup`/`deleteChannelGroup(c, id, { force })`, `addClientPermission(c, dbid, perm, value, { skip })`, `listFiles(c, cid, path, { password })` (the path is now required), `getFileInfo`/`deleteFile`/`createDirectory(…, { password })`, `stopFileTransfer(c, id, { removePartialFile })`, `listComplaints(c, { targetDatabaseID })` and `listBindings(c, { subsystem })`. `listClients`, `renameFile`, `initFileUpload`, `initFileDownload`, `banClient`, `viewLog`, `listClientDatabase`, `listServerGroupClients` and `listChannelGroupClients` take their own options and the command options in one object. The executor receives only `signal` and `timeout`.
- 93fe79f: Renamed for consistency: `ClientDatabasePage` is now `ClientDatabasePageOptions`, `ChannelGroupClientFilter` is `ChannelGroupClientListOptions`, and `PageOptions` is `PagingOptions`, so every options type ends in `Options`. `TimedOutError` is now `ConnectionTimeoutError`, which says which timeout it is, apart from a command's `CommandTimeoutError`.
- e5495ea: - Supplying `reconnect` turns reconnecting on; `ReconnectOptions.enabled` is gone.
  - `ClientOptions`, `ReconnectOptions` and `BackoffPolicy` fields are `readonly`, and every optional one accepts `undefined`, so `serverPassword: process.env.X` compiles under `exactOptionalPropertyTypes` (the README's Quick Start did not). An undefined `backoff` field keeps its default.
  - `AddrResolver.resolve(addr, { signal })` takes the signal in an options object and may return a readonly array; `ResolvedAddr` is readonly, with `source` and `expiry` optional.
  - `defaultShouldRetry(error)` takes only the error.
- 144f55e: A dot-less address is no longer sent to named.myteamspeak.com as a server nickname unless `resolveNicknames: true` is set; otherwise it is resolved like any host. Address resolution is bounded at eight seconds in all, the TSDNS probes of parent domains run at once rather than one three-second timeout after another, and the probes honour the connect signal.
- 4e5cafe: Commands, `exec`, `execNoWait`, `sendVoice` and `sendWhisper` fail with a `NotConnectedError` unless the client is connected. They used to need only an open socket, so a command sent while `connect()` was still running — a `clientmove` with its channel password hash, say — went out under the public dummy key, and one sent once `disconnect()` had begun went out after the goodbye started. The handshake's own commands take an internal path.
- d2a4831: `ServerError` carries the server's code as a number, `code`, in place of the string `id`, along with `extraMessage` and `failedPermissionId`. The new `ErrorCode` table names every code (`err.code === ErrorCode.ChannelInvalidPassword`).

  Reconnecting no longer retries a wrong server or channel password: the list of permanent refusals named the wrong codes (1029, 1030, 2569) and now names the real ones (1028, 781, 2568, plus the two bans). An `error` line without an `id` is now a refusal (`ErrorCode.Undefined`), not a success.

- 7977fec: `parseIdentity` validates strictly: the key must be canonical base64 of at most 32 bytes — checked by a round trip, since Node's decoder skips what it cannot read and loaded such a string as some other key — and the offset a decimal unsigned 64-bit integer. Anything else throws an `InvalidIdentityError`.
- eb6556e: The typed commands, settled for 1.0 and in line with teamspeak-go:

  - Every typed command takes a last, optional `{ signal, timeout }` (`CommandOptions`), passed to the executor. Where a command already has an options object of its own, `CommandOptions` comes after it.
  - Options objects use camelCase names, each mapped to its wire parameter by a table, so a key the type does not name is no longer forwarded onto the wire: `createChannel(client, { name, parentID, topic, password, codec, maxClients, order, isPermanent, deleteDelayMs, ... })`, and likewise `ChannelEditOptions`, `ClientUpdateOptions` (`nickname`, `isAway`, `awayMessage`, `isInputMuted`, ...), `ClientEditOptions`, `ClientDatabaseEditOptions`, `BanOptions`, `LogViewOptions`, `FileRenameOptions`, `ChannelGroupClientListOptions` and `ClientDatabasePageOptions` (`start`, `limit`). An unset field is omitted and `""` is sent empty. `editServer` and `editInstance` still take raw wire properties, now as `Readonly<Record<string, string>>`.
  - A permission is a `Permission`, built with `permissionByID` or `permissionByName`, in place of every `permid`/`permsid` pair: `addChannelPermission(client, cid, permission, value)`, `addClientPermission(client, cldbid, permission, value, skip)`, `addServerGroupPermission(client, sgid, { permission, value, negated, skip })`, `findPermission(client, permission)`. Permission lists return `PermissionEntry { permission, value, negated, skip }`, and `listClientPermissions` returns them too instead of raw rows. `PermissionID` and `IconID` are `number` brands; an icon id is the unsigned CRC32 also when the server sends it signed, and is `undefined` for none.
  - New enumerations `GroupType`, `GroupNameMode`, `TokenType`, `ClientType`, `Codec` and `PermissionTarget`, and `LogLevel` and `TextMessageTarget` now have types. `createServerGroup`, `createChannelGroup` and the copies take a required `GroupType`. `kickClient(client, clid, reason, reasonMessage?)` accepts only `Reason.KickChannel` or `Reason.KickServer`.
  - `sendTextMessage` is replaced by `sendPrivateMessage(client, clid, message)`, `sendChannelMessage(client, message)` and `sendServerMessage(client, message)`; a channel message always reaches the sender's own channel, so it takes none.
  - Timestamps are `Date`s, `undefined` where the server sends 0, and named `...At` (`createdAt`, `lastConnectedAt`, `modifiedAt`, `sentAt`, `startsAt`, `endsAt`); TS6's millisecond and nanosecond file times read correctly. Durations are milliseconds with an `Ms` suffix (`durationMs`, `idleTimeMs`, `runtimeMs`, `deleteDelayMs`, `connectedTimeMs`), rounded to the wire's unit when sent, a positive one never to 0. A ban of 0 is permanent.
  - `iterateClientDatabase(client, { pageSize, signal, timeout })` walks the whole client database page by page; `listClientDatabase(client, { start, limit })` reads one page.
  - Results are `readonly` and named: `ChannelMatch`, `ClientMatch`, `ClientDatabaseName`, `ServerGroupMember`, `ServerGroupRef`, `ChannelGroupMembership`, `Binding`, `ServerVersion`, `PermissionInfo`, `PermissionLocation`, `PermissionOverviewEntry`, `LogPage`. `whoAmI` returns a `WhoAmI`, `getConnectionInfo` a `ServerConnectionInfo` (the virtual server's traffic, not the connection's), `listPermissions` `PermissionInfo[]`, `getPermissionOverview` typed entries and always asks for every permission. `Channel.order` is the `ChannelID` it sorts after. `ClientEntry.serverGroups` is a list of `ServerGroupID`s. `FileEntry.isDirectory` replaces `type`, whose documented meaning was reversed. `PrivilegeKey` and `PrivilegeKeyOptions` name the group and channel (`serverGroupID`, or `channelGroupID` and `channelID`) instead of `id1`/`id2`, whose documentation was swapped.
  - Fixes: a list the server reports empty with error 1281 (`listBans` on a server with no bans, and the like) returns `[]` instead of throwing. `viewLog` returns the log's lines, which it read from a field the server never sends, and its positions are numbers. `addTempPassword` sends the caller's password — it sent an empty one — and returns nothing. `findClientDatabase` returns database ids, the only thing the server reports. `addBan` and `banClient` return `undefined` rather than `0n` when the server reports no id, and an empty ban pattern is never sent.

- 7c30135: The command language's plumbing is no longer public API: `parseCommand`, `buildCommand`, `buildCommandOrdered` and the `Command` and `EscapedString` types are gone from the package entry. `escape` and `unescape` remain, for raw lines sent with `exec`, and `escape` returns `string`. The builders now escape parameter names as well as values.

### Minor Changes

- 5979064: Commands are traced on the `honeybbq:teamspeak:command` tracing channel and incoming commands published on `honeybbq:teamspeak:packet`, through `node:diagnostics_channel`, in place of the removed `TEAMSPEAK_TRACE_RAW`. The messages carry the command's name, never its parameters.
- ade4934: `connect()` rejects with the new `InvalidAddressError` for an address that cannot be one — no host, a host with characters no host has, or a port outside 1–65535 — before anything starts, instead of a Node `RangeError` or `TypeError` after the attempt had begun. A host name that does not resolve fails the attempt with a `TeamspeakError` whose `cause` is the lookup's error (`ENOTFOUND`, `EAI_AGAIN`), since a lookup may fail for a while and then succeed. `defaultShouldRetry` does not retry an `InvalidAddressError`.
- 0741c02: `serverCapabilities()` also reports what `initserver` says about the server: `name`, `iconID` (the unsigned CRC32, also when the server sends it signed), `hostBannerImageURL` and `welcomeMessage`. The new `notification` event delivers every notification as it arrived, for the ones the SDK does not model. Both after EchoSixHIYA/teamspeak-js.

### Patch Changes

- 5c63f5d: Address resolution reads at most 8 KiB from a TSDNS server or the nickname service. Each answers with one short line; one that kept sending was held in memory until the resolution budget ran out.
- cfd4a11: `clientEnter`, `clientLeave` and `clientMoved` are no longer emitted for a row with client id 0, or with none: no client has that id. The raw `notification` event still carries the row.
- 9a93172: `connect()` called while a `disconnect()` is still waiting for the server to acknowledge its goodbye now waits for that disconnect to finish, then connects. It used to start the new attempt at once, which the finishing disconnect then tore down: the new `connect()` rejected with a `NotConnectedError`, no socket opened, and listeners heard `disconnected` twice. A `disconnect()` called during that wait wins, and the waiting `connect()` rejects with a `NotConnectedError`; a second `disconnect()` during a goodbye waits for the first.
- b60dfff: `deleteFile` with several paths now works: the names were sent as one `name` parameter holding `/a|/b`, a single path the server refused; they are rows of the command (`name=/a|name=/b`), as TS3 and TS6 expect. A `CommandRequest` can carry such rows in its new `rows` field.
- f9e4490: `instanceof` across two copies of the package no longer depends on class names, which a consumer's minifier renames (`esbuild --minify` made every cross-copy check false). Each error class declares a fixed static `kind`, an instance carries its class's kinds and those it extends under the `Symbol.for("@honeybbq/teamspeak.error")` brand, and `instanceof` compares kinds, so a `ServerError` from one copy is still a `TeamspeakError` of the other.
- d7819e6: The command throttle releases waiting commands in the order they arrived. Each waiter used to poll for a token on its own timer, so a command sent later could take the turn of one that had waited longer, and commands went out of order.
- cc098a7: Documented which sets may grow in a minor release — the events, `ClientStatus`, `ServerFamily`, `UIDAlgorithm`, `ErrorCode`, `Reason` and the enumeration tables — so a `switch` over one needs a default case. Doc comments of exported symbols describe behaviour, not history.
- c9970cc: A packet from the server can no longer crash the process. Every step of the receive path — parsing, decryption, reassembly, decompression, the handshake — is bounded, and whatever it throws is caught: during the handshake the connection fails with a `CryptoInitError` carrying the cause (an Init1 RSA challenge above 100000 squarings, a malformed public key, license or proof), and once connected the packet is dropped. Init1 and the handshake commands are ignored once crypto init has completed, the public dummy key is no longer accepted after it (except for the acknowledgement of `clientek`, which TS3 and TS6 both send under it), QuickLZ input is bounds-checked and capped at 1 MiB, and a command reassembled from fragments is capped at 1 MiB too.
- 641e377: The idle timeout is reset only by a packet that decrypts. Any datagram used to reset it, so anyone able to send to the client's port could keep a session the server had left looking connected forever.
- 7f3e44d: `initserver` is taken only once crypto init has completed. One arriving before, which needs nothing but the public dummy key, used to resolve `connect()` as connected on a session without keys, so the next command — with any password hash it carried — went out under the dummy key.
- 2821aed: A server's license chain may have at most 8 blocks, and a block that declares more bytes than the license holds is rejected; either fails the handshake with a CryptoInitError. TS3 sends two blocks and TS6 three, but every block costs a point multiplication, so a chain of a thousand held the event loop for seconds.
- 295fdd8: - `connect()` is cancellable all the way down: the address lookup and the socket being opened stop when the signal aborts or `disconnect()` interrupts, and a socket that finishes connecting afterwards is closed rather than started, so no handshake can complete, and no `connected` be emitted, after `disconnect()`.
  - `sendVoice`, `sendWhisper` and `execNoWait` throw (or reject with) a `NotConnectedError` when there is no connection, rather than dropping the data silently.
  - A command's `timeout` and `signal` now bound its wait for the flood throttle too, and `execNoWait`'s signal is honoured there; the throttle no longer leaves an abort listener behind.
  - Voice deliveries are dropped while more than 256 deliveries are pending, with a warning at most every ten seconds; `events("voiceData")` buffers at most 256 frames. `events()` stops listening and discards its buffer as soon as its signal aborts.
  - The reconnect loop's backoff keeps the process alive, and a `shouldRetry` that throws ends the loop with an error log instead of an unhandled rejection.
- 704a7bb: A packet is decrypted under the generation the receive window gives its id, and no other. The client used to try the generations either side too, so an old packet replayed once the 16-bit id had wrapped was taken again; neither TS3 nor TS6 ever needed the guess.
- 5d933ff: The end of one session is never heard during the next. `disconnect()` resolves once its `disconnected` has been delivered, and a `connect()` waits for an earlier session's `disconnected` — after a drop or a failed attempt — to be delivered before it starts. It used to be still queued, so a listener added after `await disconnect()` heard it, and an `events()` iterator started for the new session ended at once. `connected` is, as before, delivered after `connect()` resolves; that and the goodbye's bound — a second at most, less if the caller's signal aborts sooner — are now documented.
- 941cdfd: The client answers at most one Init1 RSA challenge per connection attempt. A repeat of the same challenge, which means the answer was lost, gets the same answer again without solving anything; a different challenge gets none. A server could otherwise keep the event loop busy with challenge after challenge, each up to 100000 synchronous squarings.
- 019f765: The packages ship their `LICENSE` (the client's had none) and their TypeScript sources, so source maps and declaration maps resolve to real files, and the JavaScript is no longer minified: class names such as `Client` and `ConnectionTimeoutError` read as themselves in stack traces and `util.inspect()`.
- 6b68340: Parameters are encoded as the Go SDK encodes them. `renameFile` always sends `cpw` and sends `tcid` and `tcpw` together, only when the file moves to another channel. `viewLog` always sends `reverse` and `instance`, and `lines` only above 0. An id of 0 where it filters or targets — `createChannel`'s `parentID`, `listChannelGroupClients`' filters, `listComplaints`' `targetDatabaseID` — is omitted, as is `listBindings`' empty `subsystem`. A permission with id 0, which names none, is refused before anything is sent. A file transfer refused after its command succeeded reports the server's `extra_msg` as the ServerError's `extraMessage`.
- d60d618: Before crypto init completes, the client handles only `clientinitiv`, `initivexpand2` and `error`. Every other line — notifications, `initserver`, data rows, commands it does not know — is dropped with a debug log: a packet then needs nothing but the public dummy key, so anyone on the path could have forged it, a text message or poke from "Admin" among them. A pre-init `error` can still fail the attempt, but never takes the ban path, which only a connected session does.
- c42ad50: A `Client` keeps its connection state in private fields: `util.inspect(client)` and `JSON.stringify(client)` used to include the session's IV and signature, the handler and the plain-text passwords, through members that were hidden from the types but not at runtime. The server and default channel passwords are hashed once, when the client is made, and held only in that form. The diagnostics messages' `client` is typed `Client`, and a command that times out is named, never quoted.
- 1f63c8a: The receive path bounds what a server can make the client hold. A datagram over 4096 bytes is dropped unread (TeamSpeak's are at most 500). The command packets waiting for a missing one hold at most 1 MiB across both queues; past that a packet is dropped unacknowledged, so the server resends it, while the packet they wait for is always taken. A QuickLZ block declaring more than its bytes could expand to — level 1 yields at most about 82 times its input — is refused before its output is allocated. A server sending a window of large datagrams on both queues made a client hold 120 MB.
- cffc071: The reconnect loop ends when the client is connected, or connecting, by other means — a `connect()` of your own during the backoff — instead of carrying on beside the new session. `defaultShouldRetry` now treats an `AlreadyConnectedError` as a reason to stop.
- 7ecb2ef: The reconnect loop no longer gives up its slot when the session it just reconnected drops before the loop resumes, as when the server finishes the handshake and stops in the same datagram. The loop used to log "reconnected" while the client was disconnected, and nothing retried; it now goes on retrying until its attempt is still connected when it resumes, with the drop's cause passed to `shouldRetry`.
- 5f43f48: Address resolution has ten seconds in all, and the client holds a custom `resolver` to it too: the `signal` the resolver is given aborts once the budget is spent, and the client connects to the address as given. A custom resolver used to be bounded by nothing but the caller's signal, and the built-in one had eight seconds.
- c461c94: Garbage received before the handshake can no longer poison the session keys. A packet that failed the dummy key before crypto init was retried with session keys derived from the still-empty IV, and those public keys stayed cached once the real IV was set. Before crypto init only the dummy key is tried now, and setting the IV clears every cached key.
- 145209e: A listener that throws no longer stops the listeners after it from getting the same event. Each listener runs on its own; an exception is rethrown from a microtask, so it still surfaces as an `uncaughtException`, as an EventEmitter listener's would.
- 528b667: Once crypto init has completed, a command packet (Command or CommandLow) marked unencrypted is dropped. Such a packet used to be accepted on the fake signature alone, which every plaintext ping, pong and voice packet carries, so anyone on the path could forge text messages, kicks and command answers. Voice, ping, pong and acknowledgements stay acceptable unencrypted: TS3 3.13 and TS6 6.0 both acknowledge commands with plaintext Acks, and an Ack carries only the id it acknowledges.
- e6d2199: The "voice dropped" warning's `dropped` field counts the frames dropped since the previous warning, as the Go SDK's does, rather than since the client was made.
- Updated dependencies [080e352]
- Updated dependencies [de63526]
- Updated dependencies [515eed6]
- Updated dependencies [243db7a]
- Updated dependencies [cde0711]
- Updated dependencies [b60dfff]
- Updated dependencies [9ff18a0]
- Updated dependencies [9000278]
- Updated dependencies [f9e4490]
- Updated dependencies [c9e5790]
- Updated dependencies [cc098a7]
- Updated dependencies [72ef59a]
- Updated dependencies [d91b1cd]
- Updated dependencies [d5f3640]
- Updated dependencies [3f1a4a5]
- Updated dependencies [eba8ac3]
- Updated dependencies [93fe79f]
- Updated dependencies [019f765]
- Updated dependencies [6b68340]
- Updated dependencies [d2a4831]
- Updated dependencies [eb6556e]
- Updated dependencies [426ee5c]
- Updated dependencies [2aad9ea]
- Updated dependencies [7c30135]
  - @honeybbq/teamspeak-core@1.0.0-beta.0
