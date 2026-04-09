import {
  createSign,
  createVerify,
  createHash,
  createECDH,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { InvalidIdentityError } from "../errors.js";

const P256_SCALAR_SIZE = 32;
const P256_UNCOMPRESSED_KEY_SIZE = 65;
const P256_POINT_PREFIX = 0x04;

export class Identity {
  readonly privateKey: KeyObject;
  offset: bigint;

  constructor(privateKey: KeyObject, offset: bigint) {
    this.privateKey = privateKey;
    this.offset = offset;
  }

  publicKeyBase64(): string {
    const pubKey = createPublicKey(this.privateKey);
    const rawJwk = pubKey.export({ format: "jwk" });

    if (
      rawJwk.x === undefined ||
      rawJwk.y === undefined ||
      typeof rawJwk.x !== "string" ||
      typeof rawJwk.y !== "string"
    ) {
      return "";
    }

    const xBytes = base64UrlToBytes(rawJwk.x, P256_SCALAR_SIZE);
    const yBytes = base64UrlToBytes(rawJwk.y, P256_SCALAR_SIZE);

    // Encode as TS3 canonical ASN.1: SEQUENCE { BIT STRING, INTEGER(32), INTEGER(x), INTEGER(y) }
    return encodeTsPublicKey(xBytes, yBytes);
  }

  toString(): string {
    const jwk = this.privateKey.export({ format: "jwk" }) as { d?: string };
    if (!jwk.d) {
      return `:${this.offset}`;
    }
    // Convert base64url d to fixed-size standard base64
    const dBytes = base64UrlToBytes(jwk.d, P256_SCALAR_SIZE);
    return `${Buffer.from(dBytes).toString("base64")}:${this.offset}`;
  }

  securityLevel(): number {
    const h = createHash("sha1");
    h.update(this.publicKeyBase64());
    h.update(this.offset.toString(10));
    return countLeadingZeros(h.digest());
  }

  async upgradeToLevel(targetLevel: number, signal?: AbortSignal): Promise<void> {
    const prefix = this.publicKeyBase64();
    while (true) {
      if (signal?.aborted) throw signal.reason as Error;
      const h = createHash("sha1");
      h.update(prefix);
      h.update(this.offset.toString(10));
      if (countLeadingZeros(h.digest()) >= targetLevel) return;
      this.offset++;
      // Yield to event loop periodically to avoid blocking
      if (this.offset % 10000n === 0n) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
}

export function identityFromString(s: string): Identity {
  const colonIdx = s.lastIndexOf(":");
  if (colonIdx < 0) throw new InvalidIdentityError();

  const dBase64 = s.slice(0, colonIdx);
  const offsetStr = s.slice(colonIdx + 1);

  const dBytes = Buffer.from(dBase64, "base64");
  const offset = BigInt(offsetStr);

  if (dBytes.length > P256_SCALAR_SIZE) {
    throw new InvalidIdentityError("private key scalar too large");
  }

  // Pad to P256_SCALAR_SIZE
  const padded = Buffer.alloc(P256_SCALAR_SIZE);
  dBytes.copy(padded, P256_SCALAR_SIZE - dBytes.length);

  // node:crypto JWK import requires x and y to be present.
  // Derive the public key from the private scalar via ECDH.
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(padded);
  const pub = ecdh.getPublicKey(null, "uncompressed"); // 65 bytes: 0x04 || x(32) || y(32)

  const x = Buffer.from(pub.slice(1, 33)).toString("base64url");
  const y = Buffer.from(pub.slice(33, 65)).toString("base64url");
  const d = padded.toString("base64url");

  const jwk = { kty: "EC", crv: "P-256", d, x, y };
  const privateKey = createPrivateKey({ key: jwk as unknown as string, format: "jwk" });
  return new Identity(privateKey, offset);
}

export function generateIdentity(targetLevel: number): Identity {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const id = new Identity(privateKey, 0n);

  const prefix = id.publicKeyBase64();
  while (true) {
    const h = createHash("sha1");
    h.update(prefix);
    h.update(id.offset.toString(10));
    if (countLeadingZeros(h.digest()) >= targetLevel) return id;
    id.offset++;
  }
}

export function getUidFromPublicKey(publicKey: string): string {
  const sum = createHash("sha1").update(publicKey).digest();
  return Buffer.from(sum).toString("base64");
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
