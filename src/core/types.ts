import type { ClientFileTransferID, ServerFileTransferID } from "./command/ids.js";
import type { CommandExecutor } from "./command/request.js";

// ---- Client version -----------------------------------------------------------

/**
 * A client build a server accepts: the platform and version string a client
 * sends in `clientinit`, and the signature TeamSpeak made over them.
 *
 * The signature is Ed25519 over the ASCII bytes of `platform` followed by
 * `version`, base64 encoded. It cannot be made, only reused, so the values
 * that work are the ones in `@honeybbq/teamspeak/versions`. The server checks
 * the signature and refuses a build below its configured minimum.
 */
export interface ClientVersion {
  /** The `client_platform` sent, such as `"Windows"`, `"Linux"` or `"Android"`. */
  readonly platform: string;
  /** The `client_version` sent, with its build, such as `"3.6.2 [Build: 1695203293]"`. */
  readonly version: string;
  /** Base64 of the 64-byte signature over `platform + version`. */
  readonly sign: string;
}

// ---- Middleware types --------------------------------------------------------

/**
 * Wraps the typed command layer, outermost first: it sees each request — the
 * command's name and its parameters, passwords still in plain text — with its
 * options, and returns the rows that answer it, or throws. So it can observe,
 * time, retry, or answer a command itself without sending it.
 *
 * It wraps `send` rather than the interface — its type names that one method,
 * `CommandExecutor["send"]` — so `send` is the whole seam between a client
 * and a middleware.
 *
 * Only the typed commands, which reach the client through `send`, pass
 * through it. Raw lines sent with `exec` or `execNoWait` and the client's own
 * commands do not; those pass a {@link LineMiddleware} instead. A request's parameters can hold passwords
 * and privilege keys, so a middleware must not log them whole.
 */
export type CommandMiddleware = (next: CommandExecutor["send"]) => CommandExecutor["send"];

/** One command line on its way to the server. */
export interface CommandLine {
  /** The command's name, such as `clientupdate`. */
  readonly name: string;
  /**
   * The line as it goes on the wire, escaped, without the `return_code` the
   * client adds. It can carry secrets (channel password hashes, privilege
   * keys, a ServerQuery login): do not log it.
   */
  readonly text: string;
}

/** What a line middleware is told about the command it passes on. */
export interface LineOptions {
  /**
   * Aborts when the caller's own signal does, when the command's timeout
   * runs out, and when the client disconnects or the connection drops. A
   * middleware that waits must stop waiting then; the call rejects with the
   * signal's reason either way.
   */
  readonly signal: AbortSignal;
}

/**
 * Sends one command line and returns the rows that answer it, or throws.
 * The base of a chain writes the line to the connection; each
 * {@link LineMiddleware} wraps the next.
 */
export type LineSender = (
  line: CommandLine,
  options: LineOptions,
) => Promise<Array<Record<string, string>>>;

/**
 * Wraps the sending of every command line, so it can hold a line back, send
 * it more than once, or watch it go. This is where a bot paces its commands
 * against the server's flood limit: the client never does so itself. See
 * `docs/flood-control.md`.
 *
 * It sits closest to the wire. A typed command passes the command middleware
 * and has its channel passwords encoded first; a raw line from `exec` enters
 * here directly, and so do the client's own commands (on the voice client
 * `setconnectioninfo` and what streams, avatars and file transfers send; on
 * ServerQuery `login`, `use`, `version` and the rest of `connect()`). Not
 * passed: the voice handshake's own lines (`clientinit`, `clientinitiv`,
 * `clientek`), which go out before a session exists, and the goodbye of
 * `disconnect()` (`clientdisconnect`, or the ServerQuery `quit`), which must
 * leave at once or the server keeps the session (measured: error 521 for the
 * next connection).
 *
 * `next` may be called more than once: each call is a new command to the
 * server, with a return code of its own, so a middleware can send a refused
 * line again. A command's `timeoutMs` bounds the whole chain, the waits of a
 * middleware included. After the chain, the client looks at the connection
 * once more and fails with a NotConnectedError, writing nothing, if a
 * disconnect has begun meanwhile.
 *
 * The voice client builds two chains from the same list, one for lines that
 * are answered and one for lines that are not (`execNoWait`,
 * `setconnectioninfo`), so a middleware may be called more than once: keep
 * state that every line shares, such as a token bucket, outside it.
 *
 * `line.text` can carry secrets, so do not log it whole.
 */
export type LineMiddleware = (next: LineSender) => LineSender;

// ---- Logger interface --------------------------------------------------------

/**
 * Where the SDK logs. `console` is one; so is a pino or winston logger. The
 * first argument is the message, the rest structured details.
 */
export interface Logger {
  /** Detail for debugging the protocol; never the content of a command. */
  debug(msg: string, ...args: unknown[]): void;
  /** Connection lifecycle: connecting, connected, reconnecting. */
  info(msg: string, ...args: unknown[]): void;
  /** Something went wrong and was recovered from, or will be retried. */
  warn(msg: string, ...args: unknown[]): void;
  /** Something went wrong that the SDK could not report as an error to a caller. */
  error(msg: string, ...args: unknown[]): void;
}

