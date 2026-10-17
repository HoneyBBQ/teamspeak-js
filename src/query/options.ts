import type { CommandMiddleware, Logger, ReconnectOptions, ServerID } from "@honeybbq/teamspeak";
import type { QueryTransport } from "./transport.js";
import type { TcpConnector } from "./tcp.js";
import { hostKeyDecision } from "./ssh.js";
import type { SshConnectOptions, SshConnection } from "./ssh.js";
import type { WebCredentials } from "./web.js";

/**
 * The connection a `QueryClient` talks over, as a description rather than an
 * open transport: the client builds one from it on every connection, so a
 * reconnect is the same connection as the first one was.
 *
 * `custom` is the escape hatch for anything the three built-in kinds do not
 * cover — a proxy, a tunnel, a test double — and is the only one that cannot
 * be rebuilt from data alone: it is called again for each attempt.
 */
export type QueryTransportOptions =
  | {
      /** A raw ServerQuery connection. TeamSpeak 3 only: TS6 dropped it. */
      readonly kind: "tcp";
      /** The server's host. */
      readonly host: string;
      /** The raw query port; 10011 by default. */
      readonly port?: number | undefined;
      /**
       * Opens the connection; `net.createConnection` by default. See
       * {@link TcpOptions.connect}.
       */
      readonly connect?: TcpConnector | undefined;
    }
  | ({
      /**
       * A ServerQuery over SSH. On TeamSpeak 6 a server may hold back the end
       * of a reply until the client writes again; this transport handles that
       * itself, by writing an empty line while a command waits.
       */
      readonly kind: "ssh";
    } & SshConnectOptions)
  | ({
      /** TeamSpeak 6's HTTP WebQuery. */
      readonly kind: "web";
      /** The server's base URL, such as `http://127.0.0.1:10080`. */
      readonly url: string;
      /** The `fetch` to use; a small one over `node:http` by default. */
      readonly fetch?: typeof fetch | undefined;
    } & WebCredentials)
  | {
      /** An application-supplied transport. */
      readonly kind: "custom";
      /**
       * Open the transport. Called once per connection attempt, with the
       * signal that abandons that attempt; a transport that ignores it is
       * abandoned all the same.
       */
      readonly open: (signal?: AbortSignal) => Promise<QueryTransport>;
    };

/**
 * One category of notifications to register for: the `event` parameter of
 * `servernotifyregister`.
 *
 * `bans` is not registered by default: TeamSpeak 3 refuses it with 1539,
 * which would fail the registration of every category after it.
 */
export type QueryEventCategory =
  | "server"
  | "channel"
  | "textserver"
  | "textchannel"
  | "textprivate"
  | "bans";

/**
 * Which notification categories to register for.
 *
 * `true` (the default) registers the ones raw TCP and SSH both accept;
 * `{ categories }` names them; `false` registers nothing. This says nothing
 * about whether the transport can deliver notifications — a transport
 * declares that itself, see {@link QueryTransport.supportsNotifications} — so
 * asking for categories on one that cannot is an error rather than a silent
 * no-op.
 *
 * What each category delivers, as events of the client (measured on TeamSpeak 3
 * over raw TCP and TeamSpeak 6 over SSH, which agree):
 *
 * | Category                                | Events                                                                                                                                      |
 * | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `server`                                | `serverEdited`                                                                                                                              |
 * | `channel` (registered for every channel) | `channelCreated`, `channelEdited`, `channelMoved`, `channelDeleted`, `channelDescriptionChanged`, `channelPasswordChanged`, `clientEnter`, `clientLeave`, `clientMoved` |
 * | `textserver`, `textchannel`, `textprivate` | `textMessage`, for the server, the channel and private messages                                                                         |
 * | `bans`                                  | none                                                                                                                                        |
 *
 * Leaving a category out leaves its events out: `{ categories: ["textprivate"] }`
 * delivers no channel event. The voice client's events about clients' updates,
 * group changes, subscriptions, plugin commands and typing are not sent to a
 * ServerQuery connection by either server, so this client does not offer them.
 */
export type QueryEventsOption = boolean | { readonly categories?: readonly QueryEventCategory[] };

