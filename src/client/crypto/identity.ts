import {
  createHash,
  createECDH,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { InvalidIdentityError } from "../errors.js";
import { asUID, type UID } from "@honeybbq/teamspeak";

const P256_SCALAR_SIZE = 32;
const P256_UNCOMPRESSED_KEY_SIZE = 65;
const P256_POINT_PREFIX = 0x04;

/** The highest security level there is: the level counts zero bits of a SHA-1 digest, which has 160. */
export const MAX_SECURITY_LEVEL = 160;

let createIdentity: (privateKey: KeyObject, offset: bigint) => Identity;
let privateKeyOf: (identity: Identity) => KeyObject;

/**
 * A TeamSpeak client identity: a P-256 key pair plus a counter, the offset,
 * whose hash with the public key sets the identity's security level.
 *
 * Immutable: raising the level returns a new identity. Opaque: the private
 * key is never exposed, and `toString()`, `toJSON()` and `util.inspect()`
 * describe the identity without it, so an identity that reaches a log or an
 * error message does not leak; `export()` is the one way to get the secret
 * form, for storing it. Make one with `generateIdentity()` or
 * `parseIdentity()`.
 */
export class Identity {
  static {
    createIdentity = (privateKey, offset) => new Identity(privateKey, offset);
    privateKeyOf = (identity) => identity.#privateKey;
  }

  readonly #privateKey: KeyObject;
  readonly #offset: bigint;
  #publicKey: string | undefined;

  private constructor(privateKey: KeyObject, offset: bigint) {
    this.#privateKey = privateKey;
    this.#offset = offset;
  }

  /** The counter whose hash with the public key sets the security level. */
  get offset(): bigint {
    return this.#offset;
  }

  /** The public key in TeamSpeak's encoding: base64 of its DER form. */
  publicKey(): string {
    if (this.#publicKey !== undefined) return this.#publicKey;
    const rawJwk = this.#privateKey.export({ format: "jwk" });
    if (typeof rawJwk.x !== "string" || typeof rawJwk.y !== "string") return "";

    const xBytes = base64UrlToBytes(rawJwk.x, P256_SCALAR_SIZE);
    const yBytes = base64UrlToBytes(rawJwk.y, P256_SCALAR_SIZE);
    // Encode as TS3 canonical ASN.1: SEQUENCE { BIT STRING, INTEGER(32), INTEGER(x), INTEGER(y) }
    this.#publicKey = encodeTsPublicKey(xBytes, yBytes);
    return this.#publicKey;
  }

  /**
   * The identity's unique identifier, hashed with `algorithm`: SHA-1 for a
   * TeamSpeak 3 server, SHA-256 for TeamSpeak 6. A connected client's `uid`
   * already uses the one its server does.
   */
  uid(algorithm: UIDAlgorithm): UID {
    return uidFromPublicKey(this.publicKey(), algorithm);
  }

  /**
   * The identity in the form `parseIdentity()` reads, private key included.
   * Store it as you would a password.
   */
  export(): string {
    const jwk = this.#privateKey.export({ format: "jwk" }) as { d?: string };
    if (!jwk.d) return `:${this.#offset}`;
    const dBytes = base64UrlToBytes(jwk.d, P256_SCALAR_SIZE);
    return `${Buffer.from(dBytes).toString("base64")}:${this.#offset}`;
  }

  /** Describes the identity, by its SHA-1 unique identifier, without its private key. */
  toString(): string {
    return `identity ${this.uid("sha1")} (private key redacted)`;
  }

  /** The same as `toString()`, so serialising an identity cannot leak its key. */
  toJSON(): string {
    return this.toString();
  }

  /** The security level: trailing zero bits in SHA-1 of the public key and offset. */
  securityLevel(): number {
    return levelAt(this.publicKey(), this.#offset);
  }

  /**
   * The same key at an offset whose security level reaches `targetLevel`, as
   * a new identity; this one is unchanged, and returned as it is when it
   * already reaches the level.
   *
   * Each level doubles the expected work, so a high level can take a long
   * time; `signal` bounds it, and the event loop keeps running meanwhile. A
   * level above 160, the width of SHA-1, can never be reached and is refused
   * with a RangeError.
   */
  async upgradeToLevel(
    targetLevel: number,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<Identity> {
    checkLevel(targetLevel);
    const { signal } = options;
    const prefix = this.publicKey();
    let offset = this.#offset;
    while (true) {
      signal?.throwIfAborted();
      if (levelAt(prefix, offset) >= targetLevel) {
        return offset === this.#offset ? this : new Identity(this.#privateKey, offset);
      }
      offset++;
      // Yield to the event loop now and then rather than blocking it.
      if (offset % 10000n === 0n) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}

// Defined outside the class body: a computed key there would have to be
// inferred, which isolatedDeclarations rules out. By its registered name, so
// this module needs no node:util.
Object.defineProperty(Identity.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: Identity): string {
    return `Identity <${this.toString()}>`;
  },
});

/**
 * The private key of an identity, for the handshake. Not exported from the
 * package.
 *
 * @internal
 */
export function identityPrivateKey(identity: Identity): KeyObject {
  return privateKeyOf(identity);
}

function checkLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > MAX_SECURITY_LEVEL) {
    throw new RangeError(`a security level is an integer from 0 to 160, not ${level}`);
  }
}

function levelAt(publicKey: string, offset: bigint): number {
  const h = createHash("sha1");
  h.update(publicKey);
  h.update(offset.toString(10));
  return countLeadingZeros(h.digest());
}

/** The largest offset, an unsigned 64-bit counter. */
const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Read an identity from the form `Identity.export()` writes: the private key
 * as canonical base64 of at most 32 bytes, a colon, and the offset as a
 * decimal unsigned 64-bit integer. Anything else throws an
 * InvalidIdentityError, with the underlying failure as its cause.
 */
export function parseIdentity(s: string): Identity {
  const colonIdx = s.lastIndexOf(":");
  if (colonIdx < 0) throw new InvalidIdentityError();

  const dBase64 = s.slice(0, colonIdx);
  const offsetStr = s.slice(colonIdx + 1);
  if (!/^\d+$/.test(offsetStr) || BigInt(offsetStr) > MAX_UINT64) {
    throw new InvalidIdentityError("invalid identity offset");
  }
  const offset = BigInt(offsetStr);

  // Node's base64 decoder skips what it cannot read, so the key is checked by
  // a round trip: anything but canonical base64 would otherwise decode to some
  // other key, silently.
  const dBytes = Buffer.from(dBase64, "base64");
  if (dBytes.length === 0 || dBytes.toString("base64") !== dBase64) {
    throw new InvalidIdentityError("the private key is not canonical base64");
  }
  if (dBytes.length > P256_SCALAR_SIZE) {
    throw new InvalidIdentityError("private key scalar too large");
  }

  // Pad to P256_SCALAR_SIZE
  const padded = Buffer.alloc(P256_SCALAR_SIZE);
  dBytes.copy(padded, P256_SCALAR_SIZE - dBytes.length);

  try {
    // node:crypto JWK import requires x and y to be present.
    // Derive the public key from the private scalar via ECDH.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(padded);
    const pub = ecdh.getPublicKey(null, "uncompressed"); // 65 bytes: 0x04 || x(32) || y(32)

    const x = Buffer.from(pub.subarray(1, 33)).toString("base64url");
    const y = Buffer.from(pub.subarray(33, 65)).toString("base64url");
    const d = padded.toString("base64url");

    const jwk = { kty: "EC", crv: "P-256", d, x, y };
    return createIdentity(createPrivateKey({ key: jwk, format: "jwk" }), offset);
  } catch (error) {
    throw new InvalidIdentityError("invalid private key", { cause: error });
  }
}

/**
 * Create an identity at the given security level, at most 160. Each level
 * doubles the expected work; `signal` bounds it, and the event loop keeps
 * running meanwhile.
 */
export async function generateIdentity(
  targetLevel: number,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<Identity> {
  checkLevel(targetLevel);
  return createIdentity(generateKey(), 0n).upgradeToLevel(targetLevel, options);
}

/**
 * Create an identity at the given security level, at most 160, blocking until
 * done. Fine for a low level; a high one can block the event loop for minutes,
 * so prefer `generateIdentity()` there.
 */
export function generateIdentitySync(targetLevel: number): Identity {
  checkLevel(targetLevel);
  const key = generateKey();
  const prefix = createIdentity(key, 0n).publicKey();
  let offset = 0n;
  while (levelAt(prefix, offset) < targetLevel) offset++;
  return createIdentity(key, offset);
}

function generateKey(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
}

/**
 * The hash a server uses for `client_unique_identifier`, keyed by the server's
 * major version.
 *
 * TeamSpeak 3 hashes the canonical public key with SHA-1 (20 bytes); TeamSpeak
 * 6 switched to SHA-256 (32 bytes). The algorithm is not negotiable on the
 * wire, so a client that guesses wrong computes a UID that matches nothing the
 * server ever sends — self-identification by UID silently fails.
 *
 * May gain members in a minor release, should a server generation change the
 * hash again: a `switch` over it needs a default case.
 */
export type UIDAlgorithm = "sha1" | "sha256";

/** Pick the UID hash from a `virtualserver_version` string, e.g. "6.0.0-beta13.1". */
export function uidAlgorithmForVersion(version: string): UIDAlgorithm {
  const major = Number.parseInt(version, 10);
  return Number.isNaN(major) || major < 6 ? "sha1" : "sha256";
}

/**
 * The unique identifier of a public key in TeamSpeak's encoding, hashed with
 * `algorithm`: SHA-1 for a TeamSpeak 3 server, SHA-256 for TeamSpeak 6.
 */
export function uidFromPublicKey(publicKey: string, algorithm: UIDAlgorithm): UID {
  return asUID(createHash(algorithm).update(publicKey).digest("base64"));
}

export function hash512(data: Uint8Array): Uint8Array {
  return createHash("sha512").update(data).digest();
}

// ---- Internal ASN.1 DER helpers for TS3 canonical P-256 public key ----------

/**
 * Encode a P-256 public key as the TS3 canonical ASN.1 SEQUENCE and return
 * its base64 representation.
 *
 * TS3 canonical format (v3+):
 *   SEQUENCE {
 *     BIT STRING { unused=7, value=0x00 }  — DER: 03 02 07 00
 *     INTEGER 32
 *     INTEGER x
 *     INTEGER y
 *   }
 */
function encodeTsPublicKey(x: Uint8Array, y: Uint8Array): string {
  // BIT STRING with 7 unused bits + value byte 0x00 — matches C# DerBitString(0x00, 7)
  const bitStringBody = Buffer.from([0x07, 0x00]);
  const bitStringDer = encodeDerTlv(0x03, bitStringBody);

  const integerSize = encodeDerTlv(0x02, encodePositiveInt(32));
  const integerX = encodeDerTlv(0x02, encodePositiveInt(x));
  const integerY = encodeDerTlv(0x02, encodePositiveInt(y));

  const seqBody = Buffer.concat([bitStringDer, integerSize, integerX, integerY]);
  const seqDer = encodeDerTlv(0x30, seqBody);

  return seqDer.toString("base64");
}

/** Import a TS3 public key (canonical or legacy ASN.1 DER) and return the
 *  uncompressed 65-byte point [0x04 || x || y]. */
export function importPublicKey(data: Uint8Array): KeyObject {
  const point = parseTsPublicKeyDer(data);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: Buffer.from(point.slice(1, 33)).toString("base64url"),
    y: Buffer.from(point.slice(33, 65)).toString("base64url"),
  };
  return createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Parse both TS3 canonical and legacy ASN.1 formats and return the
 * uncompressed 65-byte point [0x04 || x || y].
 */
function parseTsPublicKeyDer(data: Uint8Array): Uint8Array {
  // Try canonical: SEQUENCE { BIT_STRING, INTEGER(32), INTEGER(x), INTEGER(y) }
  try {
    return parseTsCanonicalPublicKey(data);
  } catch {
    // fall through to legacy
  }
  // Try legacy: SEQUENCE { INTEGER(x), INTEGER(y), BIT_STRING, INTEGER }
  return parseTsLegacyPublicKey(data);
}

function parseTsCanonicalPublicKey(data: Uint8Array): Uint8Array {
  const seqTlv = parseDerTlv(data, 0x30);
  const seq = seqTlv.value;
  let offset = 0;
  // BIT_STRING
  const bs = parseDerTlv(seq, 0x03, offset);
  offset += bs.consumed;
  // INTEGER (32)
  const sizeInt = parseDerTlv(seq, 0x02, offset);
  offset += sizeInt.consumed;
  // INTEGER x
  const xInt = parseDerTlv(seq, 0x02, offset);
  offset += xInt.consumed;
  // INTEGER y
  const yInt = parseDerTlv(seq, 0x02, offset);

  return buildUncompressedPoint(
    positiveIntToBytes(xInt.value, P256_SCALAR_SIZE),
    positiveIntToBytes(yInt.value, P256_SCALAR_SIZE),
  );
}

function parseTsLegacyPublicKey(data: Uint8Array): Uint8Array {
  const seqTlv = parseDerTlv(data, 0x30);
  const seq = seqTlv.value;
  let offset = 0;
  const xInt = parseDerTlv(seq, 0x02, offset);
  offset += xInt.consumed;
  const yInt = parseDerTlv(seq, 0x02, offset);

  return buildUncompressedPoint(
    positiveIntToBytes(xInt.value, P256_SCALAR_SIZE),
    positiveIntToBytes(yInt.value, P256_SCALAR_SIZE),
  );
}

function buildUncompressedPoint(x: Uint8Array, y: Uint8Array): Uint8Array {
  if (x.length > P256_SCALAR_SIZE || y.length > P256_SCALAR_SIZE) {
    throw new Error("invalid public key point encoding");
  }
  const point = new Uint8Array(P256_UNCOMPRESSED_KEY_SIZE);
  point[0] = P256_POINT_PREFIX;
  point.set(x, 1 + P256_SCALAR_SIZE - x.length);
  point.set(y, 1 + 2 * P256_SCALAR_SIZE - y.length);
  return point;
}

// ---- DER encoding helpers ---------------------------------------------------

function encodeDerTlv(tag: number, value: Uint8Array): Buffer {
  const lenBytes = encodeDerLength(value.length);
  return Buffer.concat([Buffer.from([tag]), lenBytes, value]);
}

function encodeDerLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/** Encode a non-negative value as a DER INTEGER (with 0x00 prefix if high bit set). */
function encodePositiveInt(v: number | Uint8Array): Buffer {
  if (typeof v === "number") {
    const bytes: number[] = [];
    let n = v;
    do {
      bytes.unshift(n & 0xff);
      n >>= 8;
    } while (n > 0);
    if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0x00);
    return Buffer.from(bytes);
  }
  // Uint8Array — strip leading zeros, add 0x00 if high bit set
  let start = 0;
  while (start < v.length - 1 && v[start] === 0) start++;
  const trimmed = v.slice(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    return Buffer.concat([Buffer.from([0x00]), trimmed]);
  }
  return Buffer.from(trimmed);
}

interface ParsedTlv {
  value: Uint8Array;
  consumed: number; // bytes consumed including tag+length
}

function parseDerTlv(data: Uint8Array, expectedTag: number, offset = 0): ParsedTlv {
  if (data[offset] !== expectedTag) {
    throw new Error(
      `expected DER tag 0x${expectedTag.toString(16)}, got 0x${(data[offset] ?? 0).toString(16)}`,
    );
  }
  let pos = offset + 1;
  let len: number;
  const firstLenByte = data[pos++]!;
  if (firstLenByte < 0x80) {
    len = firstLenByte;
  } else if (firstLenByte === 0x81) {
    len = data[pos++]!;
  } else if (firstLenByte === 0x82) {
    len = ((data[pos]! << 8) | data[pos + 1]!) >>> 0;
    pos += 2;
  } else {
    throw new Error("unsupported DER length encoding");
  }
  const value = data.slice(pos, pos + len);
  return { value, consumed: pos - offset + len };
}

/** Convert a DER INTEGER value (may have leading 0x00) to fixed-length bytes. */
function positiveIntToBytes(int: Uint8Array, size: number): Uint8Array {
  // Strip leading 0x00 sign byte
  let start = 0;
  while (start < int.length - 1 && int[start] === 0x00) start++;
  const stripped = int.slice(start);
  if (stripped.length > size) throw new Error("integer too large");
  if (stripped.length === size) return stripped;
  const padded = new Uint8Array(size);
  padded.set(stripped, size - stripped.length);
  return padded;
}

// ---- Misc helpers -----------------------------------------------------------

function base64UrlToBytes(b64url: string, size: number): Uint8Array {
  const buf = Buffer.from(b64url, "base64url");
  if (buf.length === size) return buf;
  const padded = Buffer.alloc(size);
  buf.copy(padded, size - buf.length);
  return padded;
}

function countLeadingZeros(data: Buffer): number {
  let zeros = 0;
  for (const b of data) {
    if (b === 0) {
      zeros += 8;
    } else {
      for (let i = 0; i < 8; i++) {
        if ((b & (1 << i)) === 0) zeros++;
        else return zeros;
      }
    }
  }
  return zeros;
}
