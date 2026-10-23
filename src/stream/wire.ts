/**
 * How streams look on the wire: the value tables, the signalling messages, the
 * commands, and what the server's notifications carry.
 */

import { asClientID } from "@honeybbq/teamspeak";
import type { ClientID, CommandRequest } from "@honeybbq/teamspeak";
import { encodeRequest, parseUint16 } from "../core/internal.js";
import { StreamPayloadTooLargeError } from "./errors.js";
import type {
  IceCandidate,
  RawSignal,
  StreamAccessibility,
  StreamInfo,
  StreamSource,
  StreamTransport,
} from "./types.js";

/**
 * The longest command line, in bytes, this SDK sends for a stream, before the
 * ` return_code=N` it appends (13 bytes and the digits, at most 23 in all).
 *
 * The server drops a longer line without an answer, whatever the command, and
 * the limit is on the whole line, return code included. Measured on TeamSpeak
 * 6 6.0.0-beta13.1 with a two-digit return code: a `setupstream` line of 9,203
 * bytes passed and one of 9,204 was dropped. A `sendtextmessage` of 9,500
 * characters is dropped without an answer as well. The constant is well under that, so a longer return code, or a
 * server that counts a little differently, does not turn a send into a silent
 * drop.
 */
export const MAX_COMMAND_LINE_BYTES = 9_150;

// ---- Value tables -----------------------------------------------------------

/** The names of `type`, by wire number. */
const SOURCES: readonly StreamSource[] = ["none", "camera", "screen", "window", "session"];

/** The names of `accessibility`, by wire number. */
const ACCESSIBILITIES: readonly StreamAccessibility[] = ["none", "public", "contacts", "private"];

/**
 * The extension a server names in `virtualserver_capability_extensions` when it
 * does peer to peer streams.
 */
export const STREAM_P2P = "STREAM_P2P";

/** The names of `mode`, by wire number; 0 has none. */
const TRANSPORTS: ReadonlyArray<StreamTransport | undefined> = [undefined, "p2p"];

/** The wire number of a source name; undefined for a name that is none. */
export function sourceToWire(source: string): number | undefined {
  const index = SOURCES.indexOf(source as StreamSource);
  return index < 0 ? undefined : index;
}

/** The wire number of an accessibility name; undefined for a name that is none. */
export function accessibilityToWire(accessibility: string): number | undefined {
  const index = ACCESSIBILITIES.indexOf(accessibility as StreamAccessibility);
  return index < 0 ? undefined : index;
}

function sourceFromWire(n: number): StreamSource | number {
  return SOURCES[n] ?? n;
}

function accessibilityFromWire(n: number): StreamAccessibility | number {
  return ACCESSIBILITIES[n] ?? n;
}

function transportFromWire(n: number): StreamTransport | number {
  return TRANSPORTS[n] ?? n;
}

// ---- Commands ---------------------------------------------------------------

/** `setupstream`: all seven parameters, because the server refuses a command without any. */
export function setupRequest(p: {
  name: string;
  source: number;
  bitrate: number;
  accessibility: number;
  viewerLimit: number;
  audio: boolean;
}): CommandRequest {
  return {
    command: "setupstream",
    params: [
      ["name", p.name],
      ["type", p.source],
      ["bitrate", p.bitrate],
      ["accessibility", p.accessibility],
      // Peer to peer: the only mode the server allows an ordinary client.
      ["mode", 1],
      ["viewer_limit", p.viewerLimit],
      ["audio", p.audio],
    ],
  };
}

/** `joinstreamrequest`: ask to watch, or with `remove` stop watching. */
export function joinRequest(
  id: string,
  streamer: ClientID,
  message: string,
  remove: boolean,
): CommandRequest {
  return {
    command: "joinstreamrequest",
    params: [
      ["id", id],
      ["clid", streamer],
      ["msg", message],
      ["is_remove", remove],
    ],
  };
}

