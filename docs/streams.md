# Streams

TeamSpeak 6 clients can share a screen, a window or a camera. `@honeybbq/teamspeak/stream`
does the signalling of that: it finds the streams of the clients in view, publishes one,
and watches one. The video itself travels between the publisher and each viewer over
WebRTC, which is yours: `Streams` hands you the SDP and the ICE candidates as strings and
takes them back, so any WebRTC stack plugs in, in a browser, in Electron or in Node. The
package has no WebRTC dependency.

TeamSpeak does not document this protocol. It was verified against the TeamSpeak 6 server
6.0.0-beta13.1 and the TeamSpeak 6 client 6.0.0-beta5 (macOS), and a TeamSpeak update may
break it. Streams are used on a server that names `STREAM_P2P` among its extensions
(`client.serverCapabilities.extensions`), as TeamSpeak 6 does. On any other, `publish` and
`watch` throw a `StreamsUnsupportedError` before sending anything: a TeamSpeak 3 server names
no extension and does not answer the stream commands at all.

Every stream this SDK publishes and watches is peer to peer, the one mode a stock server
allows. `StreamInfo.transport` says how a stream's media travels: `"p2p"`, or the server's
number for another mode. `watch` refuses a stream in another mode with a
`StreamTransportUnsupportedError`, before sending anything.

Watching: find a stream in `streams.list()` or wait for `started`, ask to watch it, and
give the publisher's offer to a peer connection. The viewer's connection is receive-only.

```ts
import { Streams } from "@honeybbq/teamspeak/stream";

const streams = new Streams(client);
streams.on("started", (info) => console.log(`${info.name} is streaming`));

const view = await streams.watch(info, { message: "may I watch?" });

const pc = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
pc.ontrack = (event) => (video.srcObject = event.streams[0]);
pc.onicecandidate = (event) => {
  if (event.candidate) void view.sendCandidate(event.candidate.toJSON());
};
// Candidates that arrived with the offer are delivered to the first listener.
view.on("candidate", (candidate) => void pc.addIceCandidate(candidate));
view.on("closed", () => pc.close());

await pc.setRemoteDescription({ type: "offer", sdp: view.offer });
const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);
await view.answer(answer.sdp!);
```

Publishing: the publisher makes the offer, one peer connection for each viewer. The server
relays every request to watch, from any channel, and enforces neither `viewerLimit` nor
`accessibility`: deciding who is let in is the publisher's job, and `request` is emitted
for each one, with nothing accepted for you.

```ts
const stream = await streams.publish({ name: "My screen", source: "screen" });

stream.on("request", async (request) => {
  if (!allowed(request.viewer)) return request.deny("Not today");

  const pc = new RTCPeerConnection({ iceServers });
  for (const track of capture.getTracks()) pc.addTrack(track, capture);
  // Always offer audio, even with no track to send (see the interop notes below).
  if (!pc.getTransceivers().some((t) => t.receiver.track.kind === "audio")) {
    pc.addTransceiver("audio", { direction: "sendonly" });
  }
  await pc.setLocalDescription(await pc.createOffer());

  const viewer = await request.accept(pc.localDescription!.sdp);
  pc.onicecandidate = (event) => {
    if (event.candidate) void viewer.sendCandidate(event.candidate.toJSON());
  };
  viewer.on("answer", (sdp) => pc.setRemoteDescription({ type: "answer", sdp }));
  viewer.on("candidate", (candidate) => void pc.addIceCandidate(candidate));
  viewer.on("closed", () => pc.close());
});

await stream.stop();
```

A request that nobody has answered can end: the viewer withdraws it or goes out of view, or
the stream ends. `request.on("closed", ({ cause }) => …)` fires then, with `"withdrawn"` or
`"ended"`, so a UI can drop the request without polling `request.state`; `accept` and `deny`
then throw. It is not emitted for a request that was accepted or denied.

## Interop with the TeamSpeak 6 client

What follows was observed with the TeamSpeak 6 client 6.0.0-beta5 (macOS) against a
TeamSpeak 6 server 6.0.0-beta13.1.

- **Offer audio, always.** When you publish, the client answers an offer only if it has an
  `m=audio` section. For a video-only offer it never answers: it shows a fallback picture and
  keeps the "Join" button, which then does nothing, because the server already counts the
  viewer as joined. Add a send-only audio transceiver even when there is no audio track; an
  audio section before the video section was accepted. `accept` and `ViewerPeer.sendOffer`
  send an offer without audio unchanged, and emit a `"warning"` event on `Streams` with the
  code `"offer-without-audio"`.
- **Trim the codecs.** The client's own offers carry one video and one audio section, about
  3.9 KB. A browser's offer with every codec is about 6 KB with audio and video, and about
  4.8 KB for video alone, against a limit of about 9.2 KB for a command line. Narrowing the
  codecs keeps room for the candidates and the message:

  ```ts
  const video = pc.addTransceiver(track, { direction: "sendonly" });
  const codecs = RTCRtpSender.getCapabilities("video")!.codecs;
  video.setCodecPreferences(codecs.filter((c) => /^video\/(VP8|H264)$/.test(c.mimeType)));
  ```

- **Accept every request.** A viewer in the client shows "waiting" until the publisher
  answers. When it withdraws and asks again, that is a new request, with a new `JoinRequest`.
- **A channel switch ends the viewing, not the stream.** The client leaves a stream it
  watches when it changes channel, so the publisher sees that viewer leave. The server does not end a stream when its publisher or a viewer changes channel.
- Denying, stopping, leaving, disconnecting and several viewers at once, some of them the
  client and some the SDK, behaved as they do between SDK clients.

```ts
streams.on("warning", (w) => console.warn(`${w.code}: ${w.message}`));
```

Things to know:

- A client may run several streams, so every stream is known by its id. `list()` is what
  this client has heard of. A stream that ends while its publisher is out of the channel is
  reported to nobody there, and stays listed until the connection ends.
- A stream survives its publisher changing channel, with no event. It ends when the
  publisher stops it or disconnects.
- The server drops a command line longer than about 9.2 KB without an answer. Streams
  commands are checked first and throw a `StreamPayloadTooLargeError`; an SDP offer or an
  ICE candidate is a few kilobytes at most.
- The server lets anyone stop any stream. `Streams` sends `stopstream` only for streams it
  published, and treats a `notifystreamstopped` for any stream as final.
- The server remembers no decision, so a client can ask again, and every ask is relayed.
  To refuse for good, pass `rememberDenied: true` (the 1024 most recent uids, in memory
  only; a requester out of view is looked up with `clientgetuidfromclid`), or leave the
  request unanswered. The server has no way to remove a viewer: closing a viewer's peer
  ends your side of it, and stopping the stream ends it for everyone.
- `dispose()` stops the streams published through that `Streams` and leaves the ones it
  watched, while the client is connected. A stream whose `publish` gave up after the command
  went out is stopped when its announcement arrives, so none is left running unseen.
- A client whose `client_is_streaming` clears, or that comes into view not streaming, has
  its streams dropped, after a grace of two seconds: `stopped` with the cause `"gone"`. The
  server clears the flag right before it reports the stop, so a stop that arrives in that time
  ends the stream with its own cause and reason instead, and a flag set again cancels the drop.
- The bitrate the server reports for a stream is not the one requested.
- A client announces that it streams only with `client_is_streaming`, and a stream that was
  running before you came is not announced at all. `Streams` asks for the streams of each
  client that sets the flag, once, on a TeamSpeak 6 server.
