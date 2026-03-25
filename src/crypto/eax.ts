import { createCipheriv, timingSafeEqual } from "node:crypto";
import { EAXTagMismatchError } from "../errors.js";

const EAX_TAG_SIZE = 8;
const EAX_BLOCK_SIZE = 16;

/**
 * AES-EAX AEAD implementation for TS3 (64-bit tag, AES-128).
 * Uses AES-CMAC for authentication and AES-CTR for encryption.
 */
export class EAX {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.length !== 16) throw new Error("EAX requires a 16-byte key");
    this.#key = key;
  }

  encrypt(
    nonce: Uint8Array,
    header: Uint8Array,
    plaintext: Uint8Array,
  ): [ciphertext: Uint8Array, tag: Uint8Array] {
    const nStar = this.#cmac(0, nonce);
    const hStar = this.#cmac(1, header);

    const ciphertext = aesCtr(this.#key, nStar, plaintext);

    const cStar = this.#cmac(2, ciphertext);

    const tag = new Uint8Array(EAX_TAG_SIZE);
    for (let i = 0; i < EAX_TAG_SIZE; i++) {
      tag[i] = nStar[i]! ^ hStar[i]! ^ cStar[i]!;
    }

    return [ciphertext, tag];
  }

  decrypt(
    nonce: Uint8Array,
    header: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ): Uint8Array {
    const nStar = this.#cmac(0, nonce);
    const hStar = this.#cmac(1, header);
    const cStar = this.#cmac(2, ciphertext);

    const expected = new Uint8Array(EAX_TAG_SIZE);
    for (let i = 0; i < EAX_TAG_SIZE; i++) {
      expected[i] = nStar[i]! ^ hStar[i]! ^ cStar[i]!;
    }

    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(tag.slice(0, EAX_TAG_SIZE)))) {
      throw new EAXTagMismatchError();
    }

    return aesCtr(this.#key, nStar, ciphertext);
  }

  /**
   * AES-CMAC per RFC 4493:
   *   input = [0…0 tag] ++ data   (one block prefix)
   */
  #cmac(tagByte: number, data: Uint8Array): Uint8Array {
    const input = new Uint8Array(EAX_BLOCK_SIZE + data.length);
    // first block: zeros then tag byte at the last position
    input[EAX_BLOCK_SIZE - 1] = tagByte;
    input.set(data, EAX_BLOCK_SIZE);

    return aesCmac(this.#key, input);
  }
}

// ---- AES-CTR ----------------------------------------------------------------

function aesCtr(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ctr", Buffer.from(key), Buffer.from(iv));
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
}

// ---- AES-CMAC (RFC 4493) ----------------------------------------------------

function aesEcb(key: Uint8Array, block: Uint8Array): Uint8Array {
  // Node.js does not expose ECB directly; simulate via CTR with zero IV and
  // a zero-input (CTR of 0-block XOR with input = ECB)
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.from(block)), cipher.final()]);
}

function xorBlock(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(EAX_BLOCK_SIZE);
  for (let i = 0; i < EAX_BLOCK_SIZE; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

function shiftLeft1(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(EAX_BLOCK_SIZE);
  let carry = 0;
  for (let i = EAX_BLOCK_SIZE - 1; i >= 0; i--) {
    const shifted = ((b[i]! << 1) | carry) & 0xff;
    carry = b[i]! >> 7;
    out[i] = shifted;
  }
  return out;
}

const RB = new Uint8Array(EAX_BLOCK_SIZE);
RB[EAX_BLOCK_SIZE - 1] = 0x87;

function generateSubkeys(key: Uint8Array): [Uint8Array, Uint8Array] {
  const zero = new Uint8Array(EAX_BLOCK_SIZE);
  const L = aesEcb(key, zero);

  let K1 = shiftLeft1(L);
  if ((L[0]! & 0x80) !== 0) K1 = xorBlock(K1, RB);

  let K2 = shiftLeft1(K1);
  if ((K1[0]! & 0x80) !== 0) K2 = xorBlock(K2, RB);

  return [K1, K2];
}

export function aesCmac(key: Uint8Array, message: Uint8Array): Uint8Array {
  const [K1, K2] = generateSubkeys(key);

  const n = Math.max(1, Math.ceil(message.length / EAX_BLOCK_SIZE));
  const lastBlockComplete = message.length > 0 && message.length % EAX_BLOCK_SIZE === 0;

  let X: Uint8Array = new Uint8Array(EAX_BLOCK_SIZE);

  for (let i = 0; i < n - 1; i++) {
    const block = message.slice(i * EAX_BLOCK_SIZE, (i + 1) * EAX_BLOCK_SIZE);
    X = Uint8Array.from(aesEcb(key, xorBlock(X, block)));
  }

  const lastBlock = new Uint8Array(EAX_BLOCK_SIZE);
  const lastStart = (n - 1) * EAX_BLOCK_SIZE;
  const lastSlice = message.slice(lastStart);
  lastBlock.set(lastSlice);

  let Mn: Uint8Array;
  if (lastBlockComplete) {
    Mn = xorBlock(lastBlock, K1);
  } else {
    if (lastSlice.length < EAX_BLOCK_SIZE) lastBlock[lastSlice.length] = 0x80;
    Mn = xorBlock(lastBlock, K2);
  }

  return Uint8Array.from(aesEcb(key, xorBlock(X, Mn)));
}
