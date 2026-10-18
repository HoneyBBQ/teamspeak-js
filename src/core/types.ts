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
 * handshake-time commands do not. A request's parameters can hold passwords
 * and privilege keys, so a middleware must not log them whole.
 */
export type CommandMiddleware = (next: CommandExecutor["send"]) => CommandExecutor["send"];

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
  /** Where to resume from, in bytes; 0 for a fresh upload. */
  readonly seekPosition: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial. */
  readonly port: number;
  /**
   * The address to dial instead of the one the connection uses (`ip`): the
   * server sends it when it finds the file transfer unreachable at the address
   * of the command connection, such as behind NAT. Undefined when it sends
   * none, which is every answer measured on TS3 and TS6.
   */
  readonly ip?: string | undefined;
}

/** A negotiated download, as `initFileDownload` returns it: what to dial and receive. */
export interface FileDownloadInfo {
  /** The key that identifies the transfer on the file transfer connection. */
  readonly fileTransferKey: string;
  /** How many bytes the server will send. */
  readonly size: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** The file transfer port to dial. */
  readonly port: number;
  /**
   * The address to dial instead of the one the connection uses (`ip`); see
   * {@link FileUploadInfo.ip}.
   */
  readonly ip?: string | undefined;
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

/**
 * The server generation a version string belongs to. May gain members in a
 * minor release, as server generations appear: a `switch` over it needs a
 * default case.
 */
export type ServerFamily = "ts3" | "ts6" | "unknown";

/**
 * Pick the server generation from a `virtualserver_version` string such as
 * "6.0.0-beta13.1" or "3.13.8 [Build: 1779874471]": major version 3 is TS3,
 * 6 and later TS6, anything else, including a string with no number, unknown.
 * Both clients use it, so they cannot disagree about the same server.
 */
export function serverFamilyForVersion(version: string): ServerFamily {
  const major = Number.parseInt(version, 10);
  if (Number.isNaN(major)) return "unknown";
  if (major === 3) return "ts3";
  if (major >= 6) return "ts6";
  return "unknown";
}
