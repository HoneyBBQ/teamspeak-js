import type { ChannelID, ClientID } from "@honeybbq/teamspeak";
import type { ServerCapabilities } from "./capabilities.js";
import type { ResolvedAddr } from "./types.js";

/** The values of the table below, before freezing. */
const connectPhaseValues = {
  /** Opening the socket, or the address was not usable once resolved. */
  Open: "open",
  /** The handshake, from the first packet until the shared secret exists. */
  Handshake: "handshake",
  /** After the handshake, waiting for the server to accept the client: a wrong password, a ban or an invalid nickname end here. */
  Join: "join",
} as const;
/** Where a connection attempt can fail; see {@link AttemptFailedInfo}. */
export const ConnectPhase: typeof connectPhaseValues =
  /* @__PURE__ */ Object.freeze(connectPhaseValues);
/**
 * One of {@link ConnectPhase}. May gain members in a minor release: a
 * `switch` over it needs a default case.
 */
export type ConnectPhase = (typeof ConnectPhase)[keyof typeof ConnectPhase];

/** What every milestone of one connection attempt says about the attempt. */
interface AttemptInfo {
  /**
   * The attempt's number, from 1. The attempt `connect()` starts is 1; a
   * reconnection attempt carries the retry number the reconnect policy uses,
   * the one `shouldRetry` and the backoff see.
   */
  readonly attempt: number;
  /** Whether the reconnect loop started this attempt rather than a call to `connect()`. */
  readonly reconnect: boolean;
}

/** The address is about to be resolved. */
export interface ResolveStartInfo extends AttemptInfo {
  /** The address as the client was given it. */
  readonly addr: string;
}

/** The address has been resolved, or the lookup failed and the address is used as given. */
export interface ResolveDoneInfo extends AttemptInfo {
  /** The address as the client was given it. */
  readonly addr: string;
  /** The `host:port` that will be dialled. */
  readonly target: string;
  /** What the resolver reports as the source of the answer dialled; may be empty. */
  readonly source: string;
  /** Every answer the resolver gave, in order; empty when the address is used as given. */
  readonly candidates: readonly ResolvedAddr[];
  /** Why the lookup failed, when the address is used as given; `undefined` otherwise. */
  readonly error: unknown;
  /** How long the resolution took, in milliseconds. */
  readonly durationMs: number;
}

/** The socket is about to be opened. */
export interface ConnectStartInfo extends AttemptInfo {
  /** The `host:port` being dialled. */
  readonly target: string;
}

/** The socket is open; the first handshake packet has not been sent yet. */
export interface ConnectDoneInfo extends AttemptInfo {
  /** The `host:port` being dialled. */
  readonly target: string;
  /** The local socket's `host:port`; empty when the socket does not say. */
  readonly localAddr: string;
  /** Milliseconds since `connectStart`. */
  readonly durationMs: number;
}

/** The encrypted session exists; `clientinit` has not been sent yet. */
export interface HandshakeDoneInfo extends AttemptInfo {
  /** Milliseconds since `connectStart`. */
  readonly durationMs: number;
  /** The level of the RSA puzzle the server demanded; 0 if it sent none. */
  readonly puzzleLevel: number;
  /** Milliseconds spent solving the puzzle. */
  readonly puzzleDurationMs: number;
  /**
   * The packets sent again from `connectStart` to now, for want of an
   * acknowledgement: the Init1 steps and the handshake's command packets.
   */
  readonly resends: number;
  /**
   * The server's public key exactly as it sent it, base64, so that a caller can
   * pin a server's identity.
   */
  readonly serverPublicKey: string;
}

/** The server accepted the client, which is now connected. */
export interface SessionStartInfo extends AttemptInfo {
  /** The client's ID on the server, the same as `client.clientID`. */
  readonly clientID: ClientID;
  /**
   * The nickname the server accepted (`acn`), which differs from the one asked
   * for when that was taken. The one asked for when the server did not say.
   */
  readonly nickname: string;
  /** The client's talk power (`client_talk_power`); 0 when the server did not say. */
  readonly talkPower: number;
  /**
   * Every parameter of `initserver`, unescaped, except those that could carry a
   * secret: `client_server_password`, `client_default_channel_password`,
   * `client_default_token` and `client_key_offset`. Frozen.
   */
  readonly initServer: Readonly<Record<string, string>>;
  /** What the server said about itself in this handshake. */
  readonly capabilities: ServerCapabilities;
  /** Milliseconds since `connectStart`. */
  readonly durationMs: number;
}

/** The server's welcome sequence ended: the channel list and the clients already there have arrived. */
export interface WelcomeDoneInfo extends AttemptInfo {
  /**
   * The channel the client is in at the end of the welcome: where it landed,
   * which differs from the default channel asked for when that was refused.
   */
  readonly channelID: ChannelID;
  /** How many channel rows the welcome delivered. */
  readonly channels: number;
  /** How many clients are in view at the end of the welcome, this client included. */
  readonly clients: number;
  /** Milliseconds since `connectStart`. */
  readonly durationMs: number;
}

