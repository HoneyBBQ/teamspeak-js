import { utils } from "ssh2";
import { expect, it } from "vitest";
import { newSshKeyPair } from "./ssh-keys.js";

it("makes keys ssh2 parses, and the public line matches the private key", () => {
  // 3,000 keys: with ssh2's own generator about 1 in 270 is rejected, so a
  // regression to it fails here with near certainty (p of passing < 1e-4).
  for (let i = 0; i < 3000; i++) {
    const pair = newSshKeyPair();
    const parsed = utils.parseKey(pair.private);
    if (parsed instanceof Error) throw parsed;
    const key = Array.isArray(parsed) ? parsed[0]! : parsed;
    const [, encoded] = pair.public.split(" ");
    expect(key.getPublicSSH().toString("base64")).toBe(encoded);
  }
});
