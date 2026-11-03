import type {
  ClientEnterEvent,
  ClientEntry,
  ClientID,
  ClientLeaveEvent,
  ClientStatus,
  ClientUpdatedEvent,
  CommandExecutor,
  DisconnectedEvent,
  NotificationEvent,
  ServerFamily,
  UID,
  Unsubscribe,
} from "@honeybbq/teamspeak";

// ---- The client Streams attaches to -----------------------------------------

/**
 * What `Streams` needs of a client: a voice `Client` is one, and so is a test
 * double with these members.
 */
export interface StreamsClient extends CommandExecutor {
  /** Where the client is in its connection's life. */
  readonly status: ClientStatus;
  /** This client's id on the server. */
  readonly clientID: ClientID;
  /**
   * What the connected server is. Streams need `extensions` to name
   * `"STREAM_P2P"`; `family` and `version` are reported when it does not.
   */
  readonly serverCapabilities: {
    readonly family: ServerFamily;
    readonly version: string;
    readonly extensions: readonly string[];
  };
  /** The clients the client knows of, which `Streams` reads for those that stream. */
  readonly view: {
    readonly clients: ReadonlyMap<ClientID, ClientEntry>;
    client(id: ClientID): ClientEntry | undefined;
  };
  /** Every notification the server sends. */
  on(event: "notification", listener: (event: NotificationEvent) => void): Unsubscribe;
  /** A client coming into view. */
  on(event: "clientEnter", listener: (event: ClientEnterEvent) => void): Unsubscribe;
  /** A client's properties changing. */
  on(event: "clientUpdated", listener: (event: ClientUpdatedEvent) => void): Unsubscribe;
  /** A client going out of view. */
  on(event: "clientLeave", listener: (event: ClientLeaveEvent) => void): Unsubscribe;
  /** The connection ending. */
  on(event: "disconnected", listener: (event: DisconnectedEvent) => void): Unsubscribe;
}

// ---- Values -----------------------------------------------------------------

/** The values of the table below, before freezing. */
const streamSourceValues = {
  /** `0` on the wire: no source named. */
  None: "none",
  /** `1` on the wire: a camera. */
  Camera: "camera",
  /** `2` on the wire: a screen. */
  Screen: "screen",
  /** `3` on the wire: a window. */
  Window: "window",
  /** `4` on the wire. */
  Session: "session",
} as const;
/**
 * What a stream shows. The server stores any number, so a stream from a client
 * that sends another value reports it as the number.
 */
export const StreamSource: typeof streamSourceValues =
  /* @__PURE__ */ Object.freeze(streamSourceValues);
/**
 * One of {@link StreamSource}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type StreamSource = (typeof StreamSource)[keyof typeof StreamSource];

/** The values of the table below, before freezing. */
const streamAccessibilityValues = {
  /** `0` on the wire. */
  None: "none",
  /** `1` on the wire: anyone. What `publish` sends unless told otherwise. */
  Public: "public",
  /** `2` on the wire: the publisher's contacts. */
  Contacts: "contacts",
  /** `3` on the wire. */
  Private: "private",
} as const;
/**
 * Who a stream says may watch it. Only the publisher enforces it: the server
 * relays every request. A value outside the four is reported as the number.
 */
export const StreamAccessibility: typeof streamAccessibilityValues =
  /* @__PURE__ */ Object.freeze(streamAccessibilityValues);
/**
 * One of {@link StreamAccessibility}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type StreamAccessibility = (typeof StreamAccessibility)[keyof typeof StreamAccessibility];

/** The values of the table below, before freezing. */
const streamTransportValues = {
  /** From the publisher to each viewer directly. */
  P2P: "p2p",
} as const;
/**
 * How a stream's media travels: `"p2p"`, from the publisher to each viewer
 * directly, is the one mode this SDK publishes and watches. A server may
 * announce a stream in another mode; it is reported as the number, and
 * `watch` refuses it.
 */
