import { hash512 } from "../crypto/identity.js";
import { clampScalar, scalarMultFull, bytesToBigIntLE } from "../crypto/primitives.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// The root key is a 33-byte Ed25519 point
const LICENSE_ROOT_KEY = new Uint8Array([
  0xcd, 0x0d, 0xe2, 0xae, 0xd4, 0x63, 0x45, 0x50, 0x9a, 0x7e, 0x3c, 0xfd, 0x8f, 0x68, 0xb3, 0xdc,
  0x75, 0x55, 0xb2, 0x9d, 0xcc, 0xec, 0x73, 0xcd, 0x18, 0x75, 0x0f, 0x99, 0x38, 0x12, 0x40, 0x8a,
]);

const enum LicenseBlockType {
  Intermediate = 0,
  Server = 2,
  Ts5Server = 8,
  Ephemeral = 32,
}

interface LicenseBlock {
  readonly key: Uint8Array; // 32-byte Ed25519 point
  readonly hash: Uint8Array; // SHA-512 truncated to 32 bytes
  properties: Uint8Array[];
  issuer: string;
  notValidBefore: Date;
  notValidAfter: Date;
  blockType: LicenseBlockType;
  serverType: number;
}

export class LicenseChain {
  readonly blocks: LicenseBlock[];

  constructor(blocks: LicenseBlock[]) {
    this.blocks = blocks;
  }

  /**
   * Derive the session key by chaining Ed25519 point arithmetic starting from
   * the root key through each license block.
   */
  deriveKey(): Uint8Array<ArrayBuffer> {
    let round: Uint8Array<ArrayBuffer> = Uint8Array.from(LICENSE_ROOT_KEY);
    for (const block of this.blocks) {
      round = deriveKeyFromBlock(block, round);
    }
    return round;
  }
}

export function parseLicenses(data: Uint8Array): LicenseChain {
  if (data.length < 1) throw new Error("license too short");
  if (data[0] !== 1) throw new Error("unsupported license version");

  let remaining = data.slice(1);
  const blocks: LicenseBlock[] = [];

  while (remaining.length > 0) {
    const { block, consumed } = parseLicenseBlock(remaining);
    blocks.push(block);
    remaining = remaining.slice(consumed);
  }

  return new LicenseChain(blocks);
}

function parseLicenseBlock(data: Uint8Array): { block: LicenseBlock; consumed: number } {
  const MIN_BLOCK_LEN = 42;
  if (data.length < MIN_BLOCK_LEN) throw new Error("license too short");
  if (data[0] !== 0) throw new Error(`wrong key kind in license: ${data[0]}`);

  const blockType = data[33] as LicenseBlockType;

  // Timestamps are seconds since Unix epoch offset by 0x50e22700
  const UNIX_OFFSET = 0x50e22700;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const notValidBefore = new Date((view.getUint32(34, false) + UNIX_OFFSET) * 1000);
  const notValidAfter = new Date((view.getUint32(38, false) + UNIX_OFFSET) * 1000);

  if (notValidAfter < notValidBefore) {
    throw new Error("license times are invalid");
  }

  const key = Uint8Array.from(data.slice(1, 33));

  const { payload, payloadRead } = parseBlockPayload(blockType, data, MIN_BLOCK_LEN);

  const allLen = MIN_BLOCK_LEN + payloadRead;
  const hashInput = data.slice(1, allLen);
  const hashFull = hash512(Uint8Array.from(hashInput));
  const hash = Uint8Array.from(hashFull.slice(0, 32));

  return {
    block: {
      key,
      hash,
      properties: payload.properties,
      issuer: payload.issuer,
      notValidBefore,
      notValidAfter,
      blockType,
      serverType: payload.serverType,
    },
    consumed: allLen,
  };
}

interface BlockPayload {
  issuer: string;
  serverType: number;
  properties: Uint8Array[];
  read: number;
}

function parseBlockPayload(
  blockType: LicenseBlockType,
  data: Uint8Array,
  minBlockLen: number,
): { payload: BlockPayload; payloadRead: number } {
  switch (blockType) {
    case LicenseBlockType.Intermediate: {
      const { str, read } = readNullString(data.slice(46));
      return {
        payload: { issuer: str, serverType: 0, properties: [], read: 5 + read },
        payloadRead: 5 + read,
      };
    }
    case LicenseBlockType.Server: {
      const { str, read } = readNullString(data.slice(47));
      return {
        payload: { issuer: str, serverType: data[42] ?? 0, properties: [], read: 6 + read },
        payloadRead: 6 + read,
      };
    }
    case LicenseBlockType.Ts5Server: {
      const propCount = data[43] !== undefined ? data[43] : 0;
      let pos = 44;
      const properties: Uint8Array[] = [];
      for (let i = 0; i < propCount; i++) {
        if (pos >= data.length) throw new Error("license too short");
        const propLen = data[pos++]!;
        if (pos + propLen > data.length) throw new Error("license too short");
        properties.push(Uint8Array.from(data.slice(pos, pos + propLen)));
        pos += propLen;
      }
      return {
        payload: { issuer: "", serverType: data[42] ?? 0, properties, read: pos - minBlockLen },
        payloadRead: pos - minBlockLen,
      };
    }
    case LicenseBlockType.Ephemeral:
      return { payload: { issuer: "", serverType: 0, properties: [], read: 0 }, payloadRead: 0 };
    default:
      throw new Error(`invalid license block type: ${blockType}`);
  }
}

/**
 * Scan for a null-terminated string and return its content and the index
 * of the null byte (NOT including it in the count, matching Go behaviour).
 * The parent formulas (`5 + read`, `6 + read`) already add 1 for the null.
 */
function readNullString(data: Uint8Array): { str: string; read: number } {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      return { str: new TextDecoder().decode(data.slice(0, i)), read: i };
    }
  }
  throw new Error("non-null-terminated issuer string");
}

/**
 * Derive the next key given a parent key and a license block.
 * Mirrors Go's licenseBlock.deriveKey.
 */
function deriveKeyFromBlock(block: LicenseBlock, parent: Uint8Array): Uint8Array<ArrayBuffer> {
  const scalarBytes = Uint8Array.from(block.hash);
  clampScalar(scalarBytes);

  // Use raw scalar WITHOUT reducing mod n — NaCl's ge_scalarmult_vartime
  // uses the raw 256-bit scalar. Reducing mod n changes the result when
  // the point has a small-order component (Ed25519 cofactor = 8).
  const scalar = bytesToBigIntLE(scalarBytes);

  const pub = ed25519.Point.fromBytes(block.key);
  const negPub = pub.negate();

  const par = ed25519.Point.fromBytes(parent);
  const negPar = par.negate();

  const res = scalarMultFull(negPub, scalar).add(negPar);
  const raw = res.toBytes();
  const final = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
  final.set(raw);
  final[31] = (final[31] !== undefined ? final[31] : 0) ^ 0x80;

  return final;
}
