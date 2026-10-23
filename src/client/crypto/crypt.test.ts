import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Crypt } from "./crypt.js";
import { generateIdentitySync } from "./identity.js";
import { HandshakeError } from "../errors.js";

const identity = generateIdentitySync(0);

describe("Crypt", () => {
  it("derives no session key before crypto init", () => {
    const crypt = new Crypt(identity);
    expect(() => crypt.getKeyNonce(true, 1, 0, 2, false)).toThrow(HandshakeError);
    // The dummy key is still there for the handshake.
    expect(crypt.getKeyNonce(true, 1, 0, 2, true)[0]).toHaveLength(16);
  });

  it("forgets the keys of an IV it replaces", () => {
    const crypt = new Crypt(identity);
    crypt.setSharedSecret(randomBytes(10), randomBytes(54), randomBytes(64));
    const first = crypt.getKeyNonce(true, 1, 0, 2, false);

    const alpha = randomBytes(10);
    const beta = randomBytes(54);
    const secret = randomBytes(64);
    crypt.setSharedSecret(alpha, beta, secret);
    const reference = new Crypt(identity);
    reference.setSharedSecret(alpha, beta, secret);

    const second = crypt.getKeyNonce(true, 1, 0, 2, false);
    expect(second).not.toEqual(first);
    expect(second).toEqual(reference.getKeyNonce(true, 1, 0, 2, false));
  });

  it("refuses an alpha, beta and secret that do not fit together", () => {
    const refused: Array<[number, number, number]> = [
      [9, 54, 64],
      [11, 54, 64],
      [10, 0, 64],
      [10, 54, 63],
    ];
    for (const [alpha, beta, secret] of refused) {
      const crypt = new Crypt(identity);
      expect(() =>
        crypt.setSharedSecret(randomBytes(alpha), randomBytes(beta), randomBytes(secret)),
      ).toThrow(HandshakeError);
      expect(crypt.cryptoInitComplete).toBe(false);
    }
  });
});