/** A no-op logger that discards all messages. */
export const noopLogger: Logger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** A console-backed logger. */
export const consoleLogger: Logger = Object.freeze({
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
});

/** A negotiated upload, as `initFileUpload` returns it: what to dial and send. */
export interface FileUploadInfo {
  /** The key that identifies the transfer on the file transfer connection. */
  readonly fileTransferKey: string;
  /** The file's whole size in bytes, as the negotiation declared it. */
  readonly size: bigint;
  /**
   * Where the upload continues from, in bytes: 0 for a fresh upload, and with
   * `resume` the size of the partial file the server holds. The data to send
   * is the file from here on.
   */
  readonly seekPosition: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial, on the host the connection uses. */
  readonly port: number;
}

/** A negotiated download, as `initFileDownload` returns it: what to dial and receive. */
export interface FileDownloadInfo {
  /** The key that identifies the transfer on the file transfer connection. */
  readonly fileTransferKey: string;
  /** The file's whole size in bytes, whatever `seekPosition` is. */
  readonly size: bigint;
  /**
   * Where the download starts from, in bytes, as it was asked for: the server
   * sends the file from here to its end, `size` less this many bytes.
   */
  readonly seekPosition: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial, on the host the connection uses. */
  readonly port: number;
}

/** Removes a listener; calling it again does nothing. Also a `Disposable`, for `using`. */
export type Unsubscribe = (() => void) & Disposable;

/**
 * A listener for the event `K` of the event map `M`: it takes the event's
 * payload, or nothing for an event whose payload is `void`.
 */
export type Listener<M, K extends keyof M> = M[K] extends void
  ? () => void
  : (payload: M[K]) => void;

/** The values of the table below, before freezing. */
const clientStatusValues = {
  /** Not connected: before `connect()`, after `disconnect()`, or after a drop. */
  Disconnected: "disconnected",
  /** Connecting: `connect()` is waiting for the handshake. */
  Connecting: "connecting",
  /** Connected: the handshake completed and commands can be sent. */
  Connected: "connected",
} as const;
/** Where a client is in its connection's life. */
export const ClientStatus: typeof clientStatusValues =
  /* @__PURE__ */ Object.freeze(clientStatusValues);
/**
 * One of {@link ClientStatus}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

/** The values of the table below, before freezing. */
const serverFamilyValues = {
  /** TeamSpeak 3: major version 3. */
  TS3: "ts3",
  /** TeamSpeak 6: major version 6 or later. */
  TS6: "ts6",
  /** A version string that names neither generation, or has no number. */
  Unknown: "unknown",
} as const;
/** The server generation a version string belongs to. */
export const ServerFamily: typeof serverFamilyValues =
  /* @__PURE__ */ Object.freeze(serverFamilyValues);
/**
 * One of {@link ServerFamily}. May gain members in a minor release, as server
 * generations appear: a `switch` over it needs a default case.
 */
export type ServerFamily = (typeof ServerFamily)[keyof typeof ServerFamily];

/**
 * Pick the server generation from a `virtualserver_version` string such as
 * "6.0.0-beta13.1" or "3.13.8 [Build: 1779874471]": major version 3 is TS3,
 * 6 and later TS6, anything else, including a string with no number, unknown.
 * Both clients use it, so they cannot disagree about the same server.
 */
export function serverFamilyForVersion(version: string): ServerFamily {
  const major = Number.parseInt(version, 10);
  if (Number.isNaN(major)) return ServerFamily.Unknown;
  if (major === 3) return ServerFamily.TS3;
  if (major >= 6) return ServerFamily.TS6;
  return ServerFamily.Unknown;
}

/** The values of the table below, before freezing. */
const serverExtensionValues = {
  /** Named by every TeamSpeak 6 server measured. Nothing in the SDK depends on it. */
  FileTime: "FILETIME",
  /** Peer to peer streams (screen share), which `@honeybbq/teamspeak/stream` needs. */
  StreamP2P: "STREAM_P2P",
  /** S3 file transfer, which the client's `uploadS3File` and the other S3 functions need. */
  S3: "s3",
} as const;
/**
 * The extensions a server names in `virtualserver_capability_extensions`
 * (`serverCapabilities.extensions`), as TeamSpeak 6 6.0.0-beta13.1 names them.
 * The names are compared as sent, so case matters. A TeamSpeak 3 server names
 * none.
 */
export const ServerExtension: typeof serverExtensionValues =
  /* @__PURE__ */ Object.freeze(serverExtensionValues);
/**
 * One of {@link ServerExtension}. A server may name others, and the table may
 * gain members in a minor release.
 */
export type ServerExtension = (typeof ServerExtension)[keyof typeof ServerExtension];
