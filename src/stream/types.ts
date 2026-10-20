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
 *
 * @beta
 */
export interface StreamsClient extends CommandExecutor {
  /** Where the client is in its connection's life. */
  readonly status: ClientStatus;
  /** This client's id on the server. */
  readonly clientID: ClientID;
  /** What the connected server is; streams need `family` to be `"ts6"`. */
  readonly serverCapabilities: { readonly family: ServerFamily; readonly version: string };
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

/**
 * What a stream shows. The server stores any number, so a stream from a client
 * that sends another value reports it as the number.
 *
 * @beta
 */
export type StreamSource = "none" | "camera" | "screen" | "window" | "session";

/**
 * Who a stream says may watch it. Only the publisher enforces it: the server
 * relays every request. A value outside the four is reported as the number.
 *
 * @beta
 */
export type StreamAccessibility = "none" | "public" | "contacts" | "private";

/**
 * A stream, as the server describes it.
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
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

/**
 * Why a peer closed: `"closed"` for its own `close()`, `"left"` for the other
 * end leaving, `"stopped"` for the stream ending, `"disconnected"` for the
 * client's connection ending and `"disposed"` for `Streams.dispose()`.
 *
 * @beta
 */
export type PeerCloseCause = "closed" | "left" | "stopped" | "disconnected" | "disposed";

/**
 * A peer closing.
 *
 * @beta
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
 *
 * @beta
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

/**
 * One end of a stream's signalling with one other client. SDP and ICE are
 * opaque strings here: any WebRTC stack can be plugged in.
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
 */
export interface ViewerIdentity {
  /** The client's id. */
  readonly clientId: ClientID;
  /** Its unique identifier, when the client is in view. */
  readonly uid: UID | undefined;
  /** Its nickname, when the client is in view. */
  readonly nickname: string | undefined;
}

/**
 * Where a join request stands: `"pending"` until it is accepted or denied,
 * `"failed"` when the answer did not reach the server, `"withdrawn"` when the
 * viewer left first and `"ended"` when the stream stopped.
 *
 * @beta
 */
export type JoinRequestState = "pending" | "accepted" | "denied" | "failed" | "withdrawn" | "ended";

/**
 * A client asking to watch a stream this client publishes. The server relays
 * every request, from any channel, and enforces neither `viewerLimit` nor
 * `accessibility`: deciding is the publisher's job, and nothing is accepted
 * for it. A request is answered once.
 *
 * @beta
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
  /**
   * Let the viewer in, with the SDP offer it will answer and, optionally, a
   * message that goes with it. Resolves with the peer once the server took
   * the answer. Throws if the request was answered
   * or is no longer pending, and with a `StreamPayloadTooLargeError`, before
   * sending and without using the request up, when the offer is too long.
   */
  accept(offer: string, message?: string): Promise<ViewerPeer>;
  /**
   * Refuse, with a reason the viewer sees. The server forgets a refusal, so the
   * viewer may ask again; with `rememberDenied`, requests from this client's
   * unique identifier are then left unanswered.
   */
  deny(reason?: string): Promise<void>;
}

/**
 * Why a published stream ended: `"stopped"` for `stop()`, `"server"` for the
 * server's `notifystreamstopped`, `"gone"` when the server said its publisher
 * no longer streams (`client_is_streaming` cleared) and no stop followed within
 * two seconds, and
 * `"disconnected"` and `"disposed"` as for a peer.
 *
 * @beta
 */
export type StreamEndCause = "stopped" | "server" | "gone" | "disconnected" | "disposed";

/**
 * A published stream ending.
 *
 * @beta
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
 *
 * @beta
 */
export interface PublishedStreamEvents {
  /** A client asking to watch. */
  request: JoinRequest;
  /** The stream ending. */
  ended: StreamEnded;
}

/**
 * A stream this client publishes.
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
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
 *
 * @beta
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
  readonly cause: "server" | "stopped" | "gone";
  /** The stop reason the server reported; 0 unless the stopper gave one, and for `"gone"`. */
  readonly reason: number;
}

/**
 * A viewer joining or leaving a stream, as the server tells the owner, the
 * other viewers and, for a join, the clients of the owner's channel.
 *
 * @beta
 */
export interface StreamViewerEvent {
  /** The stream. */
  readonly info: StreamInfo;
  /** The viewer. */
  readonly clientId: ClientID;
}

/**
 * The events of `Streams`.
 *
 * @beta
 */
export interface StreamsEventMap {
  /** A stream becoming known: it started while this client could see it, or discovery found it. */
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
}