export const StreamTransport: typeof streamTransportValues =
  /* @__PURE__ */ Object.freeze(streamTransportValues);
/**
 * One of {@link StreamTransport}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type StreamTransport = (typeof StreamTransport)[keyof typeof StreamTransport];

/**
 * A stream, as the server describes it.
 */
export interface StreamInfo {
  /** The stream's id, assigned by the server. */
  readonly id: string;
  /** The client that publishes it. */
  readonly clientId: ClientID;
  /** The stream's name. */
  readonly name: string;
  /** What it shows; a number the SDK has no name for is passed through. */
  readonly source?: StreamSource | number | undefined;
  /** Whether it carries an audio track. */
  readonly audio: boolean;
  /**
   * The bitrate the server reports, in bits per second. It is not the one
   * requested: the server substitutes its own figure, and the real limit is
   * the sender's own encoder setting.
   */
  readonly bitrate?: number | undefined;
  /** Who it says may watch; a number the SDK has no name for is passed through. */
  readonly accessibility?: StreamAccessibility | number | undefined;
  /**
   * How its media travels (`mode`); a number the SDK has no name for is
   * passed through. `undefined` when the server has not said.
   */
  readonly transport?: StreamTransport | number | undefined;
  /** The viewer limit the publisher set; 0 is none. The server does not enforce it. */
  readonly viewerLimit?: number | undefined;
  /**
   * How many clients had asked to watch, pending requests included, when the
   * server last answered `requeststreaminfo` for it. Nothing updates it.
   */
  readonly viewers?: number | undefined;
}

/**
 * An ICE candidate, in the shape of the browser's `RTCIceCandidateInit`, so one
 * passes to `addIceCandidate` as it is.
 */
export interface IceCandidate {
  /** The candidate line, such as `candidate:1 1 udp 2122260223 …`. */
  readonly candidate: string;
  /** The media section's id. */
  readonly sdpMid: string | null;
  /** The media section's index. */
  readonly sdpMLineIndex: number | null;
}

/**
 * A signalling message the SDK has no name for, or that was not shaped as the
 * ones it has: handed over rather than dropped.
 */
export interface RawSignal {
  /** The message's `cmd`; empty when the JSON had none. */
  readonly cmd: string;
  /**
   * Its `args`, parsed. Untrusted: the server relays the JSON unseen, so this
   * is whatever the other client sent, of any shape. Undefined when the JSON
   * could not be parsed or had none.
   */
  readonly args: unknown;
  /** The JSON text as it arrived. */
  readonly json: string;
}

// ---- Peers ------------------------------------------------------------------

/** The values of the table below, before freezing. */
const peerCloseCauseValues = {
  /** Its own `close()`. */
  Closed: "closed",
  /** The other end leaving. */
  Left: "left",
  /** The stream ending. */
  Stopped: "stopped",
  /** The client's connection ending. */
  Disconnected: "disconnected",
  /** `Streams.dispose()`. */
  Disposed: "disposed",
} as const;
/**
 * Why a peer closed.
 */
export const PeerCloseCause: typeof peerCloseCauseValues =
  /* @__PURE__ */ Object.freeze(peerCloseCauseValues);
/**
 * One of {@link PeerCloseCause}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type PeerCloseCause = (typeof PeerCloseCause)[keyof typeof PeerCloseCause];

/**
 * A peer closing.
 */
export interface PeerClosed {
  /** Why it closed. */
  readonly cause: PeerCloseCause;
  /** The stop reason the server reported, for `"stopped"`; otherwise undefined. */
  readonly reason?: number | undefined;
}

/**
 * The events of a peer. An event that happens before a listener for it has
 * been added is kept and delivered to the first listener, so nothing is lost
 * in the time between receiving a peer and attaching to it.
 */
export interface PeerEvents {
  /** A renegotiation offer from the publisher: an SDP. */
  offer: string;
  /** The viewer's SDP answer. */
  answer: string;
  /** An ICE candidate from the other end. */
  candidate: IceCandidate;
  /** A signalling message that is none of the above. */
  signal: RawSignal;
  /** The peer closing. */
  closed: PeerClosed;
}

