import { describe, expect, it } from "vitest";
import { aesCmac } from "./eax.js";

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s.replace(/\s/g, ""), "hex"));

// RFC 4493, section 4: the four examples, one per padding case.
describe("aesCmac", () => {
  const key = hex("2b7e1516 28aed2a6 abf71588 09cf4f3c");
  const message = hex(
    `6bc1bee2 2e409f96 e93d7e11 7393172a ae2d8a57 1e03ac9c 9eb76fac 45af8e51
     30c81c46 a35ce411 e5fbc119 1a0a52ef f69f2445 df4f9b17 ad2b417b e66c3710`,
  );

  it.each([
    [0, "bb1d6929 e9593728 7fa37d12 9b756746"],
    [16, "070a16b4 6b4d4144 f79bdd9d d04a287c"],
    [40, "dfa66747 de9ae630 30ca3261 1497c827"],
    [64, "51f0bebf 7e3b9d92 fc497417 79363cfe"],
  ])("matches RFC 4493 for a %i-byte message", (length, mac) => {
    expect(Buffer.from(aesCmac(key, message.subarray(0, length)))).toEqual(Buffer.from(hex(mac)));
  });

  it("gives the same answer for a key it has seen and a copy of it", () => {
    const first = aesCmac(key, message.subarray(0, 40));
    expect(aesCmac(Uint8Array.from(key), message.subarray(0, 40))).toEqual(first);
    expect(aesCmac(key, message.subarray(0, 40))).toEqual(first);
  });
});