/** `respondjoinstreamrequest`; the offer is sent empty on a refusal, which the server insists on. */
export function respondRequest(
  id: string,
  viewer: ClientID,
  message: string,
  offer: string,
  accept: boolean,
): CommandRequest {
  return {
    command: "respondjoinstreamrequest",
    params: [
      ["id", id],
      ["clid", viewer],
      ["msg", message],
      ["offer", offer],
      ["decision", accept],
    ],
  };
}

/** `streamsignaling`: relay a JSON text to the other end of a stream. */
export function signalRequest(id: string, peer: ClientID, json: string): CommandRequest {
  return {
    command: "streamsignaling",
    params: [
      ["id", id],
      ["clid", peer],
      ["json", json],
    ],
  };
}

/** `stopstream`. */
export function stopRequest(id: string, reason: number): CommandRequest {
  return {
    command: "stopstream",
    params: [
      ["id", id],
      ["reason", reason],
    ],
  };
}

/** `requeststreaminfo`. */
export function infoRequest(clid: ClientID): CommandRequest {
  return { command: "requeststreaminfo", params: [["clid", clid]] };
}

/**
 * Throws a StreamPayloadTooLargeError when the request's line is longer than
 * the server takes. The line is measured as it will be sent: escaped, in UTF-8.
 */
export function assertFits(request: CommandRequest): void {
  const size = Buffer.byteLength(encodeRequest(request, (password) => password));
  if (size > MAX_COMMAND_LINE_BYTES) {
    throw new StreamPayloadTooLargeError(request.command, size, MAX_COMMAND_LINE_BYTES);
  }
}

// ---- Signalling -------------------------------------------------------------

/** The JSON text of a signalling message. */
export function encodeSignal(cmd: string, args: unknown): string {
  return JSON.stringify({ cmd, args });
}

/** The JSON of an SDP answer. */
export function answerJson(sdp: string): string {
  return encodeSignal("answer", { answer: sdp });
}

/** The JSON of an SDP offer, sent to renegotiate. */
export function offerJson(sdp: string): string {
  return encodeSignal("offer", { offer: sdp });
}

/** The JSON of an ICE candidate. */
export function candidateJson(c: IceCandidate): string {
  return encodeSignal("iceCandidate", { sdp: c.candidate, mid: c.sdpMid, mLine: c.sdpMLineIndex });
}

/** A received signalling message, by what it is. */
export type Signal =
  | { readonly kind: "offer"; readonly sdp: string }
  | { readonly kind: "answer"; readonly sdp: string }
  | { readonly kind: "candidate"; readonly candidate: IceCandidate }
  | { readonly kind: "raw"; readonly signal: RawSignal };

/** Whether `value` is an integer an unsigned 16-bit field holds. */
function isUint16(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff &&
    !Object.is(value, -0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a signalling message. A shape this does not know, or JSON that is none,
 * comes back as `raw`: a wrong shape is accepted by the server and dropped by
 * the receiver without an error, so nothing here guesses.
 */
export function parseSignal(json: string): Signal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "raw", signal: { cmd: "", args: undefined, json } };
  }
  if (!isRecord(parsed) || typeof parsed["cmd"] !== "string") {
    return { kind: "raw", signal: { cmd: "", args: parsed, json } };
  }
  const cmd = parsed["cmd"];
  const args = parsed["args"];
  const raw: Signal = { kind: "raw", signal: { cmd, args, json } };

  switch (cmd) {
    case "answer":
      return isRecord(args) && typeof args["answer"] === "string"
        ? { kind: "answer", sdp: args["answer"] }
        : raw;
    // A renegotiation is the part of the protocol never seen live, so every
    // spelling a sender might use is read.
    case "offer":
    case "reconnectOffer": {
      if (typeof args === "string") return { kind: "offer", sdp: args };
      if (isRecord(args) && typeof args["offer"] === "string") {
        return { kind: "offer", sdp: args["offer"] };
      }
      if (isRecord(args) && typeof args["sdp"] === "string") {
        return { kind: "offer", sdp: args["sdp"] };
      }
      return raw;
    }
    case "iceCandidate": {
      if (!isRecord(args) || typeof args["sdp"] !== "string") return raw;
      const mid = args["mid"];
      const line = args["mLine"];
      return {
        kind: "candidate",
        candidate: {
          candidate: args["sdp"],
          sdpMid: typeof mid === "string" ? mid : null,
          sdpMLineIndex: isUint16(line) ? line : null,
        },
      };
    }
    default:
      return raw;
  }
}