/** The values of the table below, before freezing. */
const peerEventNameValues = {
  /** A renegotiation offer from the publisher: an SDP. */
  Offer: "offer",
  /** The viewer's SDP answer. */
  Answer: "answer",
  /** An ICE candidate from the other end. */
  Candidate: "candidate",
  /** A signalling message that is none of the above. */
  Signal: "signal",
  /** The peer closing. */
  Closed: "closed",
} as const;
/**
 * The names of the events `Peer.on()` takes, as constants.
 * `on(PeerEventName.Offer, ...)` and `on("offer", ...)` are the same call,
 * and both give the listener the same payload type.
 */
export const PeerEventName: typeof peerEventNameValues =
  /* @__PURE__ */ Object.freeze(peerEventNameValues);
/**
 * One of {@link PeerEventName}, and so a key of {@link PeerEvents}.
 * May gain members in a minor release: a `switch` over it needs a default
 * case.
 */
export type PeerEventName = (typeof PeerEventName)[keyof typeof PeerEventName];

// Each direction fails to compile when `PeerEvents` and `PeerEventName`
// drift: an event without a name, and a name that is not an event.
const peerEventNameCoverEvents: [Exclude<keyof PeerEvents, PeerEventName>] extends [never]
  ? true
  : never = true;
const peerEventNameNamesAreEvents: [Exclude<PeerEventName, keyof PeerEvents>] extends [never]
  ? true
  : never = true;
void peerEventNameCoverEvents;
void peerEventNameNamesAreEvents;

/**
 * One end of a stream's signalling with one other client. SDP and ICE are
 * opaque strings here: any WebRTC stack can be plugged in.
 */
export interface Peer {
  /** The stream. */
  readonly streamId: string;
  /** The client at the other end. */
  readonly clientId: ClientID;
  /** Whether the peer has closed. */
  readonly closed: boolean;
  /** Listen for an event; returns a function that removes the listener. */
  on<K extends keyof PeerEvents>(event: K, listener: (payload: PeerEvents[K]) => void): Unsubscribe;
  /** Send an ICE candidate. */
  sendCandidate(candidate: IceCandidate): Promise<void>;
  /**
   * Send a signalling message the SDK has no method for, as `{"cmd":…,"args":…}`.
   * The server relays it unseen, and a receiver that does not understand the
   * shape drops it without a word.
   */
  sendSignal(cmd: string, args: unknown): Promise<void>;
  /**
   * Stop sending and delivering for this peer. On a viewer's side this also
   * leaves the stream. The publisher's side sends nothing: the server has no
   * way to remove a viewer, so a viewer closed here stays a participant on the
   * server and may keep signalling, which is ignored, and may ask again, which
   * is a new request. Stop the stream to end it for everyone.
   */
  close(): Promise<void>;
}

/**
 * The publisher's end for one accepted viewer.
 */
export interface ViewerPeer extends Peer {
  /**
   * Send an SDP offer, to renegotiate. The first offer goes with
   * `JoinRequest.accept`. The server relays the message unseen, and whether a
   * viewer takes it is up to the viewer: renegotiation has not been tried.
   */
  sendOffer(sdp: string): Promise<void>;
}

/**
 * The viewer's end of a stream it was let into.
 */
export interface StreamView extends Peer {
  /** The publisher's SDP offer. */
  readonly offer: string;
  /** Send the SDP answer to the offer. */
  answer(sdp: string): Promise<void>;
  /** Leave the stream: the same as `close()`. */
  leave(): Promise<void>;
}

// ---- Publishing -------------------------------------------------------------

/**
 * Who asked to watch.
 */
export interface ViewerIdentity {
  /** The client's id. */
  readonly clientId: ClientID;
  /** Its unique identifier, when the client is in view. */
  readonly uid: UID | undefined;
  /** Its nickname, when the client is in view. */
  readonly nickname: string | undefined;
}

