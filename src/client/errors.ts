import { Reason, TeamspeakError } from "@honeybbq/teamspeak";

/**
 * The address a client was given cannot be connected to: no host, a host with
 * characters no host name or IP address has, or a port outside 1–65535.
 * `connect()` rejects with it before it starts, and the client stays
 * disconnected. A name that does not resolve is not this: that fails with a
 * TeamspeakError whose `cause` is the lookup's error, since DNS failures are
 * often transient.
 */
export class InvalidAddressError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "InvalidAddressError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "InvalidAddressError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The address as given. */
  readonly address: string;

  constructor(address: string, reason: string) {
    super(`invalid address ${JSON.stringify(address)}: ${reason}`);
    this.address = address;
  }
}

/**
 * A packet failed authentication: it was corrupted, or not from the server.
 * Internal: the packet is dropped, and this never reaches a caller.
 */
export class EAXTagMismatchError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "EAXTagMismatchError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "EAXTagMismatchError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor() {
    super("EAX tag mismatch");
  }
}

/**
 * An unencrypted packet failed its integrity check. Internal: the packet is
 * dropped, and this never reaches a caller.
 */
export class FakeSignatureMismatchError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "FakeSignatureMismatchError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "FakeSignatureMismatchError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor() {
    super("fake signature mismatch");
  }
}

/** A file transfer connection failed: it could not be opened, or broke during the transfer. */
export class FileTransferError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "FileTransferError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "FileTransferError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * The handshake failed on what the server sent: a malformed or out-of-range
 * Init1 step, public key, license or proof. `connect()` rejects with it, the
 * underlying failure as its `cause`.
 */
export class HandshakeError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "HandshakeError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "HandshakeError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * The server's Init1 puzzle asks for more squarings than this client will do:
 * a server that is flooded raises the level, but not this far. `connect()`
 * rejects with it, as with any {@link HandshakeError}, and nothing was solved.
 */
export class PuzzleTooHardError extends HandshakeError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "PuzzleTooHardError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "PuzzleTooHardError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The number of squarings the server asked for. */
  readonly level: number;
  /** The most this client does. */
  readonly maxLevel: number;

  constructor(level: number, maxLevel: number) {
    super(`the server's RSA puzzle asks for ${level} squarings, more than the ${maxLevel} allowed`);
    this.level = level;
    this.maxLevel = maxLevel;
  }
}

/** An identity string `parseIdentity()` cannot read. */
export class InvalidIdentityError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "InvalidIdentityError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "InvalidIdentityError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor(message = "invalid identity format", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * The server stopped answering: nothing arrived, or a packet went
 * unacknowledged, for a minute.
 */
export class ConnectionTimeoutError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "ConnectionTimeoutError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "ConnectionTimeoutError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor() {
    super("connection timed out: the server stopped answering");
  }
}

/**
 * The server's command stream broke: a command packet stayed missing for
 * seconds while later ones arrived, although the server sends one again until
 * it is acknowledged. The connection is ended rather than carry on without the
 * missing command, which would drop an answer or a notification and could
 * leave the view out of step with the server's; a reconnect starts from a
 * consistent state.
 */
export class ConnectionStalledError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "ConnectionStalledError";
  static {
    Object.defineProperty(this.prototype, "name", {
      value: "ConnectionStalledError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  constructor() {
    super("connection stalled: a command from the server never arrived");
  }
}

/**
 * The server ended this client's session: a kick, a ban, or the server
 * stopping. The default reconnect policy retries a server that stopped, but
 * not a kick or a ban.
 */
export class RemovedError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "RemovedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "RemovedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** Why: `Reason.KickServer`, `KickServerBan`, `ServerStop` or `ServerShutdown`. */
  readonly reason: number;
  /** The reason the server or the invoker gave, if any. */
  readonly reasonMessage: string;
  /** Who removed the client, for a kick or a ban. */
  readonly invokerName: string;

  constructor(reason: number, reasonMessage: string, invokerName: string) {
    let message = `removed from the server: ${reasonName(reason)}`;
    if (invokerName) message += ` by ${invokerName}`;
    if (reasonMessage) message += `: ${reasonMessage}`;
    super(message);
    this.reason = reason;
    this.reasonMessage = reasonMessage;
    this.invokerName = invokerName;
  }
}

function reasonName(reason: number): string {
  switch (reason) {
    case Reason.KickServer:
      return "kicked from server";
    case Reason.KickServerBan:
      return "banned from server";
    case Reason.ServerStop:
      return "server stopped";
    case Reason.ServerShutdown:
      return "server shut down";
    default:
      return `reason ${reason}`;
  }
}
