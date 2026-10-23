import { ErrorCode } from "./errorcode.js";
import { asPermissionID, type PermissionID } from "./command/ids.js";

/**
 * Where an SDK error keeps the kinds it is: its own class's and those of the
 * classes it extends, whichever copy of the package made it.
 */
const BRAND = Symbol.for("@honeybbq/teamspeak.error");

/**
 * The base of every error the SDK throws, so `instanceof TeamspeakError` tells
 * the SDK's failures from anything else.
 *
 * `instanceof` works across copies of the package: an application can end up
 * with two installed (two versions, or one bundled), and an error from one is
 * still an instance of the other's classes. Each class names itself in a fixed
 * {@link TeamspeakError.kind} that a minifier leaves alone, where a class's
 * own name would not survive one.
 */
export class TeamspeakError extends Error {
  /**
   * The fixed name `instanceof` matches this class by across copies of the
   * package. Every SDK error class declares its own.
   */
  static readonly kind: string = "TeamspeakError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "TeamspeakError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    const kinds: string[] = [];
    for (let c: unknown = new.target; typeof c === "function"; c = Object.getPrototypeOf(c)) {
      if (Object.hasOwn(c, "kind")) kinds.push((c as unknown as { kind: string }).kind);
      if (c === TeamspeakError) break;
    }
    Object.defineProperty(this, BRAND, { value: Object.freeze(kinds) });
  }

  /**
   * Whether `value` is an error of this class from any copy of the package:
   * one whose kinds, its own class's and those it extends, include this
   * class's {@link TeamspeakError.kind}. A subclass that declares no kind of
   * its own matches only its own instances.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    if (!Object.hasOwn(this, "kind")) return false;
    if (typeof value !== "object" || value === null) return false;
    const kinds: unknown = (value as { [BRAND]?: unknown })[BRAND];
    return Array.isArray(kinds) && kinds.includes(this.kind);
  }
}

/**
 * A refusal from the server: the `error` line that answered a command carried a
 * non-zero code.
 *
 * Compare {@link ServerError.code} with {@link ErrorCode} to tell refusals apart.
 */
export class ServerError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "ServerError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "ServerError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /**
   * The protocol's numeric error code, as in `error id=…`: compare it with
   * {@link ErrorCode}. It is not a Node-style string code such as `ENOENT`.
   * A server may report one {@link ErrorCode} does not name.
   */
  readonly code: number;
  /** The server's own text, such as "invalid channel password". */
  readonly serverMessage: string;
  /** Detail the server adds to some refusals (`extra_msg`). */
  readonly extraMessage: string | undefined;
  /** The permission a refused permission check failed on, when the server names one (`failed_permid`). */
  readonly failedPermissionID: PermissionID | undefined;
  /**
   * The missing permission's name, as WebQuery reports it (`failed_permission`);
   * undefined when the server named none. The voice protocol and raw or SSH
   * ServerQuery report an id instead, in {@link ServerError.failedPermissionID}.
   */
  readonly failedPermission: string | undefined;

  constructor(
    code: number,
    serverMessage: string,
    details: {
      extraMessage?: string | undefined;
      failedPermissionID?: PermissionID | undefined;
      failedPermission?: string | undefined;
    } = {},
  ) {
    const extra = details.extraMessage ? ` (${details.extraMessage})` : "";
    super(`TeamSpeak server error: ${serverMessage}${extra} (code ${code})`);
    this.code = code;
    this.serverMessage = serverMessage;
    this.extraMessage = details.extraMessage;
    this.failedPermissionID = details.failedPermissionID;
    this.failedPermission = details.failedPermission;
  }
}

/**
 * A command's answer did not arrive within its timeout. The command may still
 * have taken effect on the server.
 */
export class CommandTimeoutError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "CommandTimeoutError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "CommandTimeoutError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The name of the command that timed out; never its parameters. */
  readonly command: string;

  constructor(command: string) {
    super(`command timeout: ${command}`);
    this.command = command;
  }
}

/**
 * A command was sent with no connection to send it on, or the connection was
 * lost while it waited for its answer.
 *
 * Without it such a command would wait out its full timeout and fail as if the
 * server were slow.
 */
export class NotConnectedError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "NotConnectedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "NotConnectedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor(options?: ErrorOptions) {
    super("not connected", options);
  }
}

/** `connect()` was called on a client that is connecting or connected. */
export class AlreadyConnectedError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "AlreadyConnectedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "AlreadyConnectedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor() {
    super("already connecting or connected");
  }
}

/**
 * A command that answers with data succeeded without it: the server sent no
 * row, or a row without the value the command exists to return — a created
 * channel's id, a transfer's key.
 *
 * Without it the caller would get an id of 0 or an object of empty fields,
 * which reads like a real answer.
 *
 * From a command that creates something, this means the command took effect:
 * TS6 WebQuery answers a successful create with no data while a Server Admin
 * voice client is connected (6.0.0-beta13.1). Do not retry blindly, or a second
 * object is made — or the retry is refused as a duplicate. Creating a channel
 * or a group looks the new one up by its unique name first, and throws this
 * only when none is found; a privilege key cannot be told apart from an
 * identical one, and an API key's secret is never listed, so those two throw it
 * whenever the answer lacks the key, and one made this way is orphaned.
 */
export class NoDataError extends TeamspeakError {
  /** {@inheritDoc TeamspeakError.kind} */
  static override readonly kind: string = "NoDataError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "NoDataError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The name of the command that answered with nothing. */
  readonly command: string;

  constructor(command: string, message = `the server answered ${command} with no data`) {
    super(message);
    this.command = command;
  }
}

/**
 * Read an error id. One that is missing or unreadable is reported as
 * {@link ErrorCode.Undefined}: an error line that does not say what went wrong
 * has still not said that nothing did.
 */
export function parseErrorCode(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return ErrorCode.Undefined;
  return Number(raw);
}

/**
 * Parse and handle an `error` command from the server.
 * Returns the error (or null on success) and the resolved return_code.
 */
export function parseServerError(params: Record<string, string>): {
  err: ServerError | null;
  rc: number | null;
} {
  const code = parseErrorCode(params["id"]);
  const rcStr = params["return_code"];

  let err: ServerError | null = null;
  if (code !== ErrorCode.OK) {
    const failedPermid = params["failed_permid"];
    err = new ServerError(code, params["msg"] ?? "", {
      extraMessage: params["extra_msg"] || undefined,
      failedPermissionID:
        failedPermid !== undefined &&
        /^\d{1,10}$/.test(failedPermid) &&
        Number(failedPermid) <= 0xffff_ffff
          ? asPermissionID(Number(failedPermid))
          : undefined,
      failedPermission: params["failed_permission"] || undefined,
    });
  }

  let rc: number | null = null;
  if (rcStr !== undefined && rcStr !== "") {
    const parsed = parseInt(rcStr, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  return { err, rc };
}