/** The values of the table below, before freezing. */
const joinRequestStateValues = {
  /** Not yet accepted or denied. */
  Pending: "pending",
  /** Accepted. */
  Accepted: "accepted",
  /** Denied. */
  Denied: "denied",
  /** The answer did not reach the server. */
  Failed: "failed",
  /** The viewer left first. */
  Withdrawn: "withdrawn",
  /** The stream stopped. */
  Ended: "ended",
} as const;
/**
 * Where a join request stands.
 */
export const JoinRequestState: typeof joinRequestStateValues =
  /* @__PURE__ */ Object.freeze(joinRequestStateValues);
/**
 * One of {@link JoinRequestState}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type JoinRequestState = (typeof JoinRequestState)[keyof typeof JoinRequestState];

/** The values of the table below, before freezing. */
const joinRequestCloseCauseValues = {
  /** The viewer took it back or left view. */
  Withdrawn: "withdrawn",
  /** The stream ended first. */
  Ended: "ended",
} as const;
/**
 * Why a request stopped waiting for an answer.
 */
export const JoinRequestCloseCause: typeof joinRequestCloseCauseValues =
  /* @__PURE__ */ Object.freeze(joinRequestCloseCauseValues);
/**
 * One of {@link JoinRequestCloseCause}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type JoinRequestCloseCause =
  (typeof JoinRequestCloseCause)[keyof typeof JoinRequestCloseCause];

/**
 * A pending join request closing without an answer.
 */
export interface JoinRequestClosed {
  /** Why it closed. */
  readonly cause: JoinRequestCloseCause;
}

/**
 * The events of a join request. As for a peer, one that happens before a
 * listener is added is delivered to the first.
 */
export interface JoinRequestEvents {
  /**
   * A request nobody had answered closing: the viewer withdrew it or left view,
   * or the stream ended. It is emitted once, and never for a request that was
   * accepted or denied, nor when `accept` or `deny` themselves are called. From
   * then on `accept` and `deny` throw.
   */
  closed: JoinRequestClosed;
}

/** The values of the table below, before freezing. */
const joinRequestEventNameValues = {
  /**
   * A request nobody had answered closing: the viewer withdrew it or left
   * view, or the stream ended.
   */
  Closed: "closed",
} as const;
/**
 * The names of the events `JoinRequest.on()` takes, as constants.
 * `on(JoinRequestEventName.Closed, ...)` and `on("closed", ...)` are the same call,
 * and both give the listener the same payload type.
 */
export const JoinRequestEventName: typeof joinRequestEventNameValues =
  /* @__PURE__ */ Object.freeze(joinRequestEventNameValues);
/**
 * One of {@link JoinRequestEventName}, and so a key of {@link JoinRequestEvents}.
 * May gain members in a minor release: a `switch` over it needs a default
 * case.
 */
export type JoinRequestEventName = (typeof JoinRequestEventName)[keyof typeof JoinRequestEventName];

// Each direction fails to compile when `JoinRequestEvents` and `JoinRequestEventName`
// drift: an event without a name, and a name that is not an event.
const joinRequestEventNameCoverEvents: [
  Exclude<keyof JoinRequestEvents, JoinRequestEventName>,
] extends [never]
  ? true
  : never = true;
const joinRequestEventNameNamesAreEvents: [
  Exclude<JoinRequestEventName, keyof JoinRequestEvents>,
] extends [never]
  ? true
  : never = true;
void joinRequestEventNameCoverEvents;
void joinRequestEventNameNamesAreEvents;

/**
 * A client asking to watch a stream this client publishes. The server relays
 * every request, from any channel, and enforces neither `viewerLimit` nor
 * `accessibility`: deciding is the publisher's job, and nothing is accepted
 * for it. A request is answered once.
 */
