import { TeamspeakError } from "@honeybbq/teamspeak";
import type { ClientID, Unsubscribe } from "@honeybbq/teamspeak";
import { Emitter } from "./emitter.js";
import type {
  IceCandidate,
  Peer,
  PeerClosed,
  PeerEvents,
  StreamView,
  ViewerPeer,
} from "./types.js";
import { answerJson, candidateJson, encodeSignal, offerJson, parseSignal } from "./wire.js";

/** What a peer needs of the `Streams` that made it. */
export interface PeerLink {
  /** Send a signalling JSON to the other end. */
  sendJson(json: string): Promise<void>;
  /** Tell the server this end is leaving; absent where there is nothing to tell. */
  leave?(): Promise<void>;
  /** The peer closed, whoever closed it. */
  closed(peer: PeerImpl): void;
}

/** One end of a stream's signalling with one other client. */
export class PeerImpl implements Peer {
  readonly streamId: string;
  readonly clientId: ClientID;
  #link: PeerLink;
  #closed = false;
  #emitter = new Emitter<PeerEvents>(["offer", "answer", "candidate", "signal", "closed"]);

  constructor(streamId: string, clientId: ClientID, link: PeerLink) {
    this.streamId = streamId;
    this.clientId = clientId;
    this.#link = link;
  }

  get closed(): boolean {
    return this.#closed;
  }

  on<K extends keyof PeerEvents>(
    event: K,
    listener: (payload: PeerEvents[K]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, listener);
  }

  sendCandidate(candidate: IceCandidate): Promise<void> {
    return this.#send(() => candidateJson(candidate));
  }

  sendSignal(cmd: string, args: unknown): Promise<void> {
    return this.#send(() => encodeSignal(cmd, args));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.end({ cause: "closed" });
    await this.#link.leave?.();
  }

  /** Send a message of the subclasses'. */
  protected send(json: string): Promise<void> {
    return this.#send(() => json);
  }

  async #send(json: () => string): Promise<void> {
    if (this.#closed) throw new TeamspeakError("the peer is closed");
    await this.#link.sendJson(json());
  }

  /** A signalling JSON from the other end. */
  deliver(json: string): void {
    if (this.#closed) return;
    const signal = parseSignal(json);
    switch (signal.kind) {
      case "offer":
        this.#emitter.emit("offer", signal.sdp);
        break;
      case "answer":
        this.#emitter.emit("answer", signal.sdp);
        break;
      case "candidate":
        this.#emitter.emit("candidate", signal.candidate);
        break;
      case "raw":
        this.#emitter.emit("signal", signal.signal);
        break;
    }
  }

  /** Close without telling the server, once. */
  end(closed: PeerClosed): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#link.closed(this);
    this.#emitter.emit("closed", closed);
  }
}

/** The publisher's end for one accepted viewer. */
export class ViewerPeerImpl extends PeerImpl implements ViewerPeer {
  sendOffer(sdp: string): Promise<void> {
    return this.send(offerJson(sdp));
  }
}

/** The viewer's end of a stream it was let into. */
export class StreamViewImpl extends PeerImpl implements StreamView {
  readonly offer: string;

  constructor(streamId: string, streamer: ClientID, offer: string, link: PeerLink) {
    super(streamId, streamer, link);
    this.offer = offer;
  }

  answer(sdp: string): Promise<void> {
    return this.send(answerJson(sdp));
  }

  leave(): Promise<void> {
    return this.close();
  }
}
