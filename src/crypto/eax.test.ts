import { describe, it, expect } from "vitest";
import { EAX } from "./eax.js";
import { EAXTagMismatchError } from "../errors.js";

describe("EAX", () => {
  // Use a fixed test vector key, nonce, header, plaintext
  const key = new Uint8Array(16).fill(0x01);
  const nonce = new Uint8Array(16).fill(0x02);
  const header = new Uint8Array(5).fill(0x03);
  const plaintext = Buffer.from("hello teamspeak");

  it("encrypts and decrypts round-trip", () => {
    const eax = new EAX(key);
    const [ciphertext, tag] = eax.encrypt(nonce, header, plaintext);

    expect(ciphertext).toHaveLength(plaintext.length);
    expect(tag).toHaveLength(8);

    const decrypted = eax.decrypt(nonce, header, ciphertext, tag);
    expect(Buffer.from(decrypted).toString()).toBe("hello teamspeak");
  });

  it("ciphertext differs from plaintext", () => {
    const eax = new EAX(key);
    const [ciphertext] = eax.encrypt(nonce, header, plaintext);
    expect(Buffer.from(ciphertext).toString("hex")).not.toBe(
      Buffer.from(plaintext).toString("hex"),
    );
  });

  it("throws EAXTagMismatchError when tag is corrupted", () => {
    const eax = new EAX(key);
    const result = eax.encrypt(nonce, header, plaintext);
    const badTag = Uint8Array.from(result[1]);
    badTag[0] = (badTag[0] ?? 0) ^ 0xff;

    expect(() => eax.decrypt(nonce, header, result[0], badTag)).toThrow(EAXTagMismatchError);
  });

  it("throws when ciphertext is tampered", () => {
    const eax = new EAX(key);
    const result = eax.encrypt(nonce, header, plaintext);
    const badCipher = Uint8Array.from(result[0]);
    badCipher[0] = (badCipher[0] ?? 0) ^ 0xff;

    expect(() => eax.decrypt(nonce, header, badCipher, result[1])).toThrow(EAXTagMismatchError);
  });

  it("different keys produce different ciphertexts", () => {
    const key2 = new Uint8Array(16).fill(0x99);
    const r1 = new EAX(key).encrypt(nonce, header, plaintext);
    const r2 = new EAX(key2).encrypt(nonce, header, plaintext);
    expect(Buffer.from(r1[0]).toString("hex")).not.toBe(Buffer.from(r2[0]).toString("hex"));
  });
});