export interface JoinRequest {
  /** The stream asked for. */
  readonly streamId: string;
  /** Who asked. */
  readonly viewer: ViewerIdentity;
  /** The message that came with the request; may be empty. */
  readonly message: string;
  /** Where the request stands. */
  readonly state: JoinRequestState;
  /** Listen for an event; returns a function that removes the listener. */
  on<K extends keyof JoinRequestEvents>(
    event: K,
    listener: (payload: JoinRequestEvents[K]) => void,
  ): Unsubscribe;
  /**
   * Let the viewer in, with the SDP offer it will answer and, optionally, a
   * message that goes with it. Resolves with the peer once the server took
   * the answer. Throws if the request was answered
   * or is no longer pending, and with a `StreamPayloadTooLargeError`, before
   * sending and without using the request up, when the offer is too long.
   * An offer with no `m=audio` section is sent as it is, with a
   * `"offer-without-audio"` warning on `Streams`.
   */
  accept(offer: string, message?: string): Promise<ViewerPeer>;
  /**
   * Refuse, with a reason the viewer sees. The server forgets a refusal, so the
   * viewer may ask again; with `rememberDenied`, requests from this client's
   * unique identifier are then left unanswered.
   */
  deny(reason?: string): Promise<void>;
}

/** The values of the table below, before freezing. */
const streamEndCauseValues = {
  /** `stop()`. */
  Stopped: "stopped",
  /** The server's `notifystreamstopped`. */
  Server: "server",
  /**
   * The server said its publisher no longer streams (`client_is_streaming`
   * cleared) and no stop followed within two seconds.
   */
  Gone: "gone",
  /** The client's connection ending. */
  Disconnected: "disconnected",
  /** `Streams.dispose()`. */
  Disposed: "disposed",
} as const;
/**
 * Why a published stream ended.
 */
export const StreamEndCause: typeof streamEndCauseValues =
  /* @__PURE__ */ Object.freeze(streamEndCauseValues);
/**
 * One of {@link StreamEndCause}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type StreamEndCause = (typeof StreamEndCause)[keyof typeof StreamEndCause];

/**
 * A published stream ending.
 */
export interface StreamEnded {
  /** Why it ended. Always set: a `reason` of 0 alone does not say. */
  readonly cause: StreamEndCause;
  /**
   * The numeric reason: the one `stop()` was given, or the server's. The
   * server reported 1 when the publisher's connection ended. 0 for the causes
   * `"gone"`, `"disconnected"` and `"disposed"`, which carry none.
   */
  readonly reason: number;
}

/**
 * The events of a published stream. As for a peer, one that happens before a
 * listener is added is delivered to the first.
 */
export interface PublishedStreamEvents {
  /** A client asking to watch. */
  request: JoinRequest;
  /** The stream ending. */
  ended: StreamEnded;
}

/** The values of the table below, before freezing. */
const publishedStreamEventNameValues = {
  /** A client asking to watch. */
  Request: "request",
  /** The stream ending. */
  Ended: "ended",
} as const;
/**
 * The names of the events `PublishedStream.on()` takes, as constants.
 * `on(PublishedStreamEventName.Request, ...)` and `on("request", ...)` are the same call,
 * and both give the listener the same payload type.
 */
export const PublishedStreamEventName: typeof publishedStreamEventNameValues =
  /* @__PURE__ */ Object.freeze(publishedStreamEventNameValues);
/**
 * One of {@link PublishedStreamEventName}, and so a key of {@link PublishedStreamEvents}.
 * May gain members in a minor release: a `switch` over it needs a default
 * case.
 */
export type PublishedStreamEventName =
  (typeof PublishedStreamEventName)[keyof typeof PublishedStreamEventName];

// Each direction fails to compile when `PublishedStreamEvents` and `PublishedStreamEventName`
// drift: an event without a name, and a name that is not an event.
const publishedStreamEventNameCoverEvents: [
  Exclude<keyof PublishedStreamEvents, PublishedStreamEventName>,
] extends [never]
  ? true
  : never = true;
