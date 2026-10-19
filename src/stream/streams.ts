import {
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  ServerError,
  TeamspeakError,
} from "@honeybbq/teamspeak";
import type {
  ClientID,
  CommandOptions,
  CommandRequest,
  NotificationEvent,
  Unsubscribe,
} from "@honeybbq/teamspeak";
import { Emitter } from "./emitter.js";
import { StreamEndedError, StreamJoinDeniedError, StreamsUnsupportedError } from "./errors.js";
import { StreamViewImpl } from "./peer.js";
import type { PeerImpl } from "./peer.js";
import { PublishedImpl } from "./published.js";
import type { PublishHost } from "./published.js";
import type {
  PublishedStream,
  PublishOptions,
  StreamEnded,
  StreamInfo,
  StreamsClient,
  StreamsEventMap,
  StreamsOptions,
  StreamView,
  ViewerIdentity,
  WatchOptions,
} from "./types.js";
import {
  accessibilityToWire,
  assertFits,
  clientOf,
  infoRequest,
  intOf,
  joinRequest,
  sameInfo,
  setupRequest,
  signalRequest,
  sourceToWire,
  stopRequest,
  streamInfoFrom,
} from "./wire.js";

const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_WATCH_TIMEOUT_MS = 60_000;
/** How many signalling messages that arrive before the answer to a join request are kept. */
const MAX_EARLY_SIGNALS = 256;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Whoever awaits it sees the failure; one that settles before anyone does is not unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** `promise`, or a rejection when `timeoutMs` passes or `signal` aborts first. */
function within<T>(
  promise: Promise<T>,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandTimeoutError(command)), timeoutMs);
    const onAbort = (): void => reject(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

function signalOption(signal: AbortSignal | undefined): CommandOptions {
  return signal === undefined ? {} : { signal };
}

/** A join request that has been sent and not yet answered, or the view it became. */
interface Watch {
  readonly streamer: ClientID;
  readonly early: string[];
  readonly settled: Deferred<StreamViewImpl>;
  view?: StreamViewImpl;
}

/**
 * TeamSpeak 6 streams, the screen share: who is streaming, publishing a
 * stream, and watching one.
 *
 * Only the signalling is here. A stream's video travels between the publisher
 * and each viewer over WebRTC, which is the application's: this gives it the
 * SDP and ICE messages as strings, and takes them back, and any WebRTC stack
 * can be plugged in. TeamSpeak does not document the protocol and it was
 * measured on TeamSpeak 6 6.0.0-beta13.1 only; it has not been checked against
 * the native client's own stream.
 *
 * `Streams` attaches to a voice client, before or after it connects, and finds
 * the streams of the clients it sees: a client with `client_is_streaming` set
 * is asked for them with `requeststreaminfo`. Every stream is known by its id,
 * and a client may run several. What `list()` holds is what this client has
 * heard of: a stream that ends while its publisher is out of the channel is
 * reported to nobody there, and stays until the connection ends.
 *
 * ```ts
 * const streams = new Streams(client);
 * streams.on("started", (info) => console.log(`${info.name} is streaming`));
 * const view = await streams.watch(info);
 * // hand view.offer to an RTCPeerConnection, send its answer with view.answer()
 * ```
 *
 * @beta
 */
export class Streams {
  readonly #client: StreamsClient;
  readonly #rememberDenied: boolean;
  readonly #emitter = new Emitter<StreamsEventMap>();
  readonly #infos = new Map<string, StreamInfo>();
  /** The clients whose streams were asked for, until the flag clears or they go. */
  readonly #asked = new Set<ClientID>();
  readonly #published = new Map<string, PublishedImpl>();
  readonly #watching = new Map<string, Watch>();
  readonly #denied = new Set<string>();
  readonly #subscriptions: Unsubscribe[] = [];
  /** The `setupstream` waiting for the announcement; calls queue behind it. */
  #publishing: Deferred<PublishedImpl> | undefined;
  #publishQueue: Promise<unknown> = Promise.resolve();
  #disposed = false;

  /**
   * Attach to `client`, which may not have connected yet. Nothing is sent
   * until it has, and on a server that is not TeamSpeak 6 nothing is ever sent.
   */
  constructor(client: StreamsClient, options: StreamsOptions = {}) {
    this.#client = client;
    this.#rememberDenied = options.rememberDenied === true;
    this.#subscriptions.push(
      client.on("notification", (event) => this.#onNotification(event)),
      client.on("clientEnter", (event) => {
        if (event.isStreaming === true) this.#discover(event.id);
      }),
      client.on("clientUpdated", (event) => {
        if (!("isStreaming" in event.changes)) return;
        // The flag clears with the last stream; a stream that starts later is looked up again.
        if (event.changes.isStreaming === true) this.#discover(event.clientID);
        else this.#asked.delete(event.clientID);
      }),
      client.on("clientLeave", (event) => {
        this.#asked.delete(event.clientID);
      }),
      client.on("disconnected", () => this.#reset("disconnected")),
    );
    if (client.status === "connected") {
      for (const entry of client.view.clients.values()) {
        if (entry.isStreaming === true) this.#discover(entry.id);
      }
    }
  }

  /** Whether the connected server can do streams: a TeamSpeak 6 server. */
  get supported(): boolean {
    return this.#client.serverCapabilities.family === "ts6";
  }

  /** The streams known now, in the order they became known. */
  list(): readonly StreamInfo[] {
    return [...this.#infos.values()];
  }

  /** The stream with this id, if known. */
  get(id: string): StreamInfo | undefined {
    return this.#infos.get(id);
  }

  /** Listen for an event; returns a function that removes the listener. */
  on<K extends keyof StreamsEventMap>(
    event: K,
    listener: (payload: StreamsEventMap[K]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, listener);
  }

  /**
   * Stop listening to the client and end every session: the streams published
   * here, the views and the viewers, each closed once with the cause
   * `"disposed"`. A stream published here keeps running on the server, as it
   * does when the connection drops until the server notices: stop it first
   * with `stop()` to end it.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#reset("disposed");
  }

  // ---- Publishing -----------------------------------------------------------

  /**
   * Start a stream and resolve once the server has announced it. The call
   * sends `setupstream` with all seven parameters, in peer to peer mode, the
   * only mode the server allows. A client may publish several streams; calls
   * wait their turn so that each announcement is matched with its call.
   *
   * Throws a `StreamsUnsupportedError`, without sending anything, on a server
   * that is not TeamSpeak 6, and a `RangeError` for an option that is out of
   * range.
   */
  async publish(options: PublishOptions): Promise<PublishedStream> {
    this.#assertUsable();
    const source = sourceToWire(options.source ?? "screen");
    const accessibility = accessibilityToWire(options.accessibility ?? "public");
    const bitrate = options.bitrate ?? 1_500_000;
    const viewerLimit = options.viewerLimit ?? 0;
    if (typeof options.name !== "string") throw new TypeError("the stream needs a name");
    if (source === undefined) throw new RangeError(`unknown source ${String(options.source)}`);
    if (accessibility === undefined) {
      throw new RangeError(`unknown accessibility ${String(options.accessibility)}`);
    }
    if (!Number.isSafeInteger(bitrate) || bitrate < 0 || bitrate > 2_147_483_647) {
      throw new RangeError("the bitrate must be an integer from 0 to 2147483647");
    }
    if (!Number.isSafeInteger(viewerLimit) || viewerLimit < 0 || viewerLimit > 65_535) {
      throw new RangeError("the viewer limit must be an integer from 0 to 65535");
    }
    const request = setupRequest({
      name: options.name,
      source,
      bitrate,
      accessibility,
      viewerLimit,
      audio: options.audio === true,
    });
    assertFits(request);
    options.signal?.throwIfAborted();

    const run = this.#publishQueue.then(() => this.#publishOne(request, options));
    this.#publishQueue = run.catch(() => {});
    return run;
  }

  async #publishOne(request: CommandRequest, options: PublishOptions): Promise<PublishedStream> {
    this.#assertUsable();
    options.signal?.throwIfAborted();
    const announced = defer<PublishedImpl>();
    this.#publishing = announced;
    try {
      const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
      await this.#send(request, undefined, signalOption(options.signal));
      return await within(announced.promise, request.command, timeoutMs, options.signal);
    } finally {
      if (this.#publishing === announced) this.#publishing = undefined;
    }
  }

  // ---- Watching -------------------------------------------------------------

  /**
   * Ask to watch a stream and resolve once its publisher lets this client in,
   * with the SDP offer in the view. Pass the id of a stream in `list()`, or its
   * info.
   *
   * Rejects with a `StreamJoinDeniedError` when the publisher refuses, a
   * `StreamEndedError` when the stream ends first (or is gone: error 5635), a
   * `StreamsUnsupportedError` on a server without streams, and the server's
   * own error otherwise, among them 5638 (`ErrorCode.StreamAlreadyJoined`)
   * when this client already asked. When the wait runs out or `signal` aborts,
   * the request is withdrawn.
   */
  async watch(target: string | StreamInfo, options: WatchOptions = {}): Promise<StreamView> {
    this.#assertUsable();
    const id = typeof target === "string" ? target : target.id;
    const known = typeof target === "string" ? this.#infos.get(target) : target;
    if (known === undefined) {
      throw new TeamspeakError(`stream ${id} is not known: pass its StreamInfo, or wait for it`);
    }
    if (this.#watching.has(id)) throw new TeamspeakError(`already watching stream ${id}`);
    options.signal?.throwIfAborted();

    const streamer = known.clientId;
    const watch: Watch = { streamer, early: [], settled: defer<StreamViewImpl>() };
    this.#watching.set(id, watch);
    try {
      await this.#send(
        joinRequest(id, streamer, options.message ?? "", false),
        id,
        signalOption(options.signal),
      );
      return await within(
        watch.settled.promise,
        "joinstreamrequest",
        options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
        options.signal,
      );
    } catch (error) {
      if (this.#watching.get(id) === watch && watch.view === undefined) {
        this.#watching.delete(id);
        // Asked and not answered, or answered without a usable offer: withdraw.
        const answered =
          error instanceof StreamJoinDeniedError ||
          error instanceof StreamEndedError ||
          error instanceof NotConnectedError ||
          error instanceof ServerError;
        if (!answered) void this.#leave(id, streamer).catch(() => {});
      }
      throw error;
    }
  }

  // ---- Commands -------------------------------------------------------------

  #assertUsable(): void {
    if (this.#disposed) throw new TeamspeakError("these Streams were disposed");
    const { family, version } = this.#client.serverCapabilities;
    if (family !== "ts6") throw new StreamsUnsupportedError(family, version);
  }

  /** Send a stream command. A stream the server does not know is a StreamEndedError. */
  async #send(
    request: CommandRequest,
    streamId: string | undefined,
    options?: CommandOptions,
  ): Promise<void> {
    assertFits(request);
    try {
      await this.#client.send(request, options);
    } catch (error) {
      if (
        streamId !== undefined &&
        error instanceof ServerError &&
        error.code === ErrorCode.StreamNotFound
      ) {
        throw new StreamEndedError(streamId, { cause: error });
      }
      throw error;
    }
  }

  /** Tell the server this client stops watching; a stream or connection already gone is no failure. */
  async #leave(id: string, streamer: ClientID): Promise<void> {
    try {
      await this.#send(joinRequest(id, streamer, "", true), id);
    } catch (error) {
      if (error instanceof StreamEndedError || error instanceof NotConnectedError) return;
      throw error;
    }
  }

  readonly #publishHost: PublishHost = {
    identity: (clientId): ViewerIdentity => {
      const entry = this.#client.view.client(clientId);
      return { clientId, uid: entry?.uid, nickname: entry?.nickname };
    },
    isDenied: (identity) =>
      this.#rememberDenied && identity.uid !== undefined && this.#denied.has(identity.uid),
    remember: (identity) => {
      if (this.#rememberDenied && identity.uid !== undefined) this.#denied.add(identity.uid);
    },
    send: (request, streamId) => this.#send(request, streamId),
    stop: async (streamId, reason) => {
      try {
        await this.#client.send(stopRequest(streamId, reason));
      } catch (error) {
        // Gone already: what was asked for has happened.
        if (error instanceof ServerError && error.code === ErrorCode.StreamNotFound) return;
        throw error;
      }
    },
    info: (streamId) => this.#infos.get(streamId),
    stopped: (streamId, reason) => this.#end(streamId, reason, "stopped"),
  };

  // ---- Discovery ------------------------------------------------------------

  /**
   * Ask for the streams of a client that says it streams, once. The answer is
   * one `notifystreaminfo` per stream, which `#onNotification` takes.
   */
  #discover(clid: ClientID): void {
    if (
      this.#disposed ||
      clid === 0 ||
      clid === this.#client.clientID ||
      this.#asked.has(clid) ||
      !this.supported ||
      this.#client.status !== "connected"
    ) {
      return;
    }
    this.#asked.add(clid);
    this.#client.send(infoRequest(clid)).catch((error: unknown) => {
      // Asked again the next time the client is seen to stream.
      this.#asked.delete(clid);
      if (error instanceof NotConnectedError) return;
      this.#emitter.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  // ---- Notifications --------------------------------------------------------

  #onNotification(event: NotificationEvent): void {
    const params = event.params;
    const name: string = event.name;
    switch (name) {
      case "notifystreamstarted":
      case "notifystreaminfo":
        this.#onInfo(params);
        break;
      case "notifyjoinstreamrequest": {
        const id = params["id"] ?? "";
        const clid = clientOf(params, "clid");
        const published = this.#published.get(id);
        if (published === undefined || clid === 0) break;
        if (params["is_remove"] === "1") published.viewerGone(clid);
        else published.request(clid, params["msg"] ?? "");
        break;
      }
      case "notifyrespondjoinstreamrequest":
        this.#onRespond(params);
        break;
      case "notifystreamsignaling":
        this.#onSignaling(params);
        break;
      case "notifystreamclientjoined": {
        const info = this.#infos.get(params["id"] ?? "");
        const clid = clientOf(params, "clid");
        if (info !== undefined && clid !== 0) {
          this.#emitter.emit("viewerJoined", { info, clientId: clid });
        }
        break;
      }
      case "notifystreamclientleft":
        this.#onClientLeft(params);
        break;
      case "notifystreamstopped": {
        const id = params["id"] ?? "";
        if (id !== "") this.#end(id, intOf(params, "reason", 0), "server");
        break;
      }
      default:
        break;
    }
  }

  #onInfo(params: Readonly<Record<string, string>>): void {
    const known = this.#infos.get(params["id"] ?? "");
    // The empty `notifystreaminfo` for a client that streams nothing has no id.
    const info = streamInfoFrom(params, known);
    if (info === undefined) return;
    this.#infos.set(info.id, info);

    const announced = this.#publishing;
    if (
      announced !== undefined &&
      known === undefined &&
      info.clientId === this.#client.clientID &&
      !this.#published.has(info.id)
    ) {
      const published = new PublishedImpl(info, this.#publishHost);
      this.#published.set(info.id, published);
      this.#publishing = undefined;
      announced.resolve(published);
    }

    if (known === undefined) this.#emitter.emit("started", info);
    else if (!sameInfo(known, info)) this.#emitter.emit("updated", info);
  }

  #onRespond(params: Readonly<Record<string, string>>): void {
    const id = params["id"] ?? "";
    const watch = this.#watching.get(id);
    if (watch === undefined || watch.view !== undefined) return;
    const message = params["msg"] ?? "";
    if (params["decision"] !== "1") {
      this.#watching.delete(id);
      watch.settled.reject(new StreamJoinDeniedError(id, message));
      return;
    }
    const offer = params["offer"] ?? "";
    if (offer === "") {
      this.#watching.delete(id);
      watch.settled.reject(
        new TeamspeakError("the publisher accepted the request without an offer"),
      );
      void this.#leave(id, watch.streamer).catch(() => {});
      return;
    }
    const view = new StreamViewImpl(id, watch.streamer, offer, {
      sendJson: (json) => this.#send(signalRequest(id, watch.streamer, json), id),
      leave: () => this.#leave(id, watch.streamer),
      closed: (closing: PeerImpl) => {
        if (this.#watching.get(id)?.view === closing) this.#watching.delete(id);
      },
    });
    watch.view = view;
    // What the publisher sent right behind the offer, ahead of the app's first await.
    for (const json of watch.early.splice(0)) view.deliver(json);
    watch.settled.resolve(view);
  }

  #onSignaling(params: Readonly<Record<string, string>>): void {
    const id = params["id"] ?? "";
    const clid = clientOf(params, "clid");
    const json = params["json"] ?? "";
    if (this.#published.get(id)?.signal(clid, json) === true) return;
    const watch = this.#watching.get(id);
    if (watch?.view !== undefined) {
      watch.view.deliver(json);
    } else if (watch !== undefined) {
      if (watch.early.length < MAX_EARLY_SIGNALS) watch.early.push(json);
    } else {
      this.#emitter.emit(
        "error",
        new TeamspeakError(`signalling for stream ${id} from client ${clid}, which has no session`),
      );
    }
  }

  #onClientLeft(params: Readonly<Record<string, string>>): void {
    const id = params["id"] ?? "";
    const clid = clientOf(params, "clid");
    if (clid === 0) return;
    this.#published.get(id)?.viewerGone(clid);
    // Others leaving is not this view's end; this client leaving is.
    const view = this.#watching.get(id)?.view;
    if (view !== undefined && clid === this.#client.clientID) view.end({ cause: "left" });
    const info = this.#infos.get(id);
    if (info !== undefined) this.#emitter.emit("viewerLeft", { info, clientId: clid });
  }

  // ---- Ending ---------------------------------------------------------------

  /** A stream is over, for whatever hangs on it, and is forgotten. */
  #end(id: string, reason: number, cause: "stopped" | "server"): void {
    const info = this.#infos.get(id);
    this.#infos.delete(id);

    const published = this.#published.get(id);
    this.#published.delete(id);
    published?.finish({ cause, reason });

    const watch = this.#watching.get(id);
    this.#watching.delete(id);
    if (watch?.view !== undefined) watch.view.end({ cause: "stopped", reason });
    else watch?.settled.reject(new StreamEndedError(id));

    if (info !== undefined) this.#emitter.emit("stopped", { info, reason });
  }

  /** The connection ended or the Streams were disposed: close everything, once, and forget. */
  #reset(cause: "disconnected" | "disposed"): void {
    const gone =
      cause === "disconnected"
        ? new NotConnectedError()
        : new TeamspeakError("these Streams were disposed");
    this.#publishing?.reject(gone);
    this.#publishing = undefined;

    const ended: StreamEnded = { cause, reason: 0 };
    const published = [...this.#published.values()];
    const watching = [...this.#watching.values()];
    this.#published.clear();
    this.#watching.clear();
    this.#infos.clear();
    this.#asked.clear();
    for (const stream of published) stream.finish(ended);
    for (const watch of watching) {
      if (watch.view !== undefined) watch.view.end({ cause });
      else watch.settled.reject(gone);
    }
  }
}
