import {
  AlreadyConnectedError,
  ClientStatus,
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  Reason,
  ServerError,
  TeamspeakError,
  backoffDelay,
  noopLogger,
  type ClientEntry,
  type CommandExecutor,
  type CommandMiddleware,
  type CommandOptions,
  type CommandRequest,
  type KickedEvent,
  type Listener,
  type Logger,
  type ReconnectOptions,
  serverFamilyForVersion,
  type ServerEventMap,
  type ServerFamily,
  type ServerID,
  type SessionEventMap,
  type Unsubscribe,
} from "@honeybbq/teamspeak";
import {
  buildCommandChain,
  buildCommandOrdered,
  encodeRequest,
  handleNotification,
  parseCommand,
  parseServerError,
  resolveBackoffPolicy,
} from "../core/internal.js";
import type { QueryTransport, QueryTransportStats } from "./transport.js";
import { connectTcp } from "./tcp.js";
import { connectSsh } from "./ssh.js";
import { WebQueryTransport } from "./web.js";
import { GuestAccessError, QueryAuthError } from "./errors.js";
import {
  assertEventsSupported,
  normalizeQueryOptions,
  type QueryClientOptions,
  type QueryEventCategory,
} from "./options.js";
import type { ResolvedQueryOptions, ResolvedTransport } from "./options.js";
import { defaultShouldRetry } from "./reconnect.js";

export type {
  QueryClientOptions,
  QueryEventsOption,
  QueryEventCategory,
  QueryTransportOptions,
} from "./options.js";

/**
 * The events `QueryClient.on()` takes, and what each delivers.
 *
 * The server's own events are the core's, unchanged: ServerQuery and the voice
 * protocol carry the same notifications with the same fields, so a listener
 * written for one client reads the other. `connected` and `disconnected` come
 * from this client's own lifecycle.
 *
 * A notification reaches this client on two layers at once, as it does the
 * voice client: the typed event for it, if it has one, and then `notification`,
 * which carries every notification with its wire name and unescaped parameters.
 * So a typed event added here is additive — the notification it names stays on
 * the catch-all — and none of these keys is removed in a minor release.
 *
 * `TextMessageEvent.invokerGroups` is, for this client, what it knew when it
 * listed the clients on connecting or saw the sender enter: a ServerQuery
 * connection is not told when a client's groups change later.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface QueryEventMap extends ServerEventMap, SessionEventMap {}

/** How long a command waits for its answer unless told otherwise. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Over SSH, how long a command waits for its answer before the client writes an
 * empty line to release a reply the server may be holding, and how often it
 * writes one after that. See `#execNow`.
 */
const SSH_NUDGE_AFTER_MS = 2_000;
const SSH_NUDGE_EVERY_MS = 1_000;

/** How long each reconnection attempt may take. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 30_000;

/** The commands `connect()` runs on the session's own path, so a middleware never sees them. */
interface Subscription {
  readonly listener: (payload: unknown) => void;
  removed: boolean;
}

interface Pending {
  readonly command: string;
  readonly rows: Array<Record<string, string>>;
  resolve(rows: Array<Record<string, string>>): void;
  reject(error: unknown): void;
}

/**
 * A ServerQuery client: runs the typed commands from `@honeybbq/teamspeak` over
 * one of the three ServerQuery transports, and delivers the notifications the
 * server sends as the core's typed events.
 *
 * ServerQuery answers one command at a time, in order: data lines, then an
 * `error` line that ends the answer. So commands are queued and sent one after
 * another, which also keeps the server's flood protection from seeing a burst.
 * Notifications (`notify…`) can arrive at any point and are not part of an
 * answer.
 *
 * The transport is given as a {@link QueryClientOptions.transport} description
 * rather than an open connection, so the client can build it again when it
 * reconnects.
 *
 * @experimental New in 1.x and may change in a minor release: the options, the
 * transport union and the event map are all still settling.
 */
export class QueryClient implements CommandExecutor, AsyncDisposable {
  #options: ResolvedQueryOptions;
  #logger: Logger;
  #transport: QueryTransport | null = null;
  #status: ClientStatus = ClientStatus.Disconnected;
  #serverFamily: ServerFamily = "unknown";
  #version = "";

  #pending: Pending | null = null;
  /**
   * Answers still to come for commands that gave up waiting. ServerQuery has
   * no return_code, only order, so each is read and discarded when it arrives
   * rather than taken for the next command's.
   */
  #abandoned = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = true;
  /**
   * Bumped by `disconnect()`. A connection attempt that was in flight compares
   * it after every await, so one that was given up on cannot install itself as
   * the live connection.
   */
  #generation = 0;

  /**
   * This connection's own client id, which the server names in `whoami`, so
   * that a kick of this client is told from a move of another. Asked, never
   * guessed from the nickname: the server renames a client whose nickname is
   * taken, and an older session may still hold the one this client asked for.
   * 0 until it is known.
   */
  #clid = 0;
  #clients = new Map<number, ClientEntry>();

  #reconnectOptions: ReconnectOptions | undefined;
  #reconnecting = false;
  #loopAttempt = 0;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #stopReconnecting: AbortController | undefined;
  /** The last answer of `shouldRetry`, so that one failure asks it once. */
  #retryAnswer:
    | {
        readonly err: Error;
        readonly attempt: number;
        readonly retry: boolean;
        readonly threw: boolean;
      }
    | undefined;
  /**
   * Why the last established session dropped: a reconnect loop whose own
   * attempt connected and then dropped before the loop resumed retries for it.
   */
  #lastDrop: Error | undefined;
  /**
   * Settles once the last `disconnected` has been delivered. A `connect()`
   * waits for it, so the end of one session is never heard during the next.
   */
  #disconnectedDelivered: Promise<void> | undefined;

