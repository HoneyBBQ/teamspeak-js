import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QueryClient } from "./client.js";
import { GuestAccessError, QueryAuthError, SshHostKeyError } from "./errors.js";
import { connectSsh } from "./ssh.js";
import type { SshConnectOptions, SshHostKey, SshHostKeyPolicy } from "./ssh.js";

/**
 * `connectSsh` against a real SSH server in this process: the real `ssh2`
 * client, the real handshake, nothing faked. The server records every
 * authentication message it receives, which is what shows the host key is
 * checked before the login, and not merely that a check was called.
 */

const USER = "serveradmin";
const PASSWORD = "the-query-password";

function newKeyPair(): { readonly private: string; readonly public: string } {
  return utils.generateKeyPairSync("ed25519");
}

/** The `<type> <base64>` of an OpenSSH public key line, without its comment. */
function publicKeyFields(line: string): { readonly type: string; readonly encoded: string } {
  const [type, encoded] = line.trim().split(/\s+/);
  return { type: type!, encoded: encoded! };
}

const hostKeys = newKeyPair();
const otherKeys = newKeyPair();

/** What the server has been sent, in order: one entry per authentication message. */
const authentications: string[] = [];
const shells: number[] = [];

let server: Server;
let port = 0;
const files = mkdtempSync(join(tmpdir(), "query-ssh-wire-"));

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (context) => {
      authentications.push(context.method);
      if (context.method === "password" && context.username === USER) {
        if (context.password === PASSWORD) context.accept();
        else context.reject();
        return;
      }
      context.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("shell", (acceptShell) => {
          shells.push(1);
          acceptShell().write("TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface.\n\r");
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  rmSync(files, { recursive: true, force: true });
});

beforeEach(() => {
  authentications.length = 0;
  shells.length = 0;
});

/**
 * Dial options that compile: the policy's own arm, built by reaching for the one
 * member it has, with the server's address and login filled in.
 */
function options(
  policy: SshHostKeyPolicy,
  overrides: { readonly password?: string | undefined } = {},
): SshConnectOptions {
  const address = {
    host: "127.0.0.1",
    port,
    username: USER,
    password: overrides.password ?? PASSWORD,
  };
  if ("hostKey" in policy) return { ...address, hostKey: policy.hostKey };
  if ("knownHosts" in policy) return { ...address, knownHosts: policy.knownHosts };
  return { ...address, insecureIgnoreHostKey: true };
}

function knownHosts(name: string, line: string): string {
  const path = join(files, name);
  writeFileSync(path, `${line}\n`);
  return path;
}

describe("connectSsh over a real handshake", () => {
  it("gives the check the server's actual key, in the form ssh-keygen reports", async () => {
    const seen: SshHostKey[] = [];
    const transport = await connectSsh(
      options({ hostKey: (key: SshHostKey) => void seen.push(key) }),
    );
    await transport.close();

    const { type, encoded } = publicKeyFields(hostKeys.public);
    const blob = Buffer.from(encoded, "base64");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ host: "127.0.0.1", port, keyType: type });
    expect(Buffer.from(seen[0]!.key).equals(blob)).toBe(true);
    expect(seen[0]!.fingerprint).toBe(
      `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    );
  });

  it("logs in when the check accepts", async () => {
    const transport = await connectSsh(options({ hostKey: () => {} }));
    await transport.close();
    expect(authentications).toContain("password");
    expect(shells).toHaveLength(1);
  });

  it("sends no authentication of any kind when the check refuses", async () => {
    const reason = new Error("not the key we pinned");
    const attempt = connectSsh(
      options({
        hostKey: () => {
          throw reason;
        },
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toMatchObject({ cause: reason, host: "127.0.0.1", port });
    // Not even the `none` probe that precedes a password: the server saw the
    // key exchange and nothing after it.
    expect(authentications).toEqual([]);
    expect(shells).toEqual([]);
  });

  it("refuses a check that answers the way ssh2's own does, and sends no login", async () => {
    const attempt = connectSsh(options({ hostKey: () => false }));
    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    expect(authentications).toEqual([]);
  });

  it("accepts a server whose key is in the known_hosts file", async () => {
    const { type, encoded } = publicKeyFields(hostKeys.public);
    const path = knownHosts("good", `[127.0.0.1]:${port} ${type} ${encoded}`);
    const transport = await connectSsh(options({ knownHosts: path }));
    await transport.close();
    expect(authentications).toContain("password");
  });

  it("accepts a server recorded under a hashed name", async () => {
    const { createHmac, randomBytes } = await import("node:crypto");
    const salt = randomBytes(20);
    const hash = createHmac("sha1", salt).update(`[127.0.0.1]:${port}`).digest();
    const { type, encoded } = publicKeyFields(hostKeys.public);
    const path = knownHosts(
      "hashed",
      `|1|${salt.toString("base64")}|${hash.toString("base64")} ${type} ${encoded}`,
    );
    const transport = await connectSsh(options({ knownHosts: path }));
    await transport.close();
    expect(authentications).toContain("password");
  });

  it("refuses a server whose key differs from the recorded one, and sends no login", async () => {
    const { type, encoded } = publicKeyFields(otherKeys.public);
    const path = knownHosts("changed", `[127.0.0.1]:${port} ${type} ${encoded}`);

    const attempt = connectSsh(options({ knownHosts: path }));

    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toThrow("something else is answering");
    expect(authentications).toEqual([]);
    expect(shells).toEqual([]);
  });

  it("refuses a server the file does not mention, and sends no login", async () => {
    const { type, encoded } = publicKeyFields(hostKeys.public);
    const path = knownHosts("elsewhere", `[127.0.0.1]:${port + 1} ${type} ${encoded}`);

    const attempt = connectSsh(options({ knownHosts: path }));

    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toThrow(`[127.0.0.1]:${port} is not in`);
    expect(authentications).toEqual([]);
  });

  it("refuses a revoked key, and sends no login", async () => {
    const { type, encoded } = publicKeyFields(hostKeys.public);
    const path = knownHosts("revoked", `@revoked * ${type} ${encoded}`);
    const attempt = connectSsh(options({ knownHosts: path }));
    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toThrow("revoked");
    expect(authentications).toEqual([]);
  });

  it("accepts any key when told to, and logs in", async () => {
    const transport = await connectSsh(options({ insecureIgnoreHostKey: true }));
    await transport.close();
    expect(authentications).toContain("password");
  });

  it("still reports a wrong password as a login failure once the key is accepted", async () => {
    const attempt = connectSsh(options({ hostKey: () => {} }, { password: "wrong" }));
    await expect(attempt).rejects.toBeInstanceOf(QueryAuthError);
    expect(authentications).toContain("password");
  });

  it("reports a refused guest login as a server with no guest access, keeping the login failure", async () => {
    const client = new QueryClient({
      transport: {
        kind: "ssh",
        host: "127.0.0.1",
        port,
        guest: true,
        insecureIgnoreHostKey: true,
      },
      events: false,
    });
    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GuestAccessError);
    expect((failure as GuestAccessError).message).toContain("does not offer guest access");
    expect((failure as GuestAccessError).cause).toBeInstanceOf(QueryAuthError);
    expect(authentications).toContain("none");
  });
});
