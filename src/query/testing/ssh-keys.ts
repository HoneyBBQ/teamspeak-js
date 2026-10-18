import { generateKeyPairSync, randomBytes } from "node:crypto";

/** An Ed25519 key pair in the forms the SSH tests need. */
export interface TestSshKeyPair {
  /** The unencrypted OpenSSH private key PEM, accepted by `ssh2`'s `Server` as a host key. */
  readonly private: string;
  /** The OpenSSH public key line, `ssh-ed25519 <base64>`, as in a known_hosts entry. */
  readonly public: string;
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function sshString(bytes: Buffer): Buffer {
  return Buffer.concat([uint32(bytes.length), bytes]);
}

/**
 * A fresh Ed25519 key pair for a test SSH server or a known_hosts entry.
 *
 * It is made with `node:crypto` and not with `ssh2`'s `utils.generateKeyPairSync`.
 * That one strips every leading zero byte from the raw public key while it
 * removes the BIT STRING's own padding byte, so a public key that really starts
 * with 0x00 (one in 256) is written 31 bytes long and the private key it
 * returns is rejected by `utils.parseKey` as "Malformed OpenSSH private key".
 * Measured: 36 to 40 of 10,000 keys on Node 22, 24 and 26.
 */
export function newSshKeyPair(): TestSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicRaw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const name = sshString(Buffer.from("ssh-ed25519"));
  const publicBlob = Buffer.concat([name, sshString(publicRaw)]);

  // The openssh-key-v1 layout: no cipher, one key, the private part padded 1, 2, 3...
  const check = randomBytes(4);
  const inner = Buffer.concat([
    check,
    check,
    publicBlob,
    sshString(Buffer.concat([seed, publicRaw])),
    sshString(Buffer.alloc(0)),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (inner.length % 8)) % 8 }, (_, i) => i + 1),
  );
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString(Buffer.from("none")),
    sshString(Buffer.from("none")),
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(publicBlob),
    sshString(Buffer.concat([inner, padding])),
  ]);
  const lines = body
    .toString("base64")
    .match(/.{1,70}/g)!
    .join("\n");
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${publicBlob.toString("base64")}`,
  };
}
