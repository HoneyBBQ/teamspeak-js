import { createHash, createECDH } from "node:crypto";
import { FakeSignatureMismatchError } from "../errors.js";
import type { Identity } from "./identity.js";
import { importPublicKey } from "./identity.js";
import { EAX } from "./eax.js";

const FAKE_SIGNATURE_SIZE = 8;
const IV_ALPHA_SIZE = 10;
const INIT1_PACKET_TYPE = 8;
const PACKET_TYPE_MASK = 0x0f;

const INIT1_MAC = Buffer.from("TS3INIT1");

export interface KeyNonce {
  key: Uint8Array;
  nonce: Uint8Array;
  gen: number;
}

/** Precomputed dummy key/nonce matching the TS3 client pre-crypto placeholder. */
const DUMMY_KEY = Buffer.from("c:\\windows\\syste");
const DUMMY_NONCE = Buffer.from("m\\firewall32.cpl");

export class Crypt {
  readonly identity: Identity;

  ivStruct: Uint8Array = new Uint8Array(0);
  fakeSignature: Uint8Array = new Uint8Array(FAKE_SIGNATURE_SIZE);
  alphaTmp: Uint8Array = new Uint8Array(0);
  cryptoInitComplete = false;

  readonly #cachedKeys = new Map<bigint, KeyNonce>();

  constructor(identity: Identity) {
    this.identity = identity;
  }

  solveRsaChallenge(data: Uint8Array, offset: number, level: number): Uint8Array {
    if (level < 0 || level > 1_000_000) {
      throw new Error("RSA challenge level out of range");
    }

    const xBytes = data.slice(offset, offset + 64);
    const nBytes = data.slice(offset + 64, offset + 128);

    let y = bytesToBigInt(xBytes);
    const n = bytesToBigInt(nBytes);

    for (let i = 0; i < level; i++) {
      y = (y * y) % n;
    }

    return bigIntToBytes(y, 64);
  }

  initCrypto(alpha: string, beta: string, omega: string): void {
    const alphaBytes = Buffer.from(alpha, "base64");
    const betaBytes = Buffer.from(beta, "base64");
    const omegaBytes = Buffer.from(omega, "base64");

    const serverPubKey = importPublicKey(omegaBytes);
    const sharedSecret = this.#getSharedSecret(serverPubKey);

    this.setSharedSecret(alphaBytes, betaBytes, sharedSecret);
  }

  setSharedSecret(alpha: Uint8Array, beta: Uint8Array, sharedKey: Uint8Array): void {
    this.ivStruct = new Uint8Array(IV_ALPHA_SIZE + beta.length);
    for (let i = 0; i < IV_ALPHA_SIZE; i++) {
      const a = sharedKey[i];
      const b = alpha[i];
      this.ivStruct[i] = ((a !== undefined ? a : 0) ^ (b !== undefined ? b : 0)) & 0xff;
    }
    for (let i = 0; i < beta.length; i++) {
      const a = sharedKey[IV_ALPHA_SIZE + i];
      const b = beta[i];
      this.ivStruct[IV_ALPHA_SIZE + i] =
        ((a !== undefined ? a : 0) ^ (b !== undefined ? b : 0)) & 0xff;
    }

    const digest = createHash("sha1").update(this.ivStruct).digest();
    this.fakeSignature = new Uint8Array(digest.buffer, digest.byteOffset, FAKE_SIGNATURE_SIZE);
    this.cryptoInitComplete = true;
  }

