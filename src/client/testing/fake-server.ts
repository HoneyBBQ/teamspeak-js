/**
 * Test doubles for the receive path: a socket the test feeds datagrams into,
 * and builders for the datagrams a server sends. Not part of the package.
 */

import type { Crypt } from "../crypto/crypt.js";
import { EAX } from "../crypto/eax.js";
import type { DatagramSocket } from "../types.js";

/** A deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UDP socket stand-in: records what the client sends, and delivers what the test injects. */
export class FakeSocket implements DatagramSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  #message: Array<(message: Uint8Array) => void> = [];
  #error: Array<(error: Error) => void> = [];
  #close: Array<() => void> = [];

  connect(_port: number, _address: string, callback: () => void): void {
    callback();
  }

  send(data: Uint8Array, callback: (error: Error | null) => void): void {
    this.sent.push(Uint8Array.from(data));
    callback(null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#close) listener();
  }

  on(event: "message", listener: (message: Uint8Array) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "message") this.#message.push(listener as (message: Uint8Array) => void);
    if (event === "error") this.#error.push(listener as (error: Error) => void);
    if (event === "close") this.#close.push(listener);
    return this;
  }

  once(event: "error", listener: (error: Error) => void): this {
    this.#error.push(listener);
    return this;
  }

  off(event: "error", listener: (error: Error) => void): this {
    this.#error = this.#error.filter((l) => l !== listener);
    return this;
  }

  /** Hand the client one datagram, synchronously, as the socket would. */
  deliver(data: Uint8Array): void {
    const buffer = Buffer.from(data);
    for (const listener of this.#message) listener(buffer);
  }
}

/** The 3-byte header of a server-to-client packet. */
export function s2cHeader(id: number, typeFlagged: number): Uint8Array {
  return Uint8Array.of((id >> 8) & 0xff, id & 0xff, typeFlagged & 0xff);
}

/** Frame a packet: tag, header, payload. */
export function datagram(tag: Uint8Array, header: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + header.length + payload.length);
  out.set(tag.subarray(0, 8), 0);
  out.set(header, 8);
  out.set(payload, 8 + header.length);
  return out;
}

/** An Init1 packet, which carries the fixed `TS3INIT1` tag and no encryption. */
export function init1Packet(payload: Uint8Array): Uint8Array {
  return datagram(new TextEncoder().encode("TS3INIT1"), s2cHeader(101, 8), payload);
}

/** A packet under the public dummy key, as the server sends before crypto init. */
export function dummyPacket(
  crypt: Crypt,
  type: number,
  flags: number,
  id: number,
  payload: Uint8Array,
): Uint8Array {
  const header = s2cHeader(id, type | flags);
  const [key, nonce] = crypt.getKeyNonce(true, id, 0, type, true);
  const [ciphertext, tag] = new EAX(key).encrypt(nonce, header, payload);
  return datagram(tag, header, ciphertext);
}

/** A packet under the session key `crypt` holds, as the server sends after crypto init. */
export function sessionPacket(
  crypt: Crypt,
  type: number,
  flags: number,
  id: number,
  payload: Uint8Array,
  generation = 0,
): Uint8Array {
  const header = s2cHeader(id, type | flags);
  const [key, nonce] = crypt.getKeyNonce(true, id, generation, type, false);
  const [ciphertext, tag] = new EAX(key).encrypt(nonce, header, payload);
  return datagram(tag, header, ciphertext);
}

/** An unencrypted packet signed with `fakeSignature`. */
export function plainPacket(
  fakeSignature: Uint8Array,
  type: number,
  flags: number,
  id: number,
  payload: Uint8Array,
): Uint8Array {
  return datagram(fakeSignature, s2cHeader(id, type | flags | 0x80), payload);
}

/** Complete crypto init with fixed keys, as the handshake would have. */
export function completeCryptoInit(crypt: Crypt): void {
  crypt.setSharedSecret(
    new Uint8Array(10).fill(7),
    new Uint8Array(54).fill(9),
    new Uint8Array(64).fill(3),
  );
}
