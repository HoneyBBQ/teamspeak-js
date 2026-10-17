/**
 * Branded identifiers.
 *
 * TeamSpeak uses one 64-bit integer space for several unrelated kinds of id, so
 * a `bigint` alone cannot tell a channel from a client. Branding makes the
 * mistake a compile error instead of a silent move-to-the-wrong-place, and the
 * brands cost nothing at runtime.
 *
 * The ids the protocol defines as 32 bits or narrower — a clid, a permission,
 * an icon — are `number` brands; the 64-bit ones are `bigint` brands.
 */

/** A channel (`cid`). */
export type ChannelID = bigint & { readonly __brand: "ChannelID" };
/**
 * A connected client (`clid`): an id for this connection only, assigned anew
 * every time the client connects.
 */
export type ClientID = number & { readonly __brand: "ClientID" };
/**
 * A client's database record (`cldbid`): stable across connections, unlike its
 * ClientID.
 */
export type ClientDBID = bigint & { readonly __brand: "ClientDBID" };
/** A server group (`sgid`). */
export type ServerGroupID = bigint & { readonly __brand: "ServerGroupID" };
/** A channel group (`cgid`). */
export type ChannelGroupID = bigint & { readonly __brand: "ChannelGroupID" };
/** A permission's numeric id (`permid`), a 32-bit value assigned by the server build. */
export type PermissionID = number & { readonly __brand: "PermissionID" };
/**
 * An icon: the unsigned CRC32 of the icon file, which also names the file
 * (`/icon_<id>`) in the server's file area.
 */
export type IconID = number & { readonly __brand: "IconID" };

/** A ban (`banid`). */
export type BanID = bigint & { readonly __brand: "BanID" };
/** An API key (`id` of `apikeyadd` and `apikeylist`), not the key itself. */
export type APIKeyID = bigint & { readonly __brand: "APIKeyID" };
/** An offline message (`msgid`). */
export type MessageID = bigint & { readonly __brand: "MessageID" };
/** A virtual server on an instance (`sid`, `virtualserver_id`). */
export type ServerID = bigint & { readonly __brand: "ServerID" };
/** The client's id for a file transfer (`clientftfid`), a 16-bit value it chooses. */
export type ClientFileTransferID = number & { readonly __brand: "ClientFileTransferID" };
/** The server's id for a file transfer (`serverftfid`), a 16-bit value. */
export type ServerFileTransferID = number & { readonly __brand: "ServerFileTransferID" };

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT64 = (1n << 64n) - 1n;

/** `v` if it is an integer from 0 to `max`; a RangeError otherwise. */
function uintInRange(v: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    throw new RangeError(`${what} is an integer from 0 to ${max}, not ${String(v)}`);
  }
  return v;
}

/** `v` as a bigint if it is an integer from 0 to 2^64-1; a RangeError otherwise. */
function uint64(v: bigint | number, what: string): bigint {
  const integer = typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v));
  const value = integer ? BigInt(v) : -1n;
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError(`${what} is an integer from 0 to 2^64-1, not ${String(v)}`);
  }
  return value;
}

// Every constructor checks its value against the id's wire width and throws a
// RangeError for anything else — a fraction, a negative, a value too wide —
// rather than brand a value no server could mean.

/** Brand a ban id, an integer from 0 to 2^64-1, from a number or a bigint. */
export const asBanID = (v: bigint | number): BanID => uint64(v, "a ban id") as BanID;
/** Brand an API key id, an integer from 0 to 2^64-1. */
export const asAPIKeyID = (v: bigint | number): APIKeyID => uint64(v, "an API key id") as APIKeyID;
/** Brand an offline message id, an integer from 0 to 2^64-1. */
export const asMessageID = (v: bigint | number): MessageID =>
  uint64(v, "a message id") as MessageID;
/** Brand a virtual server id, an integer from 0 to 2^64-1. */
export const asServerID = (v: bigint | number): ServerID => uint64(v, "a server id") as ServerID;
/** Brand the client's id for a file transfer, an integer from 0 to 65535. */
export const asClientFileTransferID = (v: number): ClientFileTransferID =>
  uintInRange(v, MAX_UINT16, "a client file transfer id") as ClientFileTransferID;
/** Brand the server's id for a file transfer, an integer from 0 to 65535. */
export const asServerFileTransferID = (v: number): ServerFileTransferID =>
  uintInRange(v, MAX_UINT16, "a server file transfer id") as ServerFileTransferID;

/** Brand a channel id, an integer from 0 to 2^64-1, from a number or a bigint. */
export const asChannelID = (v: bigint | number): ChannelID =>
  uint64(v, "a channel id") as ChannelID;
/** Brand a client id, an integer from 0 to 65535: the voice protocol's width. */
export const asClientID = (v: number): ClientID =>
  uintInRange(v, MAX_UINT16, "a client id") as ClientID;
/** Brand a client database id, an integer from 0 to 2^64-1. */
export const asClientDBID = (v: bigint | number): ClientDBID =>
  uint64(v, "a client database id") as ClientDBID;
/** Brand a server group id, an integer from 0 to 2^64-1. */
export const asServerGroupID = (v: bigint | number): ServerGroupID =>
  uint64(v, "a server group id") as ServerGroupID;
/** Brand a channel group id, an integer from 0 to 2^64-1. */
export const asChannelGroupID = (v: bigint | number): ChannelGroupID =>
  uint64(v, "a channel group id") as ChannelGroupID;
/** Brand a permission id, an integer from 0 to 2^32-1. */
export const asPermissionID = (v: number): PermissionID =>
  uintInRange(v, MAX_UINT32, "a permission id") as PermissionID;
/**
 * Brand an icon id, an integer from -2^31 to 2^32-1. A negative value is taken
 * as the signed form of the same CRC32, which is how the server sometimes
 * sends one, and stored unsigned.
 */
export const asIconID = (v: number): IconID => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < -(2 ** 31) || v > MAX_UINT32) {
    throw new RangeError(`an icon id is an integer from -2^31 to 2^32-1, not ${String(v)}`);
  }
  return (v >>> 0) as IconID;
};

/**
 * Read an icon id as the server sends it: the CRC32, sometimes as a negative
 * 32-bit number, sometimes unsigned. Both name the same icon, so both come back
 * as the unsigned value; 0, garbage and out-of-range values mean no icon.
 */
export function parseIconID(raw: string | undefined): IconID | undefined {
  const text = raw?.trim() ?? "";
  if (!/^-?\d{1,10}$/.test(text)) return undefined;
  const value = Number(text);
  if (value < -(2 ** 31) || value >= 2 ** 32 || value === 0) return undefined;
  return asIconID(value);
}

/**
 * A unique identifier: `base64(SHA-1(publicKey))` on TeamSpeak 3 and
 * `base64(SHA-256(publicKey))` on TeamSpeak 6.
 *
 * The length differs between versions, so treat it as opaque bytes rather than
 * assuming either width.
 */
export type UID = string & { readonly __brand: "UID" };
/** Brand a unique identifier. */
export const asUID = (v: string): UID => v as UID;

/**
 * A channel's unique identifier (`channel_unique_identifier`), which TS6
 * gives every channel and TS3 does not send. Opaque text, and not a client's
 * {@link UID}.
 */
export type ChannelUID = string & { readonly __brand: "ChannelUID" };
/** Brand a channel's unique identifier. */
export const asChannelUID = (v: string): ChannelUID => v as ChannelUID;