  getKeyNonce(
    fromServer: boolean,
    packetID: number,
    generationID: number,
    packetType: number,
    dummy: boolean,
  ): [key: Uint8Array, nonce: Uint8Array] {
    if (dummy) {
      return [Uint8Array.from(DUMMY_KEY), Uint8Array.from(DUMMY_NONCE)];
    }

    const cacheKey = makeCacheKey(fromServer, packetType, generationID);
    let kn = this.#cachedKeys.get(cacheKey);

    if (kn === undefined) {
      const tmpToHash = new Uint8Array(6 + this.ivStruct.length);
      tmpToHash[0] = fromServer ? 0x30 : 0x31;
      tmpToHash[1] = packetType & PACKET_TYPE_MASK;
      new DataView(tmpToHash.buffer).setUint32(2, generationID, false);
      tmpToHash.set(this.ivStruct, 6);

      const hash = createHash("sha256").update(tmpToHash).digest();
      kn = {
        key: Uint8Array.from(hash.slice(0, 16)),
        nonce: Uint8Array.from(hash.slice(16, 32)),
        gen: generationID,
      };
      this.#cachedKeys.set(cacheKey, kn);
    }

    const key = Uint8Array.from(kn.key);
    key[0] = (key[0] !== undefined ? key[0] : 0) ^ ((packetID >> 8) & 0xff);
    key[1] = (key[1] !== undefined ? key[1] : 0) ^ (packetID & 0xff);

    return [key, kn.nonce];
  }

  encrypt(
    packetType: number,
    packetID: number,
    generationID: number,
    header: Uint8Array,
    plaintext: Uint8Array,
    dummy: boolean,
    unencrypted: boolean,
  ): [ciphertext: Uint8Array, mac: Uint8Array] {
    if (packetType === INIT1_PACKET_TYPE) {
      return [plaintext, INIT1_MAC];
    }
    if (unencrypted) {
      return [plaintext, this.fakeSignature];
    }

    const [key, nonce] = this.getKeyNonce(false, packetID, generationID, packetType, dummy);
    const eax = new EAX(key);
    return eax.encrypt(nonce, header, plaintext);
  }

  decrypt(
    packetType: number,
    packetID: number,
    generationID: number,
    header: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
    dummy: boolean,
    unencrypted: boolean,
  ): Uint8Array {
    if (packetType === INIT1_PACKET_TYPE) {
      return ciphertext;
    }
    if (unencrypted) {
      const fsSub = tag.slice(0, FAKE_SIGNATURE_SIZE);
      if (!Buffer.from(fsSub).equals(Buffer.from(this.fakeSignature))) {
        throw new FakeSignatureMismatchError();
      }
      return ciphertext;
    }

    const [key, nonce] = this.getKeyNonce(true, packetID, generationID, packetType, dummy);
    const eax = new EAX(key);
    return eax.decrypt(nonce, header, ciphertext, tag);
  }

  #getSharedSecret(serverPubKey: import("node:crypto").KeyObject): Uint8Array {
    const privJwk = this.identity.privateKey.export({ format: "jwk" }) as {
      d: string;
    };
    const pubJwk = serverPubKey.export({ format: "jwk" }) as {
      x: string;
      y: string;
    };

    const ecdh = createECDH("prime256v1");
    const dBytes = Buffer.from(privJwk.d, "base64url");
    ecdh.setPrivateKey(dBytes);

    const xBytes = base64UrlToBytes(pubJwk.x, 32);
    const yBytes = base64UrlToBytes(pubJwk.y, 32);
    const uncompressed = Buffer.alloc(65);
    uncompressed[0] = 0x04;
    xBytes.copy(uncompressed, 1);
    yBytes.copy(uncompressed, 33);

    const rawSecret = ecdh.computeSecret(uncompressed);
    return createHash("sha1").update(rawSecret).digest();
  }
}

// ---- Helpers ----------------------------------------------------------------

function makeCacheKey(fromServer: boolean, packetType: number, generationID: number): bigint {
  let key = 0n;
  if (fromServer) key |= 1n << 40n;
  key |= BigInt(packetType & PACKET_TYPE_MASK) << 32n;
  key |= BigInt(generationID);
  return key;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

function bigIntToBytes(value: bigint, size: number): Uint8Array {
  const result = new Uint8Array(size);
  let v = value;
  for (let i = size - 1; i >= 0; i--) {
    result[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return result;
}

function base64UrlToBytes(b64url: string, size: number): Buffer {
  const buf = Buffer.from(b64url, "base64url");
  if (buf.length === size) return buf;
  const padded = Buffer.alloc(size);
  buf.copy(padded, size - buf.length);
  return padded;
}