/** How a `QueryClient` connects, logs and behaves. */
export interface QueryClientOptions {
  /** How to reach the server. Required: a client cannot connect without one. */
  readonly transport: QueryTransportOptions;
  /**
   * The query account to log in as, sent as a `login` command after the
   * transport is opened. Raw TCP only: SSH logs in as the session's account,
   * and WebQuery's api key is the login, so giving this with either throws.
   */
  readonly login?: { readonly name: string; readonly password: string } | undefined;
  /**
   * The virtual server to select with `use`, by id or by voice port. Over
   * WebQuery the transport answers `use` itself, by addressing that server in
   * its requests. Unset leaves the instance selected on raw TCP, where the
   * server's own default applies.
   */
  readonly server?: { readonly id: ServerID | number } | { readonly port: number } | undefined;
  /** The query client's nickname on the server (`client_nickname` of `use`). */
  readonly nickname?: string | undefined;
  /**
   * Register for server notifications: `true` (the default) for the five
   * categories raw TCP and SSH both accept, `{ categories }` to name them, or
   * `false` for none. See {@link QueryEventsOption}.
   *
   * Registering for anything on a transport that cannot deliver notifications
   * throws a `TypeError`, at construction when the `transport` kind says so
   * and when connecting for a `custom` transport.
   */
  readonly events?: QueryEventsOption | undefined;
  /**
   * Reconnect after a dropped connection. Off by default, as for the voice
   * client, and a deliberate `disconnect()` never reconnects. The retry
   * decision is {@link defaultShouldRetry}.
   */
  readonly reconnect?: ReconnectOptions | undefined;
  /**
   * Wraps every typed command, outermost first; see `CommandMiddleware`. Raw
   * lines sent with `exec` do not pass through it. Fixed for the client's life.
   */
  readonly commandMiddleware?: readonly CommandMiddleware[] | undefined;
  /** Where the client logs. Silent unless set. */
  readonly logger?: Logger | undefined;
}

/** The five categories both raw TCP on TS3 and SSH on TS6 accept. */
export const DEFAULT_EVENT_CATEGORIES: readonly QueryEventCategory[] = Object.freeze([
  "server",
  "channel",
  "textserver",
  "textchannel",
  "textprivate",
]);

/** The kinds whose own handshake is the login, so there is no `login` to send. */
const LOGIN_HANDLED_BY_TRANSPORT: ReadonlySet<ResolvedTransport["kind"]> = new Set(["ssh", "web"]);

const CATEGORIES: ReadonlySet<string> = new Set([
  "server",
  "channel",
  "textserver",
  "textchannel",
  "textprivate",
  "bans",
]);

/** A transport with its defaults filled, and its fields copied. */
export type ResolvedTransport =
  | {
      readonly kind: "tcp";
      readonly host: string;
      readonly port: number;
      readonly connect: TcpConnector | undefined;
    }
  | {
      readonly kind: "ssh";
      /** What `connectSsh` is given, with the port filled in; one arm of {@link SshConnectOptions}. */
      readonly connect: SshConnectOptions;
    }
  | {
      readonly kind: "web";
      readonly url: string;
      /** Absent exactly for a guest connection, which sends no api key. */
      readonly apiKey: string | undefined;
      readonly fetch: typeof fetch | undefined;
    }
  | { readonly kind: "custom"; readonly open: (signal?: AbortSignal) => Promise<QueryTransport> };

