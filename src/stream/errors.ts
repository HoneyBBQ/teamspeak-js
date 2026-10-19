import { TeamspeakError } from "@honeybbq/teamspeak";
import type { ServerFamily } from "@honeybbq/teamspeak";

/**
 * The connected server does not do streams: only TeamSpeak 6 does. A
 * TeamSpeak 3 server answers none of the stream commands, not even with an
 * error, so `publish` and `watch` refuse before sending rather than wait out
 * a timeout.
 *
 * @beta
 */
export class StreamsUnsupportedError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "StreamsUnsupportedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "StreamsUnsupportedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The server generation the client found: never `"ts6"`. */
  readonly family: ServerFamily;
  /** The `virtualserver_version` the server sent; empty before the client has connected. */
  readonly version: string;

  constructor(family: ServerFamily, version: string) {
    super(
      `streams need a TeamSpeak 6 server; this is ${family === "unknown" ? "an unknown server" : family}${
        version === "" ? "" : ` (${version})`
      }`,
    );
    this.family = family;
    this.version = version;
  }
}

/**
 * The stream's owner refused a request to watch it. `watch` rejects with it.
 *
 * The server remembers nothing of a refusal: asking again is allowed, and a
 * native client does so in a loop, so a publisher that means it should not
 * answer at all.
 *
 * @beta
 */
export class StreamJoinDeniedError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "StreamJoinDeniedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "StreamJoinDeniedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The stream that was asked for. */
  readonly streamId: string;
  /** The message the owner gave with the refusal; empty for none. */
  readonly serverMessage: string;

  constructor(streamId: string, message: string) {
    super(
      `the stream's owner denied the request to watch it${message === "" ? "" : `: ${message}`}`,
    );
    this.streamId = streamId;
    this.serverMessage = message;
  }
}

/**
 * A stream command is too long for the server to take. It drops a command
 * line over about 9.2 KB, escaped, without an answer, so the call fails
 * before sending instead of timing out. An SDP offer of a few kilobytes is
 * far under it.
 *
 * @beta
 */
export class StreamPayloadTooLargeError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "StreamPayloadTooLargeError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "StreamPayloadTooLargeError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The command that would have been sent. */
  readonly command: string;
  /** The size of its line on the wire, escaped, in bytes. */
  readonly size: number;
  /** The largest line this SDK sends. */
  readonly limit: number;

  constructor(command: string, size: number, limit: number) {
    super(`${command} is ${size} bytes escaped; the server takes at most ${limit}`);
    this.command = command;
    this.size = size;
    this.limit = limit;
  }
}

/**
 * The stream is gone: it ended, or its id was never known to the server (error
 * 5635). `watch` rejects with it when the stream ends before its owner
 * answers, and a signalling call when the stream ended under it. The server's
 * own refusal, when there was one, is the `cause`.
 *
 * @beta
 */
export class StreamEndedError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "StreamEndedError";
  static {
    // On the prototype, not the instance, as built-in errors do: an own `name`
    // would be enumerable and show up in JSON.stringify and object spread.
    Object.defineProperty(this.prototype, "name", {
      value: "StreamEndedError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The stream that ended. */
  readonly streamId: string;

  constructor(streamId: string, options?: ErrorOptions) {
    super(`stream ${streamId} has ended`, options);
    this.streamId = streamId;
  }
}