const publishedStreamEventNameNamesAreEvents: [
  Exclude<PublishedStreamEventName, keyof PublishedStreamEvents>,
] extends [never]
  ? true
  : never = true;
void publishedStreamEventNameCoverEvents;
void publishedStreamEventNameNamesAreEvents;

/**
 * A stream this client publishes.
 */
export interface PublishedStream {
  /** The stream's id. */
  readonly id: string;
  /** What is known of the stream now. */
  readonly info: StreamInfo;
  /** Whether it has ended. */
  readonly ended: boolean;
  /** Listen for an event; returns a function that removes the listener. */
  on<K extends keyof PublishedStreamEvents>(
    event: K,
    listener: (payload: PublishedStreamEvents[K]) => void,
  ): Unsubscribe;
  /** The viewers let in and still there. */
  viewers(): readonly ViewerPeer[];
  /**
   * Stop the stream, for everyone. `reason` is an integer the server passes to
   * the viewers (0 by default); it stores 0 for anything else. Resolves once the
   * server took the command, with the stream ended here too: the server tells
   * the one who stopped nothing. A stream the server no longer knows counts as
   * stopped.
   */
  stop(reason?: number): Promise<void>;
}

/**
 * How `Streams.publish` starts a stream.
 */
export interface PublishOptions {
  /** The stream's name. */
  readonly name: string;
  /** What it shows. Default `"screen"`. */
  readonly source?: StreamSource | undefined;
  /** Whether it carries an audio track. Default false. */
  readonly audio?: boolean | undefined;
  /**
   * The bitrate to announce, in bits per second. Default 1,500,000. Only an
   * announcement: the server reports a figure of its own, and the encoder's
   * setting is what limits the stream.
   */
  readonly bitrate?: number | undefined;
  /** Who it says may watch. Default `"public"`. Not enforced by the server. */
  readonly accessibility?: StreamAccessibility | undefined;
  /** The viewer limit to announce, 0 to 65535; 0 is none. Not enforced by the server. */
  readonly viewerLimit?: number | undefined;
  /** Abandons the wait for the server to announce the stream. */
  readonly signal?: AbortSignal | undefined;
  /** How long to wait for the announcement, in milliseconds. Default 10,000. */
  readonly timeoutMs?: number | undefined;
}

/**
 * How `Streams.watch` asks to watch.
 */
export interface WatchOptions {
  /** A message for the publisher, shown with the request. */
  readonly message?: string | undefined;
  /** Abandons the wait; the request is then withdrawn. */
  readonly signal?: AbortSignal | undefined;
  /** How long to wait for the publisher to decide, in milliseconds. Default 60,000. */
  readonly timeoutMs?: number | undefined;
}

// ---- Streams ----------------------------------------------------------------

/**
 * How a `Streams` behaves.
 */
export interface StreamsOptions {
  /**
   * Remember the unique identifiers of the clients `deny` refused, and leave
   * their later requests unanswered. Off by default. The server remembers no
   * decision, so a client can ask again, and every ask is relayed. The
   * identifiers are held in memory only, the 1024 most recent, and dropped by
   * `dispose()`. A requester whose identifier cannot be found out is not
   * remembered.
   */
  readonly rememberDenied?: boolean | undefined;
}

/**
 * A stream ending, as `Streams` reports it.
 */
export interface StreamStoppedEvent {
  /** The stream, as it was last known. */
  readonly info: StreamInfo;
  /**
   * Why it ended: `"server"` for a `notifystreamstopped`, `"stopped"` for a
   * stream this client stopped, `"gone"` when its publisher's
   * `client_is_streaming` cleared or the publisher came into view not
   * streaming, without a stop reaching this client.
   */
  readonly cause:
    | typeof StreamEndCause.Server
    | typeof StreamEndCause.Stopped
    | typeof StreamEndCause.Gone;
  /** The stop reason the server reported; 0 unless the stopper gave one, and for `"gone"`. */
  readonly reason: number;
}