  /**
   * Whether the transport delivers notifications, as it reports.
   *
   * For a `tcp`, `ssh` or `web` transport this is the kind's own truth, known
   * when the client is made. A `custom` transport can only say once it has
   * been opened, so until then this is `undefined` and a listener is accepted
   * rather than guessed at; the first connection settles it.
   */
  #notifications: boolean | undefined;

  #listeners = new Map<keyof QueryEventMap, Subscription[]>();
  #send: CommandExecutor["send"];

  constructor(options: QueryClientOptions) {
    this.#options = normalizeQueryOptions(options);
    this.#logger = this.#options.logger ?? noopLogger;
    this.#notifications = this.#options.notificationsSupported;
    this.#reconnectOptions = this.#options.reconnect;
    const middlewares: readonly CommandMiddleware[] = this.#options.commandMiddleware ?? [];
    // Built once: the chain is read on every command, and changing it while
    // those run would make the behaviour depend on timing.
    this.#send = buildCommandChain(middlewares, (request, commandOptions = {}) =>
      this.exec(
        encodeRequest(request, (password) => password),
        commandOptions,
      ),
    );
  }

  /** Where the client is in its connection's life. */
  get status(): ClientStatus {
    return this.#status;
  }

  /**
   * Which server generation the server is, read from its `version` answer.
   * `"unknown"` before connecting.
   *
   * @experimental Part of the entry, which may change in a minor release.
   */
  get serverFamily(): ServerFamily {
    return this.#serverFamily;
  }

  /** The `version` string the server answered with; "" before connecting. */
  get serverVersion(): string {
    return this.#version;
  }

  /**
   * What the current connection reports about itself: its kind, where it
   * points, when it opened and how many bytes went each way, for a metrics
   * exporter. Read-only. A client with no connection, and a `custom` transport
   * that keeps no counts, report no kind, an empty address, no open time and
   * zero bytes. A reconnection starts the counts again.
   *
   * @experimental Part of the entry, which may change in a minor release.
   */
  get stats(): QueryTransportStats {
    return (
      this.#transport?.stats?.() ?? {
        connectedAt: undefined,
        transport: undefined,
        address: "",
        bytesSent: 0,
        bytesReceived: 0,
      }
    );
  }

  /**
   * The transport carrying this connection, or `undefined` when there is none.
   *
   * Read-only, and the transport is the interface the client itself talks
   * over. The socket underneath is not exposed:
   * a caller that needs it supplies the seam instead (the `connect` option of
   * a `tcp` transport, or `connection` of an `ssh` one), where it is theirs to
   * keep.
   *
   * @experimental Part of the entry, which may change in a minor release.
   */
  get transport(): QueryTransport | undefined {
    return this.#transport ?? undefined;
  }

  /**
   * The notification categories this connection registered for: what `events`
   * asked for, and empty when the transport delivers no notifications or the
   * client is not connected.
   */
  get eventCategories(): readonly QueryEventCategory[] {
    return this.status === ClientStatus.Connected && this.#notifications === true
      ? this.#options.eventCategories
      : [];
  }

  // ---- Connection -----------------------------------------------------------

  /**
   * Connect and set the session up: open the transport, then `login` (the raw
   * TCP transport's `login` option), `use`, `version`, the notification registrations, and one client
   * list.
   *
   * The transport's `login` and the `server` option are applied here rather than left to the
   * caller so that a reconnection is the same session as the first connection
   * was.
   *
   * A failure rejects with its cause and leaves the client disconnected; the
   * transport it opened is closed. `signal` bounds only the connecting: once
   * this resolves, the connection lasts until `disconnect()` or a drop.
   * `connect()` does not retry itself; the `reconnect` option retries a
   * connection that dropped after it was established.
   *
   * `connected` is delivered before this resolves, so a listener added after
   * `await client.connect()` has missed it — add the listeners first.
   */
  async connect(options: { readonly signal?: AbortSignal | undefined } = {}): Promise<void> {
    return this.#connect(options, false);
  }

  async #connect(
    options: { readonly signal?: AbortSignal | undefined },
    reconnect: boolean,
  ): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    // A disconnect() still tearing down waits to be done: a session built over
    // one that is still closing would have its transport closed under it.
    if (this.#stopping !== undefined) await this.#stopping;
    // And so does an earlier session's `disconnected`, so that no listener or
    // events() iterator of this session hears the last one end.
    while (this.#disconnectedDelivered !== undefined) {
      await this.#disconnectedDelivered;
      signal?.throwIfAborted();
    }
    if (this.#status !== ClientStatus.Disconnected) throw new AlreadyConnectedError();

    this.#stopped = false;
    this.#generation++;
    const generation = this.#generation;
    this.#status = ClientStatus.Connecting;
    try {
      await this.#establish(signal, generation);
    } catch (error) {
      this.#failConnection(error);
      throw error;
    }
    if (generation !== this.#generation) throw new NotConnectedError();
    this.#status = ClientStatus.Connected;
    this.#emit("connected", { reconnected: reconnect });
  }

  /**
   * One connection attempt, from opening the transport to having a usable
   * session. `connect()` and the reconnect loop share it, so a reconnection is
   * the same session the first connection was.
   */
  async #establish(signal: AbortSignal | undefined, generation: number): Promise<void> {
    try {
      await this.#establishSession(signal, generation);
    } catch (error) {
      throw this.#guestRefusal(error) ?? error;
    }
  }

  /**
   * The refusal of a guest connection by a server with no guest access, as
   * itself: 5124 over WebQuery, a failed `guest` authentication over SSH.
   */
  #guestRefusal(error: unknown): GuestAccessError | undefined {
    const transport = this.#options.transport;
    if (transport.kind === "web" && transport.apiKey === undefined) {
      if (error instanceof ServerError && error.code === ErrorCode.APIKeyMissing) {
        return new GuestAccessError(error, error.code);
      }
    } else if (
      transport.kind === "ssh" &&
      (transport.connect as { guest?: unknown }).guest === true
    ) {
      if (error instanceof QueryAuthError) return new GuestAccessError(error);
    }
    return undefined;
  }

  async #establishSession(signal: AbortSignal | undefined, generation: number): Promise<void> {
    const transport = await this.#openTransport(signal);
    // Given up on while the transport was being opened: it is closed rather
    // than installed, and the caller hears that nothing is connected.
    if (generation !== this.#generation || this.#status !== ClientStatus.Connecting) {
      await transport.close().catch(() => {});
      throw new NotConnectedError();
    }

    // A custom transport only says here whether it can deliver notifications,
    // so a request to register for them is checked here rather than only at
    // construction. The transport is closed first: the option is the caller's
    // mistake, and leaving a connection open behind it helps nobody.
    this.#notifications = transport.supportsNotifications;
    try {
      assertEventsSupported({ ...this.#options, notificationsSupported: this.#notifications });
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }

    this.#transport = transport;
    this.#closed = false;
    this.#abandoned = 0;
    this.#pending = null;
    this.#clients.clear();
    this.#clid = 0;
    this.#serverFamily = "unknown";
    this.#version = "";
    transport.onLine = (line) => this.#handleLine(line);
    transport.onClose = (error) => this.#handleClose(error);

    const { transport: resolvedTransport, server, nickname, eventCategories } = this.#options;
    const login = resolvedTransport.kind === "tcp" ? resolvedTransport.login : undefined;
    if (login !== undefined) await this.login(login.name, login.password, { signal });
    // Not `use()`: this session learns who it is, and who is there, once, below.
    if (server !== undefined) await this.#select(server, { nickname, signal });
    this.#version = await this.#getVersion(signal);
    this.#serverFamily = serverFamilyForVersion(this.#version);
    // Like the version, a failure here fails the connect: a client that cannot
    // tell which one it is would miss its own kick without saying so.
    await this.#learnSelf(signal);
    if (this.#notifications) {
      for (const category of eventCategories) {
        // The channel category takes the channel to watch, or 0 for all of them;
        // the others take none, and the server refuses one they do not know.
        await this.#register(category, category === "channel" ? 0 : undefined, { signal });
      }
      // Only worth listing when there is something to fill: the groups and the
      // invoker of a message this client would otherwise not know.
      if (eventCategories.length > 0) await this.#learnClients(signal);
    }
  }

  /**
   * Leave the server and close the connection.
   *
   * A `connect()` still in flight fails with a NotConnectedError, and so do
   * the commands still waiting for an answer. Resolves once `disconnected` has
   * been delivered, so a listener added after `await client.disconnect()` does
   * not hear it. Does nothing on a client that is not connected; called again
   * while an earlier call is still running, it waits for that one. An explicit
   * `disconnect()` never reconnects.
   */
  async disconnect(): Promise<void> {
    // Recorded before anything else: a transport that closes during the
    // teardown below must not be mistaken for an outage worth retrying.
    this.#stopped = true;
    this.#stopReconnecting?.abort();
    this.#generation++;

    if (this.#stopping !== undefined) return this.#stopping;
    if (this.#status === ClientStatus.Disconnected) return this.#disconnectedDelivered;

    this.#status = ClientStatus.Disconnected;
    const stopping = this.#teardown();
    this.#stopping = stopping;
    try {
      await stopping;
    } finally {
      this.#stopping = undefined;
    }
  }

  async #teardown(): Promise<void> {
    this.#logger.info("disconnecting from query server");
    const transport = this.#transport;
    this.#transport = null;
    // Set before the transport is closed, so the close it reports is not read
    // as the connection dropping.
    this.#closed = true;
    this.#fail(new NotConnectedError());
    await transport?.close().catch(() => {});
    // Announced here, with no cause: `disconnected` delivering `undefined` is
    // what says the client left on purpose.
    await this.#announceDisconnected(undefined, false);
  }

  /** `await using client = …` disconnects when the scope ends. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.disconnect();
  }

  // ---- Commands ------------------------------------------------------------

  /**
   * Send a typed command. Passwords go as they are: ServerQuery takes the
   * password itself and hashes it server-side, where the voice protocol wants
   * the hash.
   */
  send(
    request: CommandRequest,
    options: CommandOptions = {},
  ): Promise<Array<Record<string, string>>> {
    return this.#send(request, options);
  }

  /** Send a raw command line and return the rows that answer it. */
  exec(line: string, options: CommandOptions = {}): Promise<Array<Record<string, string>>> {
    const run = this.#queue.then(() => this.#execNow(line, options));
    // The queue moves on whatever this command's outcome.
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Log in with a query account. Over WebQuery the api key does this, and the
   * server refuses the command; over SSH the session is logged in already.
   *
   * Public because a caller driving the client by hand needs it: `connect()`
   * runs it from the tcp transport's `login` option, and this is the same `login` command.
   *
   * On TeamSpeak 3 a failed login gets the caller's IP address banned for 600
   * seconds, so a retry loop on a wrong password locks itself out of every
   * connection from that address.
   */
  async login(name: string, password: string, options: CommandOptions = {}): Promise<void> {
    await this.exec(
      buildCommandOrdered("login", [
        ["client_login_name", name],
        ["client_login_password", password],
      ]),
      options,
    );
  }

  /**
   * Log out of the server instance, which also deselects the virtual server:
   * commands that need a login or a server fail until `login` and `use` run
   * again. The connection stays open.
   *
   * Not served over WebQuery, whose api key is the login: the server refuses it
   * there (5120, command not in api key scope). A reconnect logs in again from
   * the `login` option.
   *
   * The client's own id and the roster it kept are cleared, as they belong to
   * the server that was left. `use` still selects a server afterwards, as a
   * client with no rights.
   */
  async logout(options: CommandOptions = {}): Promise<void> {
    await this.exec("logout", options);
    this.#forgetServer();
  }

  /**
   * Select the virtual server the following commands address, by id or by
   * voice port. `nickname` names the query client on it.
   *
   * Public for the same reason as {@link QueryClient.login}: `connect()` runs
   * it from the `server` option, and this is the same `use` command. Over
   * WebQuery the transport answers it, by addressing that server from then on.
   *
   * The connection becomes a client of the new server, with an id of its own,
   * so the client reads its id again and drops the roster it kept of the server
   * it was on; with events configured it lists the new server's clients, as
   * `connect()` does. Selecting the server the connection is already on
   * changes nothing, a new nickname included. A refusal leaves the connection
   * on no server, not on the one it was on: the id and the roster are cleared,
   * and the notifications registered are gone, so `use` again and
   * {@link QueryClient.registerNotifications} again.
   *
   * A reconnect starts over from the options the client was made with: it logs
   * in, selects `server` and registers `events` again, and does not repeat a
   * `use` made by hand.
   */
  async use(
    server: { readonly id: ServerID | number } | { readonly port: number },
    options: CommandOptions & { readonly nickname?: string | undefined } = {},
  ): Promise<void> {
    await this.#select(server, options);
    // The id and the roster serve the events, which a transport that delivers
    // none has no use for.
    if (!this.#notifications) return;
    await this.#learnSelf(options.signal);
    if (this.#options.eventCategories.length > 0) await this.#learnClients(options.signal);
  }

  /** The `use` command, and what it does to what the client knows. */
  async #select(
    server: { readonly id: ServerID | number } | { readonly port: number },
    options: CommandOptions & { readonly nickname?: string | undefined },
  ): Promise<void> {
    try {
      await this.exec(
        buildCommandOrdered("use", [
          "id" in server ? ["sid", String(server.id)] : ["port", String(server.port)],
          ...(options.nickname === undefined
            ? []
            : ([["client_nickname", options.nickname]] as const)),
        ]),
        options,
      );
    } catch (error) {
      if (error instanceof ServerError) this.#forgetServer();
      throw error;
    }
    this.#forgetServer();
  }

  /** What belongs to the server the connection was on: its own id and the clients seen there. */
  #forgetServer(): void {
    this.#clid = 0;
    this.#clients.clear();
  }

  /**
   * Ask the server for the notifications of one category: `server`, `channel`
   * (for one channel, or `0` for all), `textserver`, `textchannel`,
   * `textprivate`, and on TeamSpeak 6 `bans`.
   *
   * Public for the same reason as {@link QueryClient.login}: `connect()` runs
   * it once per configured category. With the WebQuery transport there is
   * nothing to register for and the server refuses it, so the client never
   * calls it there, and neither should a caller.
   *
   * Once the server has accepted it, the client lists the server's clients
   * again, as `connect()` does, so the events it fills from the roster are
   * filled. With no server selected the server refuses it (1024).
   */
  async registerNotifications(
    event: QueryEventCategory,
    channelID?: bigint | number,
    options: CommandOptions = {},
  ): Promise<void> {
    await this.#register(event, channelID, options);
    await this.#learnClients(options.signal);
  }

  async #register(
    event: QueryEventCategory,
    channelID: bigint | number | undefined,
    options: CommandOptions,
  ): Promise<void> {
    await this.exec(
      buildCommandOrdered("servernotifyregister", [
        ["event", event],
        ...(channelID === undefined ? [] : ([["id", String(channelID)]] as const)),
      ]),
      options,
    );
  }

  /**
   * Stop receiving the notifications of one category, or of every category
   * when none is named; the counterpart of {@link QueryClient.registerNotifications}.
   * `channelID` narrows `channel` to one channel, as it does there.
   *
   * The server accepts a category it does not know and does nothing. With the
   * WebQuery transport there is nothing registered and the server refuses it.
   * {@link QueryClient.eventCategories} keeps listing what `events` asked for,
   * and a reconnect registers those again.
   */
  async unregisterNotifications(
    event?: QueryEventCategory,
    channelID?: bigint | number,
    options: CommandOptions = {},
  ): Promise<void> {
    await this.exec(
      buildCommandOrdered("servernotifyunregister", [
        ...(event === undefined ? [] : ([["event", event]] as const)),
        ...(channelID === undefined ? [] : ([["id", String(channelID)]] as const)),
      ]),
      options,
    );
  }

  // ---- Events --------------------------------------------------------------

  /**
   * Listen for an event. Returns a function that removes the listener, which is
   * also a `Disposable` (`using stop = client.on(...)`).
   *
   * ```ts
   * client.on("textMessage", (message) => console.log(message.message));
   * ```
   *
   * A listener that throws does not stop the others: the rest of the event's
   * listeners, and the events after it, are still delivered, and the exception
   * is rethrown on its own, from a microtask, so it surfaces as an
   * `uncaughtException` just as an EventEmitter listener's would.
   *
   * With the WebQuery transport no server event can ever arrive, so this throws
   * a `TypeError` for one rather than accepting a listener that would never
   * run. `connected` and `disconnected` are still accepted: they come from the
   * client, not the server.
   */
  on<K extends keyof QueryEventMap>(event: K, listener: Listener<QueryEventMap, K>): Unsubscribe {
    if (this.#notifications === false && SERVER_EVENTS.has(event)) {
      throw new TypeError(
        `this transport delivers no notifications, so "${event}" cannot be listened for`,
      );
    }
    const subscription: Subscription = {
      listener: listener as (payload: unknown) => void,
      removed: false,
    };
    // A new array rather than an edit in place: a delivery may be iterating
    // over the old one.
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), subscription]);

    const unsubscribe = (): void => {
      if (subscription.removed) return;
      subscription.removed = true;
      const list = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        list.filter((s) => s !== subscription),
      );
    };
    return Object.assign(unsubscribe, { [Symbol.dispose]: unsubscribe });
  }

  /** Listen for the next occurrence of an event only. */
  once<K extends keyof QueryEventMap>(event: K, listener: Listener<QueryEventMap, K>): Unsubscribe {
    const unsubscribe = this.on(event, ((payload: QueryEventMap[K]) => {
      unsubscribe();
      listener(payload);
    }) as Listener<QueryEventMap, K>);
    return unsubscribe;
  }

  /**
   * An event as an async iterator, for `for await`:
   *
   * ```ts
   * for await (const message of client.events("textMessage")) { … }
   * ```
   *
   * Events that arrive while the loop body runs are buffered, so none is
   * missed. The buffer is unbounded: an iterator that is not consumed as fast
   * as events arrive holds every one of them, so stop iterating (or abort
   * `signal`) when you stop reading.
   *
   * Iteration ends when the loop exits early (`break`, `return`, a throw), and
   * — for every event but `disconnected` — when the client disconnects. When
   * `signal` aborts, listening stops at once, whatever is buffered is
   * discarded, and the pending and every later `next()` reject with the
   * signal's reason.
   */
  events<K extends keyof QueryEventMap>(
    event: K,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): AsyncIterableIterator<QueryEventMap[K]> {
    const { signal } = options;
    const buffered: Array<QueryEventMap[K]> = [];
    // The next() calls waiting for an event, oldest first.
    const waiting: Array<{
      resolve: (result: IteratorResult<QueryEventMap[K]>) => void;
      reject: (reason: unknown) => void;
    }> = [];
    let ended = false;
    let aborted = false;

    const finishWaiting = (): void => {
      for (const waiter of waiting.splice(0)) {
        waiter.resolve({ value: undefined, done: true });
      }
    };

    const stopListening = this.on(event, ((payload: QueryEventMap[K]) => {
      if (ended) return;
      const waiter = waiting.shift();
      if (waiter) {
        waiter.resolve({ value: payload, done: false });
        return;
      }
      buffered.push(payload);
    }) as Listener<QueryEventMap, K>);
    const stopOnDisconnect =
      event === "disconnected"
        ? undefined
        : this.on("disconnected", () => {
            cleanup();
            finishWaiting();
          });
    const cleanup = (): void => {
      ended = true;
      stopListening();
      stopOnDisconnect?.();
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      aborted = true;
      buffered.length = 0;
      cleanup();
      const reason = signal!.reason;
      for (const waiter of waiting.splice(0)) waiter.reject(reason);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const iterator: AsyncIterableIterator<QueryEventMap[K]> = {
      next(): Promise<IteratorResult<QueryEventMap[K]>> {
        if (aborted) return Promise.reject(signal!.reason);
        if (buffered.length > 0) return Promise.resolve({ value: buffered.shift()!, done: false });
        if (ended) {
          cleanup();
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
      },
      return(): Promise<IteratorResult<QueryEventMap[K]>> {
        buffered.length = 0;
        cleanup();
        finishWaiting();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  // ---- Private -------------------------------------------------------------

  /** Build and open the transport the options describe. */
  async #openTransport(signal: AbortSignal | undefined): Promise<QueryTransport> {
    const transport: ResolvedTransport = this.#options.transport;
    switch (transport.kind) {
      case "tcp":
        return connectTcp({
          host: transport.host,
          port: transport.port,
          connect: transport.connect,
          signal,
        });
      case "ssh":
        return connectSsh({ ...transport.connect, signal });
      case "web":
        return new WebQueryTransport({
          url: transport.url,
          ...(transport.apiKey === undefined ? { guest: true } : { apiKey: transport.apiKey }),
          fetch: transport.fetch,
          serverID: serverIDOf(this.#options.server),
        });
      case "custom":
        return transport.open(signal);
      default:
        // Every kind is handled above; a value from outside this module's
        // types would otherwise open nothing and hang the attempt.
        throw new TypeError(
          `unknown transport kind ${String((transport as { kind: unknown }).kind)}`,
        );
    }
  }

  /** The server's `version` string, and nothing else of the answer. */
  async #getVersion(signal: AbortSignal | undefined): Promise<string> {
    const rows = await this.exec("version", { signal });
    return rows[0]?.["version"] ?? "";
  }

  /**
   * Ask the server which client this connection is. A self-move names no
   * invoker, so without the id the client could not tell a move of its own
   * from any other.
   */
  async #learnSelf(signal: AbortSignal | undefined): Promise<void> {
    const rows = await this.exec("whoami", { signal });
    const id = Number(rows[0]?.["client_id"]);
    this.#clid = Number.isInteger(id) && id > 0 ? id : 0;
  }

  /**
   * List the clients once, so that `invokerGroups` and the invoker fields of a
   * self-move can be filled: an enter notification is only seen for clients
   * that arrive after registering, and the ones already there arrive as none.
   * `-away` and `-voice` make the records carry away and mute state as well,
   * in the same one command. The groups are as of this listing: a ServerQuery
   * connection is not sent `clientupdated`, so they do not follow later changes.
   */
  async #learnClients(signal: AbortSignal | undefined): Promise<void> {
    const rows = await this.exec("clientlist -uid -groups -away -voice", { signal }).catch(
      (error: unknown) => {
        // A registration that worked and a list that did not leaves the client
        // usable: a sender it has never seen simply has no known groups, which
        // the event type already allows for.
        this.#logger.warn("listing clients after registering failed", { error: String(error) });
        return [] as Array<Record<string, string>>;
      },
    );
    for (const row of rows) {
      handleNotification({ name: "notifycliententerview", params: row }, 0, this.#clients);
    }
  }

  async #execNow(line: string, options: CommandOptions): Promise<Array<Record<string, string>>> {
    const { signal, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = options;
    signal?.throwIfAborted();
    if (this.#closed || this.#transport === null) throw new NotConnectedError();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let nudger: ReturnType<typeof setTimeout> | undefined;
    let nudgerStopped = false;
    let onAbort: (() => void) | undefined;
    const answered = new Promise<Array<Record<string, string>>>((resolve, reject) => {
      this.#pending = { command: parseCommand(line)?.name ?? "", rows: [], resolve, reject };
      timer = setTimeout(
        () => reject(new CommandTimeoutError(parseCommand(line)?.name ?? "")),
        timeoutMs,
      );
      onAbort = () => reject(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The answer may settle while the transport is still sending, as it does
    // when a send carries the whole round trip (WebQuery); a failure of the
    // send first would otherwise leave this rejection unhandled.
    answered.catch(() => {});
    const sending = { failed: false };
    let abandonedByUs = false;
    const transport = this.#transport;
    const nudges = this.#options.transport.kind === "ssh";
    const send = transport.send(line).then(
      () => {
        // On TeamSpeak 6 over SSH the server may hold back the last line of a
        // reply, usually `error id=0 msg=ok`, until the client writes again;
        // an empty line releases it and gets no answer of its own. This was
        // measured on TeamSpeak 6 (about one command in a thousand under load,
        // mostly with notifications registered), and only on SSH: raw TCP and
        // WebQuery do not show it. So once the command has waited 2 seconds,
        // and every second after, an empty line is written, until its answer
        // arrives or it ends by timeout, cancel or close (`finally` below).
        if (!nudges || nudgerStopped) return;
        const nudge = (): void => {
          nudger = setTimeout(nudge, SSH_NUDGE_EVERY_MS);
          transport.send("").catch(() => {});
        };
        nudger = setTimeout(nudge, SSH_NUDGE_AFTER_MS);
      },
      (error: unknown) => {
        // A send that fails after the command gave up will not be answered.
        if (abandonedByUs) this.#abandoned--;
        sending.failed = true;
        throw error;
      },
    );
    try {
      await Promise.race([send, answered]);
      return await answered;
    } finally {
      clearTimeout(timer);
      nudgerStopped = true;
      clearTimeout(nudger);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (this.#pending !== null) {
        this.#pending = null;
        if (!sending.failed) {
          this.#abandoned++;
          abandonedByUs = true;
        }
      }
    }
  }

  #handleLine(line: string): void {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) return;
    const cmd = parseCommand(trimmed);
    if (!cmd) return;

    if (cmd.name === "error") {
      if (this.#abandoned > 0) {
        this.#abandoned--;
        return;
      }
      const pending = this.#pending;
      this.#pending = null;
      if (!pending) return;
      const { err } = parseServerError(cmd.params);
      const refusal = err ?? transferRefusal(pending.command, pending.rows);
      if (refusal) pending.reject(refusal);
      else pending.resolve(pending.rows);
      return;
    }
    if (cmd.name.startsWith("notify")) {
      // A notification is never part of an answer.
      for (const row of splitRows(trimmed)) {
        const parsed = parseCommand(row);
        if (parsed) this.#notification(parsed.name, parsed.params);
      }
      return;
    }
    if (this.#abandoned > 0) return;
    for (const row of splitRows(trimmed)) {
      const parsed = parseCommand(row);
      if (parsed) this.#pending?.rows.push(parsed.params);
    }
  }

  /** Turn one notification into the core's events, then report it as it arrived. */
  #notification(name: string, params: Record<string, string>): void {
    const result = handleNotification({ name, params }, this.#clid, this.#clients);
    switch (result.kind) {
      case "clientEnter":
        this.#emit("clientEnter", result.info);
        break;
      case "clientLeave":
        this.#emit("clientLeave", result.event);
        // A query client is never kicked from the server, but a ban or a
        // server stopping reaches it as a leave of its own: the same two
        // reasons the voice client reads.
        if (
          result.isSelf &&
          (result.event.reason === Reason.KickServer ||
            result.event.reason === Reason.KickServerBan)
        ) {
          this.#emit("kicked", kickedEvent(result.event));
        }
        break;
      case "clientMoved":
        this.#emit("clientMoved", result.event);
        // A channel kick moves the client to the default channel, so it
        // arrives as a move of its own, not as leaving view.
        if (
          this.#clid !== 0 &&
          result.event.clientID === this.#clid &&
          result.event.reason === Reason.KickChannel
        ) {
          this.#emit("kicked", kickedEvent(result.event));
        }
        break;
      case "textMessage":
        this.#emit("textMessage", result.message);
        break;
      case "channelCreated":
        this.#emit("channelCreated", result.event);
        break;
      case "channelEdited":
        this.#emit("channelEdited", result.event);
        break;
      case "channelMoved":
        this.#emit("channelMoved", result.event);
        break;
      case "channelDeleted":
        this.#emit("channelDeleted", result.event);
        break;
      case "channelDescriptionChanged":
        this.#emit("channelDescriptionChanged", result.event);
        break;
      case "channelPasswordChanged":
        this.#emit("channelPasswordChanged", result.event);
        break;
      case "serverEdited":
        this.#emit("serverEdited", result.event);
        break;
      case "clientUpdated":
      case "clientServerGroupAdded":
      case "clientServerGroupRemoved":
      case "clientChannelGroupChanged":
      case "channelSubscribed":
      case "channelUnsubscribed":
      case "pluginCommand":
      case "clientChatComposing":
      case "clientChatClosed":
      // Neither a TeamSpeak 3 ServerQuery connection nor a TeamSpeak 6 one over
      // SSH is sent these (measured), so a query client does not offer them.
      // Should a server send one, the clients it knows are still kept current
      // by the core; `notification` has it.
      case "poked":
      case "unknown":
        // A query client is never poked, and anything else is not an event the
        // core models; `notification` still carries it.
        break;
    }
    // After any event it produced, as the voice client sends it. A listener's
    // failure is its own: it must not stop the answer being read.
    if (this.#listeners.get("notification")?.length) {
      this.#emit("notification", { name, params: { ...params } });
    }
  }

  #emit<K extends keyof QueryEventMap>(event: K, payload: QueryEventMap[K]): void {
    for (const subscription of this.#listeners.get(event) ?? []) {
      // Checked at delivery: a listener removed while its event was queued
      // does not get it.
      if (subscription.removed) continue;
      try {
        subscription.listener(payload);
      } catch (error) {
        // Rethrown on its own, so it surfaces as an uncaught exception rather
        // than breaking the listeners after it.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  #fail(error: unknown): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error);
  }

  #handleClose(error: Error | undefined): void {
    if (this.#status === ClientStatus.Disconnected) return;
    this.#transport = null;
    this.#closed = true;
    this.#fail(new NotConnectedError(error ? { cause: error } : undefined));
    const wasConnected = this.#status === ClientStatus.Connected;
    this.#status = ClientStatus.Disconnected;
    if (!wasConnected) {
      // The transport closed while the session was being set up, so this is
      // the attempt failing rather than a live connection dropping. The
      // attempt's own command rejects, and `connect()` rejects with it.
      return;
    }
    this.#lastDrop = error ?? new TeamspeakError("connection closed");
    // Announced first, then retried: a caller watching `disconnected` should
    // hear about the drop even when a reconnect is already on its way, because
    // a silent recovery hides an outage.
    void this.#announceDisconnected(
      this.#lastDrop,
      this.#willReconnect(this.#lastDrop, this.#loopAttempt + 1),
    );
    this.#scheduleReconnect(this.#lastDrop).catch((failure: unknown) => {
      this.#logger.error("reconnecting failed", { error: String(failure) });
    });
  }

  /**
   * A connection attempt has failed for good. The transport it opened is
   * closed, so a later `connect()` starts from nothing.
   *
   * A `connect()` the caller made is theirs to see rejected, and is not
   * announced as a disconnection. An attempt of the reconnect loop is: the
   * caller hears the loop's own answer, so that a loop which has given up says
   * so instead of only ever having reported the drop that started it.
   */
  #failConnection(error: unknown): void {
    if (this.#status === ClientStatus.Connected) return;
    this.#status = ClientStatus.Disconnected;
    this.#closed = true;
    // The cause is reported as it is, not wrapped: a misuse of the options,
    // such as asking for events a transport cannot deliver, must stay the
    // TypeError it is.
    this.#fail(error);
    const transport = this.#transport;
    this.#transport = null;
    void transport?.close().catch(() => {});
    if (!this.#reconnecting) return;
    const cause =
      error instanceof Error ? error : new TeamspeakError(String(error), { cause: error });
    void this.#announceDisconnected(cause, this.#willReconnect(cause, this.#loopAttempt + 1));
  }

  #announceDisconnected(cause: Error | undefined, willReconnect: boolean): Promise<void> {
    let resolve!: () => void;
    const delivered = new Promise<void>((r) => (resolve = r));
    try {
      this.#emit("disconnected", { error: cause, willReconnect });
    } finally {
      resolve();
    }
    this.#disconnectedDelivered = delivered;
    void delivered.then(() => {
      if (this.#disconnectedDelivered === delivered) this.#disconnectedDelivered = undefined;
    });
    return delivered;
  }

  /**
   * Whether the reconnect loop will make attempt number `attempt` after `err`.
   * `disconnected` reports it, and the loop acts on the same answer: the
   * caller's `shouldRetry` is asked once per failure, not once to announce it
   * and again to act on it.
   */
  #willReconnect(err: Error, attempt: number): boolean {
    const options = this.#reconnectOptions;
    if (options === undefined || this.#stopped) return false;
    const { maxAttempts } = resolveBackoffPolicy(options);
    if (maxAttempts !== 0 && attempt > maxAttempts) return false;
    const asked = this.#retryAnswer;
    if (asked?.err === err && asked.attempt === attempt) return asked.retry;
    let retry: boolean;
    let threw = false;
    try {
      retry = (options.shouldRetry ?? defaultShouldRetry)(err, attempt);
    } catch (failure) {
      this.#logger.error("shouldRetry threw; not reconnecting", { error: String(failure) });
      retry = false;
      threw = true;
    }
    this.#retryAnswer = { err, attempt, retry, threw };
    return retry;
  }

  /**
   * Retry a dropped connection according to the reconnect policy: every
   * attempt re-opens the transport and reruns the whole setup, `login` and
   * `use` included.
   *
   * A refused `login` or `use` ends the loop, through the default
   * `shouldRetry`: the credentials or the target are wrong, and the same ones
   * fail the same way. Retrying them is also what turns a dropped connection
   * into a ban, since those are the two commands that reach the flood limit
   * fastest.
   *
   * Never runs after an explicit `disconnect()`, and never more than one at a
   * time: two failures in quick succession would otherwise start competing
   * loops, and a loop shorter than the server's antiflood window bans the IP
   * rather than reconnecting it. A drop while the loop runs is the loop's to
   * retry: it ends only once its attempt is still connected when it resumes.
   */
  async #scheduleReconnect(err: Error): Promise<void> {
    const options = this.#reconnectOptions;
    if (options === undefined || this.#stopped || this.#reconnecting) return;

    const policy = resolveBackoffPolicy(options);
    this.#reconnecting = true;
    const stop = new AbortController();
    this.#stopReconnecting = stop;
    try {
      for (let attempt = 1; policy.maxAttempts === 0 || attempt <= policy.maxAttempts; attempt++) {
        if (this.#stopped) return;
        if (!this.#willReconnect(err, attempt)) {
          if (!this.#retryAnswer?.threw) {
            this.#logger.info("not retrying", { attempt, reason: err.message });
          }
          return;
        }

        const delay = backoffDelay(policy, attempt);
        this.#logger.info("reconnecting", { attempt, delayMs: delay });
        // A timer that keeps the process alive: an application that does
        // nothing but stay connected would otherwise exit during the wait.
        await sleep(delay, stop.signal);
        if (this.#stopped) return;
        // Connected, or connecting, by hand during the wait: nothing is left
        // to retry, and an attempt now would only fail with
        // AlreadyConnectedError.
        if (this.#status !== ClientStatus.Disconnected) return;

        this.#loopAttempt = attempt;
        try {
          await this.#connect({ signal: AbortSignal.timeout(RECONNECT_ATTEMPT_TIMEOUT_MS) }, true);
          // Read through the getter: the status may have changed while
          // connect() resolved, which the field's narrowing would not see.
          if (this.status === ClientStatus.Connected) {
            this.#logger.info("reconnected", { attempt });
            return;
          }
          // The new session dropped before this loop resumed. That drop found
          // this loop running and left the retrying to it.
          err = this.#lastDrop ?? new TeamspeakError("connection closed");
        } catch (retryErr) {
          if (retryErr instanceof AlreadyConnectedError) return;
          err =
            retryErr instanceof Error
              ? retryErr
              : new TeamspeakError(String(retryErr), { cause: retryErr });
        }
      }
      this.#logger.warn("reconnect attempts exhausted", { attempts: policy.maxAttempts });
    } finally {
      this.#reconnecting = false;
      this.#loopAttempt = 0;
      if (this.#stopReconnecting === stop) this.#stopReconnecting = undefined;
    }
  }
}

/**
 * The core's server events. A transport with no notifications cannot deliver
 * any of them, so a listener for one on such a client could never run.
 */
const SERVER_EVENTS: ReadonlySet<string> = new Set([
  "textMessage",
  "clientEnter",
  "clientLeave",
  "clientMoved",
  "channelCreated",
  "channelEdited",
  "channelMoved",
  "channelDeleted",
  "channelDescriptionChanged",
  "channelPasswordChanged",
  "serverEdited",
  "notification",
  "kicked",
]);

function kickedEvent(event: {
  readonly reason: number;
  readonly reasonMessage: string;
  readonly invokerName: string;
  readonly invokerUID: string;
  readonly invokerID: number;
}): KickedEvent {
  return {
    reason: event.reason,
    reasonMessage: event.reasonMessage,
    invokerName: event.invokerName,
    invokerUID: event.invokerUID as KickedEvent["invokerUID"],
    invokerID: event.invokerID as KickedEvent["invokerID"],
  };
}

/** The server id a WebQuery transport addresses, from the `server` option. */
function serverIDOf(server: ResolvedQueryOptions["server"]): ServerID | number | undefined {
  return server !== undefined && "id" in server ? server.id : undefined;
}

/** Sleep, or wake early once `signal` aborts. Resolves either way, never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * The rows of a line, which ServerQuery separates with `|`.
 *
 * Every row carries all its fields, so rows are not completed from the row
 * before as the voice protocol's are; a `|` inside a value is escaped (`\p`),
 * so splitting on it is exact. A notification's name is repeated on each row.
 */
function splitRows(line: string): string[] {
  const space = line.indexOf(" ");
  const head = space < 0 ? line : line.slice(0, space);
  const named = /^[A-Za-z0-9]+$/.test(head);
  const rest = named ? (space < 0 ? "" : line.slice(space + 1)) : line;
  const prefix = named ? `${head} ` : "";
  return rest
    .split("|")
    .filter((row) => row !== "")
    .map((row) => prefix + row);
}

/**
 * The refusal a file transfer negotiation reports inside a successful answer.
 *
 * `ftinitupload` and `ftinitdownload` answer `error id=0` even when they
 * refuse, and say so in the row instead: `clientftfid=2 status=2058
 * msg=file\sis\sin\suse`, with no `ftkey`. Left as it is, the typed command
 * would find no key and report that the server sent no data, losing the
 * reason; this turns the row into the server error it is.
 */
function transferRefusal(
  command: string,
  rows: ReadonlyArray<Record<string, string>>,
): ServerError | undefined {
  if (command !== "ftinitupload" && command !== "ftinitdownload") return undefined;
  const row = rows[0];
  if (row === undefined || row["ftkey"] !== undefined) return undefined;
  const status = Number(row["status"]);
  if (!Number.isInteger(status) || status === 0) return undefined;
  return new ServerError(status, row["msg"] ?? "");
}