/** An attempt ended without a session. */
export interface AttemptFailedInfo extends AttemptInfo {
  /** Where the attempt failed. */
  readonly phase: ConnectPhase;
  /** Why: the error `connect()` rejects with, or the one that ended the reconnection attempt. */
  readonly error: unknown;
  /** The `host:port` being dialled; empty when the attempt failed before `resolveDone`. */
  readonly target: string;
  /**
   * What the attempt was waiting for when it ended, in words for a person or a
   * log, such as `the server's answer to clientek`. It is finer than
   * {@link AttemptFailedInfo.phase}, and its wording may change in any release:
   * do not match on it.
   */
  readonly waitingFor: string;
  /** Milliseconds since `resolveStart`. */
  readonly durationMs: number;
}

/** The reconnect loop will retry, after a wait. */
export interface ReconnectScheduledInfo {
  /** The attempt that will follow, numbered as in {@link ResolveStartInfo.attempt}. */
  readonly attempt: number;
  /** How long the loop waits first, in milliseconds. */
  readonly delayMs: number;
  /** The error that ended the previous connection or attempt. */
  readonly cause: unknown;
}

/** A connected session is about to be left with `disconnect()`. It has no fields yet. */
export interface DisconnectStartInfo {}

/** The goodbye of `disconnect()` is over. */
export interface DisconnectDoneInfo {
  /** Whether the server acknowledged the goodbye before the goodbye timeout. */
  readonly acknowledged: boolean;
  /** Milliseconds since `disconnectStart`. */
  readonly durationMs: number;
}

/** A session that had a `sessionStart` has ended, however it ended. */
export interface SessionEndInfo {
  /** The client's ID on the server during the session. */
  readonly clientID: ClientID;
  /**
   * `undefined` after `disconnect()`, and otherwise the cause the
   * `disconnected` event gets.
   */
  readonly error: unknown;
  /** Milliseconds since `sessionStart`. */
  readonly durationMs: number;
  /** The number of the attempt that started the session. */
  readonly attempt: number;
  /** Whether the reconnect loop started the attempt that started the session. */
  readonly reconnect: boolean;
}

/** The reconnect loop ended without a session. */
export interface ReconnectStoppedInfo {
  /** How many reconnection attempts the loop made. */
  readonly attempts: number;
  /**
   * The error `shouldRetry` declined, or the last attempt's when the attempts
   * ran out; `undefined` when `disconnect()` stopped the loop.
   */
  readonly cause: unknown;
}

/**
 * Hooks that observe a client for timing, metrics, logs or a progress
 * display: the milestones of every connection attempt, the end of a session,
 * and the reconnect loop. Every hook is optional.
 *
 * A hook is called synchronously, at the moment of the milestone, and the
 * client waits for it to return: keep it quick, and hand slow work to your own
 * task. What it returns is ignored, and a returned promise is never awaited. A
 * hook that throws, or whose promise rejects, is reported the way a throwing
 * event listener is, and the client carries on. A hook may read the
 * client's state. It must not call `connect()` or `disconnect()`: to give up
 * on an attempt, abort the signal passed to `connect()`, and to leave once
 * connected, call `disconnect()` from a `connected` listener.
 *
 * Every attempt ends with exactly one of `sessionStart` and `attemptFailed`,
 * and every session that started with exactly one `sessionEnd`. The hooks are
 * read when the client is made, from a copy of this object.
 */
export interface ClientTrace {
  /** Before the address is resolved. */
  readonly resolveStart?: (info: ResolveStartInfo) => void;
  /** After the address is resolved, also when it fell back to the address as given. */
  readonly resolveDone?: (info: ResolveDoneInfo) => void;
  /** Right before the socket is opened. */
  readonly connectStart?: (info: ConnectStartInfo) => void;
  /** Once the socket is open, before the first handshake packet is sent. */
  readonly connectDone?: (info: ConnectDoneInfo) => void;
  /** When the shared secret is derived, before `clientinit` is sent. */
  readonly handshakeDone?: (info: HandshakeDoneInfo) => void;
  /** When the server accepts the client: before `connect()` resolves and before `connected` is delivered. */
  readonly sessionStart?: (info: SessionStartInfo) => void;
  /** When the server's welcome sequence ends; at most once per attempt, and only after `sessionStart`. */
  readonly welcomeDone?: (info: WelcomeDoneInfo) => void;
  /** When an attempt ends without `sessionStart`, for any reason, an abort or `disconnect()` included. */
  readonly attemptFailed?: (info: AttemptFailedInfo) => void;
  /** When `disconnect()` begins saying goodbye to a connected session. */
  readonly disconnectStart?: (info: DisconnectStartInfo) => void;
  /** When that goodbye is over. */
  readonly disconnectDone?: (info: DisconnectDoneInfo) => void;
  /** When a session ends, however it ends; before `disconnected` is queued. */
  readonly sessionEnd?: (info: SessionEndInfo) => void;
  /** When the reconnect loop has decided to retry and is about to wait. */
  readonly reconnectScheduled?: (info: ReconnectScheduledInfo) => void;
  /** When the reconnect loop ends without a session. */
  readonly reconnectStopped?: (info: ReconnectStoppedInfo) => void;
}