// ---- Notifications ----------------------------------------------------------

function int(raw: string | undefined): number | undefined {
  return raw !== undefined && /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

/**
 * An unsigned 32-bit number, which is what a source, an accessibility, a mode
 * and a stop reason are; undefined when it is absent, none, or out of range.
 * `maxDigits` bounds the text, as for the signed numbers.
 */
function uint32(raw: string | undefined, maxDigits = 15): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw) || raw.length > maxDigits) return undefined;
  const n = Number(raw);
  return n <= 0xffff_ffff ? n : undefined;
}

/**
 * The stream a `notifystreamstarted` or `notifystreaminfo` describes, merged
 * over what was known of it. Undefined for the empty `notifystreaminfo` the
 * server sends for a client that streams nothing.
 *
 * The two name the accessibility differently: `access` and `accessibility`.
 * Only the info carries `viewer`.
 */
export function streamInfoFrom(
  params: Readonly<Record<string, string>>,
  known: StreamInfo | undefined,
): StreamInfo | undefined {
  const id = params["id"];
  if (id === undefined || id === "") return undefined;

  const type = uint32(params["type"]);
  const access = uint32(params["accessibility"] ?? params["access"]);
  const mode = uint32(params["mode"]);
  const bitrate = int(params["bitrate"]);
  const limit = int(params["viewer_limit"]);
  const viewers = int(params["viewer"]);
  const clid = params["clid"] === undefined ? undefined : parseUint16(params["clid"]);

  return {
    id,
    clientId:
      clid === undefined || clid === 0 ? (known?.clientId ?? asClientID(0)) : asClientID(clid),
    name: params["name"] ?? known?.name ?? "",
    source: type === undefined ? known?.source : sourceFromWire(type),
    audio: params["audio"] === undefined ? (known?.audio ?? false) : params["audio"] === "1",
    bitrate: bitrate ?? known?.bitrate,
    accessibility: access === undefined ? known?.accessibility : accessibilityFromWire(access),
    transport: mode === undefined ? known?.transport : transportFromWire(mode),
    viewerLimit: limit ?? known?.viewerLimit,
    viewers: viewers ?? known?.viewers,
  };
}

/** Whether two descriptions of a stream say the same. */
export function sameInfo(a: StreamInfo, b: StreamInfo): boolean {
  return (
    a.clientId === b.clientId &&
    a.name === b.name &&
    a.source === b.source &&
    a.audio === b.audio &&
    a.bitrate === b.bitrate &&
    a.accessibility === b.accessibility &&
    a.transport === b.transport &&
    a.viewerLimit === b.viewerLimit &&
    a.viewers === b.viewers
  );
}

/** A client id the notification names under `key`; 0 when it names none. */
export function clientOf(params: Readonly<Record<string, string>>, key: string): ClientID {
  return asClientID(parseUint16(params[key] ?? ""));
}

/** The stop reason a notification carries; 0 when it carries none. */
export function reasonOf(params: Readonly<Record<string, string>>): number {
  // No bound on the digits: leading zeros are as good as none.
  return uint32(params["reason"], Infinity) ?? 0;
}

/** Whether an SDP has an audio media section. */
export function hasAudioSection(sdp: string): boolean {
  return /^m=audio[ \t]/m.test(sdp);
}
