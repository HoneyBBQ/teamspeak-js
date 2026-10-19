import { TeamspeakError } from "@honeybbq/teamspeak";
import type { ClientID, CommandRequest, Unsubscribe } from "@honeybbq/teamspeak";
import { Emitter } from "./emitter.js";
import { ViewerPeerImpl } from "./peer.js";
import type { PeerImpl } from "./peer.js";
import type {
  JoinRequest,
  JoinRequestState,
  PublishedStream,
  PublishedStreamEvents,
  StreamEnded,
  StreamInfo,
  ViewerIdentity,
  ViewerPeer,
} from "./types.js";
import { assertFits, respondRequest, signalRequest } from "./wire.js";

/** What a published stream needs of the `Streams` that made it. */
export interface PublishHost {
  /** The viewer's identity, as far as the client knows it. */
  identity(clientId: ClientID): ViewerIdentity;
  /** Whether a viewer was denied and is to be left unanswered. */
  isDenied(identity: ViewerIdentity): boolean;
  /** Note that a viewer was denied. */
  remember(identity: ViewerIdentity): void;
  /** Send a stream command; a stream the server does not know is a StreamEndedError. */
  send(request: CommandRequest, streamId: string): Promise<void>;
  /** Send `stopstream` for a stream of this client's; a stream already gone is not an error. */
  stop(streamId: string, reason: number): Promise<void>;
  /** What is known of the stream now. */
  info(streamId: string): StreamInfo | undefined;
  /** End the stream here and say so, for `stop()`. */
  stopped(streamId: string, reason: number): void;
}

class JoinRequestImpl implements JoinRequest {
  readonly streamId: string;
  readonly viewer: ViewerIdentity;
  readonly message: string;
  #state: JoinRequestState = "pending";
  readonly #stream: PublishedImpl;

  constructor(stream: PublishedImpl, viewer: ViewerIdentity, message: string) {
    this.#stream = stream;
    this.streamId = stream.id;
    this.viewer = viewer;
    this.message = message;
  }

  get state(): JoinRequestState {
    return this.#state;
  }

  /** The request will not be answered: the viewer withdrew it, or the stream ended. */
  close(state: "withdrawn" | "ended"): void {
    if (this.#state === "pending") this.#state = state;
  }

  #assertPending(): void {
    if (this.#state !== "pending") {
      throw new TeamspeakError(`the request cannot be answered: it is ${this.#state}`);
    }
  }

  async accept(offer: string): Promise<ViewerPeer> {
    if (typeof offer !== "string" || offer === "") {
      throw new RangeError("the offer must be a non-empty SDP string");
    }
    this.#assertPending();
    const request = respondRequest(this.streamId, this.viewer.clientId, "", offer, true);
    // Before the request is used up: a too long offer may be shortened and tried again.
    assertFits(request);
    this.#state = "accepted";
    // Made before the offer goes out: the viewer answers, and the publisher's
    // side starts sending candidates, as soon as it has the offer, and what
    // arrives before this returns waits in the peer for its first listener.
    const peer = this.#stream.openViewer(this.viewer.clientId);
    try {
      await this.#stream.host.send(request, this.streamId);
    } catch (error) {
      this.#state = "failed";
      peer.end({ cause: "closed" });
      throw error;
    }
    return peer;
  }

  async deny(reason = ""): Promise<void> {
    this.#assertPending();
    const request = respondRequest(this.streamId, this.viewer.clientId, reason, "", false);
    assertFits(request);
    this.#state = "denied";
    try {
      await this.#stream.host.send(request, this.streamId);
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
    this.#stream.host.remember(this.viewer);
  }
}

/** A stream this client publishes. */
export class PublishedImpl implements PublishedStream {
  readonly id: string;
  readonly host: PublishHost;
  #initial: StreamInfo;
  #ended = false;
  #emitter = new Emitter<PublishedStreamEvents>(["request", "ended"]);
  #peers = new Map<ClientID, ViewerPeerImpl>();
  #pending = new Map<ClientID, JoinRequestImpl>();

  constructor(info: StreamInfo, host: PublishHost) {
    this.id = info.id;
    this.host = host;
    this.#initial = info;
  }

  get info(): StreamInfo {
    return this.host.info(this.id) ?? this.#initial;
  }

  get ended(): boolean {
    return this.#ended;
  }

  on<K extends keyof PublishedStreamEvents>(
    event: K,
    listener: (payload: PublishedStreamEvents[K]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, listener);
  }

  viewers(): readonly ViewerPeer[] {
    return [...this.#peers.values()];
  }

  async stop(reason = 0): Promise<void> {
    if (!Number.isSafeInteger(reason) || reason < 0 || reason > 0xffff_ffff) {
      throw new RangeError("the stop reason must be an integer from 0 to 4294967295");
    }
    if (this.#ended) return;
    await this.host.stop(this.id, reason);
    this.host.stopped(this.id, reason);
  }

  /** The peer for a viewer this stream let in. */
  openViewer(clientId: ClientID): ViewerPeerImpl {
    const peer = new ViewerPeerImpl(this.id, clientId, {
      sendJson: (json) => this.host.send(signalRequest(this.id, clientId, json), this.id),
      closed: (closing: PeerImpl) => {
        if (this.#peers.get(clientId) === closing) this.#peers.delete(clientId);
      },
    });
    this.#peers.set(clientId, peer);
    return peer;
  }

  /** A viewer asked to watch. */
  request(clientId: ClientID, message: string): void {
    // Asking again while pending or let in is no new request.
    if (this.#ended || this.#peers.has(clientId)) return;
    if (this.#pending.get(clientId)?.state === "pending") return;
    const viewer = this.host.identity(clientId);
    if (this.host.isDenied(viewer)) return;
    const request = new JoinRequestImpl(this, viewer, message);
    this.#pending.set(clientId, request);
    this.#emitter.emit("request", request);
  }

  /** A viewer is gone, by saying so or by disconnecting. */
  viewerGone(clientId: ClientID): void {
    this.#pending.get(clientId)?.close("withdrawn");
    this.#pending.delete(clientId);
    this.#peers.get(clientId)?.end({ cause: "left" });
  }

  /** A signalling JSON from a viewer; false when this stream has no such viewer. */
  signal(clientId: ClientID, json: string): boolean {
    const peer = this.#peers.get(clientId);
    if (peer === undefined) return false;
    peer.deliver(json);
    return true;
  }

  /** The stream is over: close everything that hangs on it, once. */
  finish(ended: StreamEnded): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const request of this.#pending.values()) request.close("ended");
    this.#pending.clear();
    const cause =
      ended.cause === "disconnected" || ended.cause === "disposed" ? ended.cause : "stopped";
    for (const peer of this.#peers.values()) {
      peer.end({ cause, ...(cause === "stopped" ? { reason: ended.reason } : {}) });
    }
    this.#emitter.emit("ended", ended);
  }
}
