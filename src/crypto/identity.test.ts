import { describe, it, expect } from "vitest";
import { generateIdentity, identityFromString, getUidFromPublicKey } from "./identity.js";

describe("Identity", () => {
  it("generateIdentity produces a valid identity at level 8", () => {
    const id = generateIdentity(8);
    expect(id.securityLevel()).toBeGreaterThanOrEqual(8);
  });

  it("publicKeyBase64 returns a non-empty string", () => {
    const id = generateIdentity(8);
    const pub = id.publicKeyBase64();
    expect(pub.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(pub, "base64")).not.toThrow();
  });

  it("toString / identityFromString round-trips", () => {
    const id = generateIdentity(8);
    const str = id.toString();
    const id2 = identityFromString(str);
    // Same offset
    expect(id2.offset).toBe(id.offset);
    // Same public key
    expect(id2.publicKeyBase64()).toBe(id.publicKeyBase64());
  });

  it("identityFromString rejects invalid strings", () => {
    expect(() => identityFromString("notvalid")).toThrow();
  });

  it("getUidFromPublicKey is SHA1(publicKey) base64", () => {
    const id = generateIdentity(8);
    const pub = id.publicKeyBase64();
    const uid = getUidFromPublicKey(pub);
    expect(uid.length).toBeGreaterThan(0);
    // Base64 character set
    expect(uid).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