/** Options with their defaults filled and their fields copied. */
export interface ResolvedQueryOptions {
  readonly transport: ResolvedTransport;
  readonly login: { readonly name: string; readonly password: string } | undefined;
  readonly server: { readonly id: ServerID | number } | { readonly port: number } | undefined;
  readonly nickname: string | undefined;
  /** The categories the caller asked to register for; `events: false` leaves this empty. */
  readonly eventCategories: readonly QueryEventCategory[];
  /**
   * Whether the transport the options name can deliver notifications. False
   * for `web`; `undefined` for `custom`, whose transport object does not exist
   * until it is opened, and which is checked then.
   */
  readonly notificationsSupported: boolean | undefined;
  /**
   * Whether the caller named `events` at all, whatever its value. On a
   * transport that cannot deliver notifications, naming it is the mistake to
   * report; leaving it unset is not.
   */
  readonly eventsRequested: boolean;
  readonly reconnect: ReconnectOptions | undefined;
  readonly commandMiddleware: readonly CommandMiddleware[] | undefined;
  readonly logger: Logger | undefined;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} is a non-empty string`);
  }
  return value;
}

/** `guest` is `true` or left out: it is a decision, not a switch to set to false. */
function guestFlag(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== true) {
    throw new TypeError("transport.guest is `true` or left out: it is a decision, not a switch");
  }
  return true;
}

/**
 * The SSH login: a name and a password, or `guest` alone. Without `guest`,
 * missing credentials are an error rather than a guest connection.
 */
function sshCredentials(
  options: Record<string, unknown>,
): { username: string; password: string } | { guest: true } {
  if (guestFlag(options["guest"])) {
    if (options["username"] !== undefined || options["password"] !== undefined) {
      throw new TypeError(
        "transport.username and transport.password were given with transport.guest; a guest logs in as `guest` with no password",
      );
    }
    return { guest: true };
  }
  const missing = (name: string): string =>
    `transport.${name} is a non-empty string; to connect without a login, as a guest, set transport.guest to true`;
  const { username, password } = options;
  if (typeof username !== "string" || username === "") throw new TypeError(missing("username"));
  if (typeof password !== "string" || password === "") throw new TypeError(missing("password"));
  return { username, password };
}

function port(value: unknown, name: string): number {
  if (value === undefined) return -1; // replaced by the caller's default
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new RangeError(`${name} is an integer port from 1 to 65535`);
  }
  return value;
}

function transportOptions(transport: unknown): ResolvedTransport {
  if (typeof transport !== "object" || transport === null) {
    throw new TypeError("transport is an object");
  }
  const options = transport as Record<string, unknown>;
  switch (options["kind"]) {
    case "tcp": {
      const host = nonEmpty(options["host"], "transport.host");
      const raw = port(options["port"], "transport.port");
      const connect = options["connect"];
      if (connect !== undefined && typeof connect !== "function") {
        throw new TypeError("transport.connect is a function");
      }
      return {
        kind: "tcp",
        host,
        port: raw < 0 ? 10011 : raw,
        connect: connect as TcpConnector | undefined,
      };
    }
    case "ssh": {
      const host = nonEmpty(options["host"], "transport.host");
      const raw = port(options["port"], "transport.port");
      const connection = options["connection"];
      if (
        connection !== undefined &&
        typeof connection !== "function" &&
        (typeof connection !== "object" || connection === null)
      ) {
        throw new TypeError("transport.connection is an SSH client or a factory for one");
      }
      // Asked here as well as when connecting: a client that could never
      // connect, for want of a decision about the host key, is the caller's
      // mistake and is reported when the client is made.
      const decision = hostKeyDecision(options);
      const address = { host, port: raw < 0 ? 10022 : raw };
      // Built from the decision rather than copied, so each arm is made of
      // exactly what it takes and the union needs no cast.
      if (decision.kind === "connection") {
        return {
          kind: "ssh",
          connect: { ...address, connection: connection as SshConnection },
        };
      }
      const login = {
        ...address,
        ...sshCredentials(options),
      };
      switch (decision.kind) {
        case "verifier":
          return { kind: "ssh", connect: { ...login, hostKey: decision.verify } };
        case "knownHosts":
          return { kind: "ssh", connect: { ...login, knownHosts: decision.path } };
        case "insecure":
          return { kind: "ssh", connect: { ...login, insecureIgnoreHostKey: true } };
      }
    }
    case "web": {
      const fetchFn: unknown = options["fetch"];
      if (fetchFn !== undefined && typeof fetchFn !== "function") {
        throw new TypeError("transport.fetch is a function");
      }
      const url = nonEmpty(options["url"], "transport.url");
      const guest = guestFlag(options["guest"]);
      const apiKey = options["apiKey"];
      if (guest) {
        if (apiKey !== undefined) {
          throw new TypeError(
            "transport.apiKey and transport.guest were given together; a guest sends no api key",
          );
        }
      } else if (typeof apiKey !== "string" || apiKey === "") {
        throw new TypeError(
          "transport.apiKey is a non-empty string; to connect without one, as a guest, set transport.guest to true",
        );
      }
      return {
        kind: "web",
        url,
        apiKey: guest ? undefined : apiKey,
        fetch: fetchFn as typeof globalThis.fetch | undefined,
      };
    }
    case "custom": {
      const open = options["open"];
      if (typeof open !== "function") throw new TypeError("transport.open is a function");
      return {
        kind: "custom",
        open: open as (signal?: AbortSignal) => Promise<QueryTransport>,
      };
    }
    default:
      throw new TypeError('transport.kind is one of "tcp", "ssh", "web" or "custom"');
  }
}

/**
 * The categories to register for. These are a wish, not a capability: whether
 * the transport can deliver a notification is its own to report, and a request
 * on one that cannot is the caller's mistake, reported by
 * {@link assertEventsSupported}.
 */
function eventCategories(events: QueryEventsOption | undefined): readonly QueryEventCategory[] {
  if (events === false) return [];
  if (events === undefined || events === true) return DEFAULT_EVENT_CATEGORIES;
  if (typeof events !== "object" || events === null) {
    throw new TypeError("events is a boolean or { categories }");
  }
  const categories = events.categories ?? DEFAULT_EVENT_CATEGORIES;
  if (!Array.isArray(categories)) throw new TypeError("events.categories is an array");
  for (const category of categories) {
    if (typeof category !== "string" || !CATEGORIES.has(category)) {
      throw new TypeError(`events.categories has an unknown category ${JSON.stringify(category)}`);
    }
  }
  return [...categories] as readonly QueryEventCategory[];
}

/**
 * Refuse a request to register on a transport that cannot deliver what it
 * would register for.
 *
 * WebQuery refuses `servernotifyregister` with 5120, and a listener that can
 * never run is worse than an error: the caller would be left believing the
 * server had nothing to say. Naming `events` at all is the mistake, even as
 * `false`, since it says the caller read the option as a capability.
 */
export function assertEventsSupported(resolved: ResolvedQueryOptions): void {
  if (resolved.notificationsSupported !== false || !resolved.eventsRequested) return;
  throw new TypeError("this transport delivers no notifications, so `events` cannot be set");
}

/**
 * Check the options and fill in the defaults, once, when the client is made:
 * an option that cannot be one is a bug in the caller's code, and is worth
 * hearing about before a connection is attempted.
 */
export function normalizeQueryOptions(options: QueryClientOptions): ResolvedQueryOptions {
  const transport = transportOptions(options.transport);
  const login = options.login;
  if (login !== undefined && typeof login !== "object") {
    throw new TypeError("login is { name, password }");
  }
  const server = options.server;
  if (server !== undefined) {
    if (typeof server !== "object" || server === null) {
      throw new TypeError("server is { id } or { port }");
    }
    const byID = "id" in server;
    const raw = byID ? server.id : server.port;
    const value = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`server.${byID ? "id" : "port"} is a non-negative integer`);
    }
    // A port names a virtual server's voice port, which is 1 to 65535; an id
    // is a server's own number, which starts at 1 and has no ceiling here.
    if (!byID && (value < 1 || value > 65535)) {
      throw new RangeError("server.port is an integer from 1 to 65535");
    }
  }
  const nickname = options.nickname;
  if (nickname !== undefined) nonEmpty(nickname, "nickname");
  const commandMiddleware = options.commandMiddleware;
  if (commandMiddleware !== undefined && !Array.isArray(commandMiddleware)) {
    throw new TypeError("commandMiddleware is an array");
  }
  if (login !== undefined && LOGIN_HANDLED_BY_TRANSPORT.has(transport.kind)) {
    // The SSH session is the query account already, and WebQuery's api key is
    // the login; neither leaves a `login` to send, and the server refuses the
    // command on both. A silently dropped option would leave the caller
    // believing they had logged in.
    throw new TypeError(
      `login is not sent over the ${transport.kind} transport, which logs in by itself`,
    );
  }

  const resolved: ResolvedQueryOptions = {
    transport,
    // Kept for `custom` too: its opener is the caller's, and most of them wrap
    // one of the built-in transports, `tcp` among them.
    login: login === undefined ? undefined : { ...login },
    server: server === undefined ? undefined : { ...server },
    nickname,
    eventCategories: eventCategories(options.events),
    // `web` is the only kind whose capability is known before it is opened.
    notificationsSupported: transport.kind === "custom" ? undefined : transport.kind !== "web",
    eventsRequested: options.events !== undefined,
    reconnect: options.reconnect,
    commandMiddleware,
    logger: options.logger,
  };
  assertEventsSupported(resolved);
  return resolved;
}