/**
 * A viewer joining or leaving a stream, as the server tells the owner, the
 * other viewers and, for a join, the clients of the owner's channel.
 */
export interface StreamViewerEvent {
  /** The stream. */
  readonly info: StreamInfo;
  /** The viewer. */
  readonly clientId: ClientID;
}

/** The values of the table below, before freezing. */
const streamWarningCodeValues = {
  /** An SDP offer with no `m=audio` section. */
  OfferWithoutAudio: "offer-without-audio",
} as const;
/**
 * Why `Streams` warns.
 */
export const StreamWarningCode: typeof streamWarningCodeValues =
  /* @__PURE__ */ Object.freeze(streamWarningCodeValues);
/**
 * One of {@link StreamWarningCode}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type StreamWarningCode = (typeof StreamWarningCode)[keyof typeof StreamWarningCode];

/**
 * Something the SDK noticed and did not stop: the offer or message goes out
 * unchanged.
 */
export interface StreamWarning {
  /** What was noticed. */
  readonly code: StreamWarningCode;
  /** The stream. */
  readonly streamId: string;
  /** The viewer the offer was for. */
  readonly clientId: ClientID;
  /** A sentence saying what and why. */
  readonly message: string;
}

/**
 * The events of `Streams`.
 */
export interface StreamsEventMap {
  /**
   * A stream becoming known: it started while this client could see it, or
   * discovery found it.
   */
  started: StreamInfo;
  /** What is known of a stream changing. */
  updated: StreamInfo;
  /** A stream ending. */
  stopped: StreamStoppedEvent;
  /** A viewer being accepted into a stream. */
  viewerJoined: StreamViewerEvent;
  /** A viewer leaving a stream. */
  viewerLeft: StreamViewerEvent;
  /** A failure nobody awaits, such as a discovery request the server refused. */
  error: Error;
  /**
   * Something the SDK noticed and let through, such as an offer the TeamSpeak 6
   * client will not answer. Kept for the first listener, as errors are.
   */
  warning: StreamWarning;
}

/** The values of the table below, before freezing. */
const streamsEventNameValues = {
  /**
   * A stream becoming known: it started while this client could see it, or
   * discovery found it.
   */
  Started: "started",
  /** What is known of a stream changing. */
  Updated: "updated",
  /** A stream ending. */
  Stopped: "stopped",
  /** A viewer being accepted into a stream. */
  ViewerJoined: "viewerJoined",
  /** A viewer leaving a stream. */
  ViewerLeft: "viewerLeft",
  /** A failure nobody awaits, such as a discovery request the server refused. */
  Error: "error",
  /**
   * Something the SDK noticed and let through, such as an offer the
   * TeamSpeak 6 client will not answer.
   */
  Warning: "warning",
} as const;
/**
 * The names of the events `Streams.on()` takes, as constants.
 * `on(StreamsEventName.Started, ...)` and `on("started", ...)` are the same call,
 * and both give the listener the same payload type.
 */
export const StreamsEventName: typeof streamsEventNameValues =
  /* @__PURE__ */ Object.freeze(streamsEventNameValues);
/**
 * One of {@link StreamsEventName}, and so a key of {@link StreamsEventMap}.
 * May gain members in a minor release: a `switch` over it needs a default
 * case.
 */
export type StreamsEventName = (typeof StreamsEventName)[keyof typeof StreamsEventName];

// Each direction fails to compile when `StreamsEventMap` and `StreamsEventName`
// drift: an event without a name, and a name that is not an event.
const streamsEventNameCoverEvents: [Exclude<keyof StreamsEventMap, StreamsEventName>] extends [
  never,
]
  ? true
  : never = true;
const streamsEventNameNamesAreEvents: [Exclude<StreamsEventName, keyof StreamsEventMap>] extends [
  never,
]
  ? true
  : never = true;
void streamsEventNameCoverEvents;
void streamsEventNameNamesAreEvents;
