/**
 * TeamSpeak 6 streams, the screen share: finding the streams of the clients in
 * view, publishing one, and watching one.
 *
 * TeamSpeak does not document the protocol, and it has been measured against
 * TeamSpeak 6 6.0.0-beta13.1 and not yet against the native client, so
 * everything here is `@beta` and may change in a minor release.
 *
 * Only the signalling is in this package. The video itself travels over WebRTC
 * between the publisher and each viewer, which the application brings: SDP and
 * ICE candidates are strings here, handed to and taken from any WebRTC stack.
 * There is no WebRTC dependency.
 *
 * ```ts
 * import { Streams } from "@honeybbq/teamspeak/stream";
 *
 * const streams = new Streams(client);
 * const view = await streams.watch(streamId);
 * ```
 *
 * @module @honeybbq/teamspeak/stream
 * @beta
 */

export { Streams } from "./streams.js";
export {
  StreamEndedError,
  StreamJoinDeniedError,
  StreamPayloadTooLargeError,
  StreamsUnsupportedError,
} from "./errors.js";
export type {
  IceCandidate,
  JoinRequest,
  JoinRequestState,
  Peer,
  PeerClosed,
  PeerCloseCause,
  PeerEvents,
  PublishedStream,
  PublishedStreamEvents,
  PublishOptions,
  RawSignal,
  StreamAccessibility,
  StreamEnded,
  StreamEndCause,
  StreamInfo,
  StreamsClient,
  StreamsEventMap,
  StreamsOptions,
  StreamSource,
  StreamStoppedEvent,
  StreamView,
  StreamViewerEvent,
  ViewerIdentity,
  ViewerPeer,
  WatchOptions,
} from "./types.js";
