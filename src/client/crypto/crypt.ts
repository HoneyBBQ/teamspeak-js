import { createHash, createECDH, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { HandshakeError, FakeSignatureMismatchError, PuzzleTooHardError } from "../errors.js";
import type { Identity } from "./identity.js";
import { identityPrivateKey, importPublicKey } from "./identity.js";
import { EAX } from "./eax.js";

const FAKE_SIGNATURE_SIZE = 8;
const IV_ALPHA_SIZE = 10;
const INIT1_PACKET_TYPE = 8;
const PACKET_TYPE_MASK = 0x0f;

const INIT1_MAC = Buffer.from("TS3INIT1");

/**
 * The most squarings the Init1 puzzle may ask for. A server raises its puzzle
 * level while it is flooded with connections. Measured, TS3 3.13 and TS6 6.0
 * both ask for 10000 when calm, 100000 at protection level 1 and 1000000 at
 * level 2, the highest they reach; a level lasts about 75 seconds after the
 * burst that raised it. A squaring takes about 0.3 microseconds here, so those
 * take 3 ms, 30 ms and 300 ms. The cap is four times the highest level seen,
 * 1.2 s of work here. The solve gives the event loop back every
 * {@link SQUARINGS_PER_SLICE} squarings and stops when the connect is
 * cancelled, so a level near the cap costs the caller at most what the caller
 * allows the connect to take, and blocks nothing in the meantime; a level above
 * it is refused with a {@link PuzzleTooHardError}.
 */
export const MAX_RSA_CHALLENGE_LEVEL: number = 4_000_000;

/**
 * How many squarings the solve does before it lets the event loop run: about
 * 15 ms of work, so a timer or another connection waits no longer than that.
 */
export const SQUARINGS_PER_SLICE = 50_000;

export interface KeyNonce {
  key: Uint8Array;
  nonce: Uint8Array;
  gen: number;
}

/** Precomputed dummy key/nonce matching the TS3 client pre-crypto placeholder. */
const DUMMY_KEY = Buffer.from("c:\\windows\\syste");
const DUMMY_NONCE = Buffer.from("m\\firewall32.cpl");

/**
 * A connection's encryption state. The session material — the IV the keys
 * derive from — lives in private fields, so it shows in no `util.inspect()`
 * or `JSON.stringify()` of anything holding a Crypt.
 */
export class Crypt {
  readonly identity: Identity;

  #ivStruct: Uint8Array = new Uint8Array(0);
  #fakeSignature: Uint8Array = new Uint8Array(FAKE_SIGNATURE_SIZE);
  #alpha: Uint8Array = new Uint8Array(0);
  #cryptoInitComplete = false;

  readonly #cachedKeys = new Map<bigint, KeyNonce>();

  constructor(identity: Identity) {
    this.identity = identity;
  }

  /** Whether the session keys are set up; until then packets use the dummy key. */
  get cryptoInitComplete(): boolean {
    return this.#cryptoInitComplete;
  }

  /** The signature unencrypted packets carry: zeros until crypto init completes. */
  get fakeSignature(): Uint8Array {
    return this.#fakeSignature;
  }

  /** The client's random contribution to the IV, sent in clientinitiv; empty before. */
  get alpha(): Uint8Array {
    return this.#alpha;
  }

  /** Choose the client's random contribution to the IV, and return it. */
  newAlpha(): Uint8Array {
    this.#alpha = new Uint8Array(randomBytes(IV_ALPHA_SIZE));
    return this.#alpha;
  }

  /**
   * Answer the Init1 puzzle: square `x` modulo `n` `level` times, `x` and `n`
   * being the two 64-byte numbers at `offset` in `data`. Rejects with a
   * {@link PuzzleTooHardError} for a level above {@link MAX_RSA_CHALLENGE_LEVEL},
   * with a {@link HandshakeError} for a level or modulus that is no puzzle, and
   * with `signal`'s reason when it aborts, checked between slices of
   * {@link SQUARINGS_PER_SLICE} squarings.
   */
  async solveRsaChallenge(
    data: Uint8Array,
    offset: number,
    level: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isInteger(level) || level < 0) {
      throw new HandshakeError(`RSA challenge level ${level} out of range`);
    }
    if (level > MAX_RSA_CHALLENGE_LEVEL) {
      throw new PuzzleTooHardError(level, MAX_RSA_CHALLENGE_LEVEL);
    }

    const xBytes = data.slice(offset, offset + 64);
    const nBytes = data.slice(offset + 64, offset + 128);

    let y = bytesToBigInt(xBytes);
    const n = bytesToBigInt(nBytes);
    if (n === 0n) throw new HandshakeError("RSA challenge modulus is zero");

    for (let done = 0; done < level;) {
      signal?.throwIfAborted();
      const slice = level - done < SQUARINGS_PER_SLICE ? level - done : SQUARINGS_PER_SLICE;
      for (let i = 0; i < slice; i++) {
        y = (y * y) % n;
      }
      done += slice;
      if (done < level) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();

    return bigIntToBytes(y, 64);
  }

  initCrypto(alpha: string, beta: string, omega: string): void {
    const alphaBytes = Buffer.from(alpha, "base64");
    const betaBytes = Buffer.from(beta, "base64");
    const omegaBytes = Buffer.from(omega, "base64");

    let sharedSecret: Uint8Array;
    try {
      sharedSecret = this.#getSharedSecret(importPublicKey(omegaBytes));
    } catch (error) {
      throw new HandshakeError("the server's public key is invalid", { cause: error });
    }

    this.setSharedSecret(alphaBytes, betaBytes, sharedSecret);
  }

  /**
   * Build the IV from `alpha` and `beta` XORed into `sharedKey` and complete
   * crypto init. The values come from the server, so a length that does not fit
   * is refused rather than padded: alpha must be 10 bytes, beta at least one,
   * and the key as long as the IV, 10 bytes plus beta.
   */
  setSharedSecret(alpha: Uint8Array, beta: Uint8Array, sharedKey: Uint8Array): void {
    if (
      alpha.length !== IV_ALPHA_SIZE ||
      beta.length === 0 ||
      IV_ALPHA_SIZE + beta.length > sharedKey.length
    ) {
      throw new HandshakeError("alpha, beta and the shared secret do not fit together");
    }
    this.#ivStruct = new Uint8Array(IV_ALPHA_SIZE + beta.length);
    for (let i = 0; i < IV_ALPHA_SIZE; i++) {
      this.#ivStruct[i] = (sharedKey[i]! ^ alpha[i]!) & 0xff;
    }
    for (let i = 0; i < beta.length; i++) {
      this.#ivStruct[IV_ALPHA_SIZE + i] = (sharedKey[IV_ALPHA_SIZE + i]! ^ beta[i]!) & 0xff;
    }

    // Keys derive from the IV: any cached before it changed belong to another
    // IV, the empty one before crypto init in particular, which is public.
    this.#cachedKeys.clear();

    const digest = createHash("sha1").update(this.#ivStruct).digest();
    this.#fakeSignature = new Uint8Array(digest.buffer, digest.byteOffset, FAKE_SIGNATURE_SIZE);
    this.#cryptoInitComplete = true;
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
    // Before crypto init there is no IV, and a key derived from the empty one
    // is a key anyone can compute.
    if (!this.#cryptoInitComplete) {
      throw new HandshakeError("no session key before crypto init completes");
    }

    const cacheKey = makeCacheKey(fromServer, packetType, generationID);
    let kn = this.#cachedKeys.get(cacheKey);

    if (kn === undefined) {
      const tmpToHash = new Uint8Array(6 + this.#ivStruct.length);
      tmpToHash[0] = fromServer ? 0x30 : 0x31;
      tmpToHash[1] = packetType & PACKET_TYPE_MASK;
      new DataView(tmpToHash.buffer).setUint32(2, generationID, false);
      tmpToHash.set(this.#ivStruct, 6);

      const hash = createHash("sha256").update(tmpToHash).digest();
      kn = {
        key: Uint8Array.from(hash.subarray(0, 16)),
        nonce: Uint8Array.from(hash.subarray(16, 32)),
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
      return [plaintext, this.#fakeSignature];
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
      if (!Buffer.from(fsSub).equals(Buffer.from(this.#fakeSignature))) {
        throw new FakeSignatureMismatchError();
      }
      return ciphertext;
    }

    const [key, nonce] = this.getKeyNonce(true, packetID, generationID, packetType, dummy);
    const eax = new EAX(key);
    return eax.decrypt(nonce, header, ciphertext, tag);
  }

  #getSharedSecret(serverPubKey: KeyObject): Uint8Array {
    const privJwk = identityPrivateKey(this.identity).export({ format: "jwk" }) as {
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
