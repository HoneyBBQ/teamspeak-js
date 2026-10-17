import { TeamspeakError } from "@honeybbq/teamspeak";

/**
 * The `ssh` transport was asked for and `ssh2` is not installed.
 *
 * `ssh2` is an optional peer dependency — ServerQuery over raw TCP and over
 * WebQuery need nothing but Node — so an application that only uses those has
 * no reason to carry it. This says which package to add rather than failing
 * with a module-not-found from inside the loader.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class MissingDependencyError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "MissingDependencyError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "MissingDependencyError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The package to install. */
  readonly package = "ssh2" as const;

  constructor() {
    super('the ssh transport needs the optional dependency "ssh2", which is not installed');
  }
}

/**
 * An SSH server's host key was not accepted, so nothing was sent to it: the
 * caller's check refused it, or the `known_hosts` file it named does not know
 * the host, records another key, revokes this one, or could not be read.
 *
 * The check runs before the login, so the query password has not left the
 * process. What the check said is kept as this error's `cause`: an unknown host
 * is told apart from a changed key there, and a changed key may be somebody
 * else answering the port. Retrying cannot help, so the default reconnection
 * policy does not.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class SshHostKeyError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "SshHostKeyError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "SshHostKeyError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The host that was dialled. */
  readonly host: string;
  /** The port that was dialled. */
  readonly port: number;

  constructor(host: string, port: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.host = host;
    this.port = port;
  }
}

/**
 * The server refused an SSH login: a wrong query login name or password, or an
 * account the server does not accept over SSH.
 *
 * SSH logs in before the query protocol starts, so this is not a `ServerError`
 * with a protocol code; the failure is the SSH client's own, kept as this
 * error's `cause`.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class QueryAuthError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "QueryAuthError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "QueryAuthError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The SSH login name whose authentication failed. */
  readonly username: string;

  constructor(username: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.username = username;
  }
}

/**
 * A connection made with `guest: true` was refused because the server offers
 * no guest access. TeamSpeak 3 has none, and a TeamSpeak 6 server started with
 * guest access off refuses the same way.
 *
 * Over WebQuery the server answers a request without an api key with 5124
 * (`ErrorCode.APIKeyMissing`); over SSH it fails the `guest` user's
 * authentication. The server's own error is kept as `cause`, and over WebQuery
 * its code as {@link GuestAccessError.code}, so the refusal can still be
 * matched by number.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export class GuestAccessError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "GuestAccessError";
  static {
    Object.defineProperty(this.prototype, "name", {
      value: "GuestAccessError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The server's error code when it sent one (5124 over WebQuery); `undefined` over SSH. */
  readonly code: number | undefined;

  constructor(cause: Error, code?: number) {
    super(`the server does not offer guest access (TeamSpeak 3 has none): ${cause.message}`, {
      cause,
    });
    this.code = code;
  }
}
