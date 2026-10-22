import {
  ErrorCode,
  getClientUIDInfoByID,
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
import { Emitter, MAX_KEPT } from "./emitter.js";
import { defer, within } from "./wait.js";
import type { Deferred } from "./wait.js";
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
const MAX_EARLY_SIGNALS = MAX_KEPT;
/** How many denied clients are remembered with `rememberDenied`. */
const MAX_DENIED = 1024;
/**
 * How long a cleared `client_is_streaming` waits before it ends that client's
 * streams. The server clears the flag right before it sends `notifystreamstopped`,
 * which carries the reason and is the authority; the flag is only a hint.
 */
const GONE_GRACE_MS = 2000;
/**
 * How long the `setupstream` of a `publish` stays open for the server's answer
 * beyond the caller's own timeout, so that however early the caller gives up,
 * by timeout or abort, the command listens for at least this long after: a
 * stream announced within it is stopped rather than left running unseen. The
 * announcement followed the command by at most 20 ms in the measurements (five
 * clients publishing ten streams each at once).
 */
const ANNOUNCE_WINDOW_MS = 5000;
/** How many streams stopped for a publish that gave up are remembered, to ignore their late rows. */
const MAX_ORPHANS = 16;

function signalOption(signal: AbortSignal | undefined): CommandOptions {
  return signal === undefined ? {} : { signal };
}

/** A `publish` whose `setupstream` is out, and what became of it. */
interface Attempt {
  readonly outcome: Deferred<PublishedImpl>;
  /** Set once the caller has stopped waiting; an announcement then is not theirs to receive. */
  abandoned: boolean;
  /** Set when the connection ended or the Streams were disposed: nothing of this attempt is kept. */
  reset: boolean;
}

/** A join request that has been sent and not yet answered, or the view it became. */
interface Watch {
  readonly streamer: ClientID;
  readonly early: string[];
  /** Whether the overflow of `early` was reported. */
  overflowed: boolean;
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
 * the native client.
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
  // Errors nobody listens for wait for the first listener, as other early
  // events do; past the bound the oldest is dropped, with no report of its own.
  readonly #emitter = new Emitter<StreamsEventMap>(["error"]);
  readonly #infos = new Map<string, StreamInfo>();
  /** The clients whose streams were asked for, until the flag clears or they go. */
  readonly #asked = new Set<ClientID>();
  /** Streams of a client whose flag cleared, to end as gone unless something better comes first. */
  readonly #goneTimers = new Map<ClientID, ReturnType<typeof setTimeout>>();
  readonly #published = new Map<string, PublishedImpl>();
  readonly #watching = new Map<string, Watch>();
  readonly #denied = new Set<string>();
  readonly #subscriptions: Unsubscribe[] = [];
  /** The `publish` calls still waiting for their stream. */
  readonly #publishing = new Set<Attempt>();
  /**
   * Streams stopped because their `publish` had given up, newest last. A row
   * about one that is still on its way, such as a late `notifystreaminfo`, must
   * not bring it back.
   */
  readonly #orphans = new Set<string>();
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
        if (event.isStreaming === true) {
          this.#cancelGone(event.id);
          this.#discover(event.id);
        }
        // Coming into view not streaming: whatever was known of it is over.
        else if (event.isStreaming === false) this.#forget(event.id);
      }),
      client.on("clientUpdated", (event) => {
        if (!("isStreaming" in event.changes)) return;
        // The flag clears with the last stream; a stream that starts later is looked up again.
        if (event.changes.isStreaming === true) {
          this.#cancelGone(event.clientID);
          this.#discover(event.clientID);
        } else if (event.changes.isStreaming === false) this.#forget(event.clientID);
      }),
      client.on("clientLeave", (event) => {
        this.#asked.delete(event.clientID);
        // A request nobody answered goes with the client: its id may be reused.
        for (const stream of this.#published.values()) stream.dropPending(event.clientID);
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
   * `"disposed"`. While the client is connected, each stream published here is
   * stopped (`stopstream`) and each stream watched here is left
   * (`joinstreamrequest` with `is_remove=1`), as far as the server takes them;
   * a failure goes to the `error` event of these Streams, which still has its
   * listeners. A `publish` still waiting is rejected, and a stream it started
   * after all is stopped when the server announces it, if the client is still
   * connected. When the connection is already gone nothing is
   * sent, and the server ends the streams itself.
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
   * only mode the server allows. A client may publish several streams, and
   * several calls may be in flight: the server echoes each command's
   * `return_code` on the announcement of the stream it started, so each call
   * receives its own, whatever the names. When the call gives up, by timeout or
   * abort, the command is kept open for five seconds after that moment, and
   * the stream it announces within is stopped; one announced later cannot be
   * told from any other of this client's, and is left to `list()`. The command
   * is sent even if the call is aborted before it leaves the throttle, and
   * then stopped the same way, so other clients may see the stream start and
   * stop.
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

    return this.#publishOne(request, options);
  }

  /**
   * The `setupstream` is answered with the announcement of the stream it
   * started: the server echoes the command's `return_code` on it, and nothing
   * else ties the two, since streams of one name are announced alike. The send
   * is therefore not the caller's to cancel. When the caller gives up, by
   * timeout or abort, the command may still have been carried out, and the
   * answer is what says which stream it started: it is stopped then.
   */
  async #publishOne(request: CommandRequest, options: PublishOptions): Promise<PublishedStream> {
    this.#assertUsable();
    options.signal?.throwIfAborted();
    const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    const attempt: Attempt = { outcome: defer<PublishedImpl>(), abandoned: false, reset: false };
    this.#publishing.add(attempt);
    void this.#setup(request, attempt, timeoutMs + ANNOUNCE_WINDOW_MS);
    try {
      return await within(attempt.outcome.promise, request.command, timeoutMs, options.signal);
    } catch (error) {
      attempt.abandoned = true;
      throw error;
    }
  }

  /** Send the `setupstream` and settle `attempt` with its stream, or stop the stream if nobody waits. */
  async #setup(request: CommandRequest, attempt: Attempt, timeoutMs: number): Promise<void> {
    try {
      let rows: Array<Record<string, string>>;
      try {
        rows = await this.#client.send(request, { timeoutMs });
      } catch (error) {
        attempt.outcome.reject(error);
        return;
      }
      const info = rows.reduce<StreamInfo | undefined>(
        (found, row) => streamInfoFrom(row, this.#infos.get(row["id"] ?? "")) ?? found,
        undefined,
      );
      if (attempt.reset) {
        // Answered after the connection ended or the Streams were disposed:
        // nothing here knows the stream, and the server still runs it.
        if (info !== undefined && this.#client.status === "connected") {
          this.#bestEffort(this.#stop(info.id, 0));
        }
        return;
      }
      if (info === undefined) {
        attempt.outcome.reject(
          new TeamspeakError("the server answered setupstream with no stream"),
        );
        return;
      }
      if (attempt.abandoned) {
        this.#orphan(info);
        return;
      }
      attempt.outcome.resolve(this.#adopt(info));
    } finally {
      this.#publishing.delete(attempt);
    }
  }

  /** The stream of a `publish` that is waiting: learned if the notification has not been, and published. */
  #adopt(info: StreamInfo): PublishedImpl {
    this.#learn(info);
    let published = this.#published.get(info.id);
    if (published === undefined) {
      published = new PublishedImpl(this.#infos.get(info.id) ?? info, this.#publishHost);
      this.#published.set(info.id, published);
    }
    return published;
  }

  /** A stream nobody is waiting for: stopped, and reported over if it was reported started. */
  #orphan(info: StreamInfo): void {
    this.#orphans.add(info.id);
    if (this.#orphans.size > MAX_ORPHANS)
      this.#orphans.delete(this.#orphans.values().next().value!);
    this.#end(info.id, 0, "stopped");
    this.#bestEffort(this.#stop(info.id, 0));
  }

  // ---- Watching -------------------------------------------------------------

  /**
   * Ask to watch a stream and resolve once its publisher lets this client in,
   * with the SDP offer in the view. Pass the id of a stream in `list()`, or its
   * info.
   *
   * Rejects with a `StreamJoinDeniedError` when the publisher refuses, a
   * `StreamEndedError` when the id is not one this client has heard of, or the
   * stream ends first (or is gone: error 5635), a
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
      throw new StreamEndedError(id);
    }
    if (this.#watching.has(id)) throw new TeamspeakError(`already watching stream ${id}`);
    options.signal?.throwIfAborted();

    const streamer = known.clientId;
    const watch: Watch = {
      streamer,
      early: [],
      overflowed: false,
      settled: defer<StreamViewImpl>(),
    };
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
    identity: (clientId) => {
      const entry = this.#client.view.client(clientId);
      if (entry !== undefined) {
        return { clientId, uid: entry.uid, nickname: entry.nickname };
      }
      // Not in view, as a client in another channel is not: ask the server who it is.
      return getClientUIDInfoByID(this.#client, clientId).then(
        (info): ViewerIdentity => ({ clientId, uid: info.uid, nickname: info.nickname }),
        (): ViewerIdentity => ({ clientId, uid: undefined, nickname: undefined }),
      );
    },
    report: (error) => this.#report(error),
    isDenied: (identity) =>
      this.#rememberDenied && identity.uid !== undefined && this.#denied.has(identity.uid),
    remember: (identity) => {
      if (!this.#rememberDenied || identity.uid === undefined) return;
      // Most recent last; the oldest goes past the bound.
      this.#denied.delete(identity.uid);
      this.#denied.add(identity.uid);
      if (this.#denied.size > MAX_DENIED) this.#denied.delete(this.#denied.values().next().value!);
    },
    send: (request, streamId) => this.#send(request, streamId),
    stop: (streamId, reason) => this.#stop(streamId, reason),
    info: (streamId) => this.#infos.get(streamId),
    stopped: (streamId, reason) => this.#end(streamId, reason, "stopped"),
  };

  /** `stopstream`; a stream the server no longer knows is stopped already. */
  async #stop(streamId: string, reason: number): Promise<void> {
    try {
      await this.#client.send(stopRequest(streamId, reason));
    } catch (error) {
      if (error instanceof ServerError && error.code === ErrorCode.StreamNotFound) return;
      throw error;
    }
  }

  #report(error: unknown): void {
    this.#emitter.emit("error", error instanceof Error ? error : new Error(String(error)));
  }

  /** Run `task` for its effect on the server: a failure is reported, not thrown, and a gone connection is no failure. */
  #bestEffort(task: Promise<void>): void {
    task.catch((error: unknown) => {
      if (error instanceof NotConnectedError) return;
      this.#report(error);
    });
  }

  /** A client no longer streams, or came into view not streaming: its streams are over. */
  #forget(clid: ClientID): void {
    this.#asked.delete(clid);
    if (this.#goneTimers.has(clid)) return;
    if (![...this.#infos.values()].some((info) => info.clientId === clid)) return;
    // The stop notification may follow at once, with the reason: it wins.
    const timer = setTimeout(() => {
      this.#goneTimers.delete(clid);
      for (const info of this.#infos.values()) {
        if (info.clientId === clid) this.#end(info.id, 0, "gone");
      }
    }, GONE_GRACE_MS);
    timer.unref?.();
    this.#goneTimers.set(clid, timer);
  }

  #cancelGone(clid: ClientID): void {
    const timer = this.#goneTimers.get(clid);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#goneTimers.delete(clid);
  }

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
      this.#report(error);
    });
  }

  // ---- Notifications --------------------------------------------------------

  #onNotification(event: NotificationEvent): void {
    const params = event.params;
    const name: string = event.name;
    switch (name) {
      case "notifystreamstarted":
        this.#onInfo(params);
        break;
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
        if (id !== "") {
          this.#end(id, intOf(params, "reason", 0), "server");
          this.#orphans.delete(id);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * An announcement or a reply to `requeststreaminfo`. The publisher's own
   * announcement is no different: `publish` finds it by the answer to its
   * command, and this is told of it the same way, in either order.
   */
  #onInfo(params: Readonly<Record<string, string>>): void {
    // The empty `notifystreaminfo` for a client that streams nothing has no id.
    const info = streamInfoFrom(params, this.#infos.get(params["id"] ?? ""));
    if (info !== undefined) this.#learn(info);
  }

  /** Record what is known of a stream and report it; knowing it again changes nothing. */
  #learn(info: StreamInfo): void {
    if (this.#orphans.has(info.id)) return;
    const known = this.#infos.get(info.id);
    this.#infos.set(info.id, info);
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
      report: (error) => this.#report(error),
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
      watch.early.push(json);
      if (watch.early.length > MAX_EARLY_SIGNALS) {
        // The oldest goes, as from a peer's queue, and the first time is reported.
        watch.early.shift();
        if (!watch.overflowed) {
          watch.overflowed = true;
          this.#report(
            new TeamspeakError(
              `stream ${id}: dropping the oldest signalling message: ${MAX_EARLY_SIGNALS} are waiting for the publisher's answer`,
            ),
          );
        }
      }
    } else {
      this.#report(
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
  #end(id: string, reason: number, cause: "stopped" | "server" | "gone"): void {
    const info = this.#infos.get(id);
    this.#infos.delete(id);
    if (
      info !== undefined &&
      ![...this.#infos.values()].some((i) => i.clientId === info.clientId)
    ) {
      this.#cancelGone(info.clientId);
    }

    const published = this.#published.get(id);
    this.#published.delete(id);
    published?.finish({ cause, reason });

    const watch = this.#watching.get(id);
    this.#watching.delete(id);
    if (watch?.view !== undefined) watch.view.end({ cause: "stopped", reason });
    else watch?.settled.reject(new StreamEndedError(id));

    if (info !== undefined) this.#emitter.emit("stopped", { info, cause, reason });
  }

  /** The connection ended or the Streams were disposed: close everything, once, and forget. */
  #reset(cause: "disconnected" | "disposed"): void {
    const gone =
      cause === "disconnected"
        ? new NotConnectedError()
        : new TeamspeakError("these Streams were disposed");
    for (const attempt of this.#publishing) {
      attempt.reset = true;
      attempt.outcome.reject(gone);
    }
    this.#publishing.clear();
    this.#orphans.clear();

    const ended: StreamEnded = { cause, reason: 0 };
    const published = [...this.#published.values()];
    const watching = [...this.#watching.entries()];
    // While the connection is up, tell the server: it would otherwise keep the
    // streams, and the requests, until it noticed the client was gone.
    if (this.#client.status === "connected") {
      for (const stream of published) this.#bestEffort(this.#stop(stream.id, 0));
      for (const [id, watch] of watching) this.#bestEffort(this.#leave(id, watch.streamer));
    }
    for (const timer of this.#goneTimers.values()) clearTimeout(timer);
    this.#goneTimers.clear();
    this.#published.clear();
    this.#watching.clear();
    this.#infos.clear();
    this.#asked.clear();
    for (const stream of published) stream.finish(ended);
    if (cause === "disposed") this.#denied.clear();
    for (const [, watch] of watching) {
      if (watch.view !== undefined) watch.view.end({ cause });
      else watch.settled.reject(gone);
    }
  }
}
