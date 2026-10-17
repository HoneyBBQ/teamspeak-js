import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "./client.js";
import { SshHostKeyError } from "./errors.js";
import type { QueryTransportOptions } from "./options.js";
import { defaultShouldRetry } from "./reconnect.js";
import { connectSsh } from "./ssh.js";
import type {
  SshClient,
  SshConnectOptions,
  SshHostKey,
  SshHostKeyPolicy,
  SshOptions,
} from "./ssh.js";

/**
 * `ssh2` stands in for itself, so that what `connectSsh` hands to `connect` can
 * be read and ssh2's own answer to it played back. What ssh2 really does with
 * that answer is the handshake test's to show, over a real connection.
 */
const fake = vi.hoisted(() => {
  type Listener = (argument?: unknown) => void;

  /** The shell channel: enough of a duplex stream for the transport to run on. */
  class FakeChannel {
    written: string[] = [];
    ended = false;
    #handlers = new Map<string, Listener[]>();

    write(data: string, callback: (error?: Error | null) => void): void {
      this.written.push(data);
      callback();
    }
    end(): void {
      this.ended = true;
      // Half-open, as the real channel is: ending it does not report a close.
    }
    on(event: string, listener: Listener): this {
      this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: Listener): this {
      return this.on(event, listener);
    }
    emit(event: string, argument?: unknown): void {
      for (const listener of this.#handlers.get(event) ?? []) listener(argument);
    }
  }

  class FakeClient {
    static instances: FakeClient[] = [];
    config: Parameters<SshClient["connect"]>[0] | undefined;
    ended = false;
    channel = new FakeChannel();
    #once = new Map<string, Listener[]>();

    constructor() {
      FakeClient.instances.push(this);
    }
    connect(config: Parameters<SshClient["connect"]>[0]): void {
      this.config = config;
    }
    // The shell the transport runs on, handed over as ssh2 hands one over.
    shell(_pty: false, callback: (error: Error | undefined, channel: unknown) => void): void {
      callback(undefined, this.channel);
    }
    once(event: string, listener: Listener): this {
      this.#once.set(event, [...(this.#once.get(event) ?? []), listener]);
      return this;
    }
    on(): this {
      return this;
    }
    off(): this {
      return this;
    }
    end(): void {
      this.ended = true;
    }
    /** ssh2 reporting `event`, as it does for a refused key and for a refused password. */
    emit(event: string, argument?: unknown): void {
      for (const listener of this.#once.get(event) ?? []) listener(argument);
      this.#once.delete(event);
    }
  }
  return { FakeClient };
});

vi.mock("ssh2", () => ({ Client: fake.FakeClient }));

const KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIG8wzdJYXD226kBpXj8Ay+FFg9a18j6WglEOCRGS/IUt";
const KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIGklKXDhBbE2nuXoAI+ZsvE526I+VwGs/1gF6Pk7Vx4y";
const FINGERPRINT_A = "SHA256:6cFaaAKd236Vs7mhSLRU8vzg0ea64h7nxKmkZgBce9k";

const PASSWORD = "hunter2-the-query-password";
const blob = (encoded: string): Uint8Array => new Uint8Array(Buffer.from(encoded, "base64"));

const files = mkdtempSync(join(tmpdir(), "query-ssh-"));
afterAll(() => rmSync(files, { recursive: true, force: true }));

function knownHostsFile(name: string, ...lines: string[]): string {
  const path = join(files, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

beforeEach(() => {
  fake.FakeClient.instances.length = 0;
});

/**
 * Dial options that compile: the policy's own arm, built by reaching for the
 * one member it has.
 *
 * The arms are mutually exclusive, so a spread of the union would not narrow;
 * this says which member is the policy, and the others are then `never` by
 * construction rather than by assertion.
 */
function dialOptions(
  policy: SshHostKeyPolicy,
  overrides: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly password?: string | undefined;
  } = {},
): SshConnectOptions {
  const address = {
    host: overrides.host ?? "ts.example.com",
    username: "serveradmin",
    password: overrides.password ?? PASSWORD,
    ...(overrides.port === undefined ? {} : { port: overrides.port }),
  };
  if ("hostKey" in policy) return { ...address, hostKey: policy.hostKey };
  if ("knownHosts" in policy) return { ...address, knownHosts: policy.knownHosts };
  return { ...address, insecureIgnoreHostKey: true };
}

/**
 * Options a caller the types do not reach would hand over: a JavaScript program
 * or an `as` cast. The runtime check is exactly for these, so the tests that
 * drive it say so here instead of scattering casts through the cases.
 */
function unchecked(options: Record<string, unknown>): SshOptions {
  return options as unknown as SshOptions;
}

/** The same, for the options a `QueryClient` is built with. */
function uncheckedTransport(options: Record<string, unknown>): QueryTransportOptions {
  return options as unknown as QueryTransportOptions;
}

/** Start a connection and wait until ssh2 has been told to connect; its result is read later. */
async function dial(
  policy: SshHostKeyPolicy,
  overrides: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly password?: string | undefined;
  } = {},
) {
  // A test may dial twice, and the second must not be taken for the first.
  const before = fake.FakeClient.instances.length;
  const abort = new AbortController();
  const outcome = connectSsh({
    ...dialOptions(policy, overrides),
    signal: abort.signal,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => {
    expect(fake.FakeClient.instances.length).toBeGreaterThan(before);
    expect(fake.FakeClient.instances.at(-1)?.config).toBeDefined();
  });
  const client = fake.FakeClient.instances.at(-1)!;
  return {
    client,
    /** What ssh2 asked the verifier, and the answer it got back. */
    ask: (encoded: string): boolean => client.config!.hostVerifier(blob(encoded)),
    /** ssh2 reporting that it ended the connection over the key, as it does after a `false`. */
    denied: (): void =>
      client.emit(
        "error",
        Object.assign(new Error("Host denied (verification failed)"), { level: "handshake" }),
      ),
    outcome,
    abort,
  };
}

describe("connectSsh as a guest", () => {
  it("logs in as `guest` and offers no password", async () => {
    const before = fake.FakeClient.instances.length;
    const outcome = connectSsh({
      host: "ts.example.com",
      guest: true,
      hostKey: () => {},
    }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(fake.FakeClient.instances.length).toBeGreaterThan(before);
      expect(fake.FakeClient.instances.at(-1)?.config).toBeDefined();
    });
    const config = fake.FakeClient.instances.at(-1)!.config!;
    expect(config.username).toBe("guest");
    expect(config).not.toHaveProperty("password");
    fake.FakeClient.instances.at(-1)!.emit("error", new Error("stop"));
    await outcome;
  });

  it("is never what missing credentials fall back to", async () => {
    const attempt = connectSsh(unchecked({ host: "h", hostKey: () => {} }));
    await expect(attempt).rejects.toThrow(/username.*guest/);
    await expect(
      connectSsh(unchecked({ host: "h", guest: true, password: "p", hostKey: () => {} })),
    ).rejects.toThrow(TypeError);
    await expect(
      connectSsh(unchecked({ host: "h", guest: false, hostKey: () => {} })),
    ).rejects.toThrow(TypeError);
    expect(fake.FakeClient.instances).toHaveLength(0);
  });
});

describe("connectSsh with no decision about the host key", () => {
  it("fails closed, naming all three options and why, before anything is opened", async () => {
    const attempt = connectSsh(
      unchecked({ host: "ts.example.com", username: "u", password: PASSWORD }),
    );
    await expect(attempt).rejects.toThrow("hostKey");
    await expect(attempt).rejects.toThrow("knownHosts");
    await expect(attempt).rejects.toThrow("insecureIgnoreHostKey");
    await expect(attempt).rejects.toThrow("credential");
    await expect(attempt).rejects.not.toBeInstanceOf(TypeError);
    expect(fake.FakeClient.instances).toHaveLength(0);
  });

  it("does not put the password in what it says", async () => {
    const error = await connectSsh(
      unchecked({ host: "h", username: "u", password: PASSWORD }),
    ).catch((failure: unknown) => failure);
    expect((error as Error).message).not.toContain(PASSWORD);
  });
});

describe("connectSsh with more than one", () => {
  const hostKey = () => {};
  const knownHosts = "/some/known_hosts";

  it.each([
    ["hostKey and knownHosts", { hostKey, knownHosts }],
    ["hostKey and insecureIgnoreHostKey", { hostKey, insecureIgnoreHostKey: true as const }],
    ["knownHosts and insecureIgnoreHostKey", { knownHosts, insecureIgnoreHostKey: true as const }],
    ["all three", { hostKey, knownHosts, insecureIgnoreHostKey: true as const }],
  ])("is a TypeError for %s, and opens nothing", async (_name, choice) => {
    const attempt = connectSsh(
      unchecked({ host: "h", username: "u", password: PASSWORD, ...choice }),
    );
    await expect(attempt).rejects.toBeInstanceOf(TypeError);
    await expect(attempt).rejects.toThrow("exactly one of");
    expect(fake.FakeClient.instances).toHaveLength(0);
  });

  it("is a TypeError for a value that is not one of them", async () => {
    const bad = (choice: object) =>
      connectSsh(unchecked({ host: "h", username: "u", password: PASSWORD, ...choice }));
    await expect(bad({ hostKey: "no" })).rejects.toBeInstanceOf(TypeError);
    await expect(bad({ knownHosts: "" })).rejects.toBeInstanceOf(TypeError);
    // Not a switch: false is not "off", it is not a decision at all.
    await expect(bad({ insecureIgnoreHostKey: false })).rejects.toThrow("not a switch");
    expect(fake.FakeClient.instances).toHaveLength(0);
  });
});

describe("the check ssh2 is given", () => {
  it("hands the caller's check the key, as this package describes it, and accepts when it returns", async () => {
    const seen: SshHostKey[] = [];
    const { ask, abort, outcome } = await dial(
      { hostKey: (key) => void seen.push(key) },
      { port: 2222 },
    );

    expect(ask(KEY_A)).toBe(true);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      host: "ts.example.com",
      port: 2222,
      keyType: "ssh-ed25519",
      fingerprint: FINGERPRINT_A,
    });
    expect(Buffer.from(seen[0]!.key).toString("base64")).toBe(KEY_A);
    abort.abort(new Error("done"));
    await outcome;
  });

  it("hands over a copy of the key, so a check cannot change what ssh2 holds", async () => {
    const original = blob(KEY_A);
    const { client, abort, outcome } = await dial({
      hostKey: (key) => {
        key.key.fill(0);
      },
    });
    client.config!.hostVerifier(original);
    expect(Buffer.from(original).toString("base64")).toBe(KEY_A);
    abort.abort(new Error("done"));
    await outcome;
  });

  it("uses the port it was given, or 10022", async () => {
    const seen: number[] = [];
    const { ask, abort, outcome } = await dial({ hostKey: (key) => void seen.push(key.port) });
    ask(KEY_A);
    expect(seen).toEqual([10022]);
    abort.abort(new Error("done"));
    await outcome;
  });

  it("refuses when the check throws, and fails the connection with the reason", async () => {
    const reason = new Error("not the key in the inventory");
    const { ask, denied, outcome } = await dial({
      hostKey: () => {
        throw reason;
      },
    });

    expect(ask(KEY_A)).toBe(false);
    denied();

    const error = (await outcome) as SshHostKeyError;
    expect(error).toBeInstanceOf(SshHostKeyError);
    expect(error.cause).toBe(reason);
    expect(error).toMatchObject({ host: "ts.example.com", port: 10022 });
    expect(error.message).toContain("not the key in the inventory");
    expect(error.message).toContain("no login was sent");
    expect(error.message).not.toContain(PASSWORD);
  });

  it("refuses when the check throws something that is not an error", async () => {
    const { ask, denied, outcome } = await dial({
      hostKey: () => {
        const notAnError: unknown = "no";
        throw notAnError;
      },
    });
    expect(ask(KEY_A)).toBe(false);
    denied();
    const error = (await outcome) as SshHostKeyError;
    expect(error).toBeInstanceOf(SshHostKeyError);
    expect((error.cause as Error).message).toBe("no");
  });

  it.each([
    ["false, ssh2's own way of saying no", () => false],
    ["true, ssh2's own way of saying yes", () => true],
    ["a value of any kind", () => "ok"],
  ])("refuses a check that returns %s, rather than guess which was meant", async (_name, check) => {
    const { ask, denied, outcome } = await dial({ hostKey: check });
    expect(ask(KEY_A)).toBe(false);
    denied();
    const error = (await outcome) as SshHostKeyError;
    expect(error).toBeInstanceOf(SshHostKeyError);
    expect(error.message).toContain("return nothing to accept the key and throw to refuse it");
  });

  it("refuses an async check, whose rejection would come too late to stop anything", async () => {
    // TypeScript lets this through: an async function is assignable to a
    // callback that returns void, and a refusal it throws would be lost.
    const asyncCheck: unknown = async () => {
      throw new Error("rejected after the handshake went on");
    };
    const { ask, denied, outcome } = await dial({ hostKey: asyncCheck as () => void });
    expect(ask(KEY_A)).toBe(false);
    denied();
    expect(await outcome).toBeInstanceOf(SshHostKeyError);
    // The rejection nobody awaits must not surface as an unhandled one, which
    // would fail this run; let it settle first.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("refuses a key it cannot read, without asking the check", async () => {
    const asked = vi.fn<() => void>();
    const { client, denied, outcome } = await dial({ hostKey: asked });
    expect(client.config!.hostVerifier(new Uint8Array([1, 2]))).toBe(false);
    denied();
    expect(asked).not.toHaveBeenCalled();
    expect(await outcome).toBeInstanceOf(SshHostKeyError);
  });

  it("is told apart from a refused password, which stays an authentication failure", async () => {
    const { ask, client, outcome } = await dial({ hostKey: () => {} });
    expect(ask(KEY_A)).toBe(true);
    client.emit(
      "error",
      Object.assign(new Error("All configured authentication methods failed"), {
        level: "client-authentication",
      }),
    );
    const error = (await outcome) as Error;
    expect(error).not.toBeInstanceOf(SshHostKeyError);
    expect(error.constructor.name).toBe("QueryAuthError");
  });

  it("always passes ssh2 a verifier, so no client falls back to its own default", async () => {
    const { client, abort, outcome } = await dial({ insecureIgnoreHostKey: true });
    expect(typeof client.config!.hostVerifier).toBe("function");
    abort.abort(new Error("done"));
    await outcome;
  });
});

describe("closing the transport", () => {
  /** Connect far enough to hold a live transport, which needs the shell. */
  async function live(policy: SshHostKeyPolicy) {
    const connecting = connectSsh(dialOptions(policy));
    await vi.waitFor(() => expect(fake.FakeClient.instances.at(-1)?.config).toBeDefined());
    const ssh = fake.FakeClient.instances.at(-1)!;
    ssh.emit("ready");
    return { ssh, transport: await connecting };
  }

  it("ends the SSH client when the transport is closed", async () => {
    const { ssh, transport } = await live({ hostKey: () => {} });
    expect(ssh.ended).toBe(false);

    await transport.close();

    // Not merely the shell channel: the connection underneath it is released,
    // which is what lets a process that connected over SSH exit.
    expect(ssh.channel.ended).toBe(true);
    expect(ssh.ended).toBe(true);
  });

  it("ends it once, however many times close() is called", async () => {
    const { ssh, transport } = await live({ hostKey: () => {} });
    await transport.close();
    await transport.close();
    expect(ssh.ended).toBe(true);
  });

  it("ends it when the connection drops rather than when it is closed", async () => {
    const { ssh, transport } = await live({ hostKey: () => {} });
    // The server side going away: the channel reports the close itself.
    ssh.channel.emit("close");
    expect(ssh.ended).toBe(true);
    // The transport knows it is over, and says so without a failure.
    await expect(transport.send("x")).rejects.toThrow("closed");
  });

  /** A whole `QueryClient` over the fake client, connected and ready to be left. */
  async function connected() {
    const client = new QueryClient({
      transport: {
        kind: "ssh",
        host: "ts.example.com",
        username: "serveradmin",
        password: PASSWORD,
        hostKey: () => {},
      },
      events: false,
    });
    const connecting = client.connect();
    await vi.waitFor(() => expect(fake.FakeClient.instances.at(-1)?.config).toBeDefined());
    const ssh = fake.FakeClient.instances.at(-1)!;
    ssh.emit("ready");
    // The client installs its line handler once the open transport comes back,
    // which is a microtask later: feeding the server's lines before that loses
    // them, and the connection then waits for an answer that already arrived.
    await vi.waitFor(() => expect(client.transport).toBeDefined());
    // The two banner lines the transport drops, then the setup's own answers.
    ssh.channel.emit("data", Buffer.from("TS3\n\rWelcome.\n\r"));
    ssh.channel.emit("data", Buffer.from("version=6.0.0-beta13.1 build=1 platform=Linux\n\r"));
    ssh.channel.emit("data", Buffer.from("error id=0 msg=ok\n\r"));
    // whoami is sent once that answer is read.
    await new Promise((r) => setTimeout(r, 0));
    ssh.channel.emit("data", Buffer.from("client_id=1\n\rerror id=0 msg=ok\n\r"));
    await connecting;
    return { ssh, client };
  }

  it("ends the SSH client when a QueryClient disconnects", async () => {
    const { ssh, client } = await connected();
    expect(ssh.ended).toBe(false);

    // The whole path an application takes, not only the transport's own close.
    await client.disconnect();

    expect(ssh.ended).toBe(true);
  });

  it("ends the SSH client when `await using` disposes the QueryClient", async () => {
    const { ssh, client } = await connected();
    await client[Symbol.asyncDispose]();
    expect(ssh.ended).toBe(true);
  });
});

describe("insecureIgnoreHostKey", () => {
  it("accepts any key", async () => {
    const { ask, abort, outcome } = await dial({ insecureIgnoreHostKey: true });
    expect(ask(KEY_A)).toBe(true);
    expect(ask(KEY_B)).toBe(true);
    abort.abort(new Error("done"));
    await outcome;
  });
});

describe("knownHosts", () => {
  it("accepts the key the file records for the host, and for [host]:port", async () => {
    const path = knownHostsFile(
      "plain",
      `[ts.example.com]:10022 ssh-ed25519 ${KEY_A}`,
      `[other.example.com]:2222 ssh-ed25519 ${KEY_B}`,
    );
    const first = await dial({ knownHosts: path });
    expect(first.ask(KEY_A)).toBe(true);
    first.abort.abort(new Error("done"));
    await first.outcome;

    const second = await dial({ knownHosts: path }, { host: "other.example.com", port: 2222 });
    expect(second.ask(KEY_B)).toBe(true);
    second.abort.abort(new Error("done"));
    await second.outcome;
  });

  it("refuses a key that differs from the recorded one, naming both", async () => {
    const path = knownHostsFile("changed", `[ts.example.com]:10022 ssh-ed25519 ${KEY_B}`);
    const { ask, denied, outcome } = await dial({ knownHosts: path });
    expect(ask(KEY_A)).toBe(false);
    denied();
    const error = (await outcome) as SshHostKeyError;
    expect(error).toBeInstanceOf(SshHostKeyError);
    expect((error.cause as Error).message).toContain(FINGERPRINT_A);
    expect((error.cause as Error).message).toContain("records");
  });

  it("refuses a host the file does not mention", async () => {
    const path = knownHostsFile("elsewhere", `elsewhere.example.com ssh-ed25519 ${KEY_A}`);
    const { ask, denied, outcome } = await dial({ knownHosts: path });
    expect(ask(KEY_A)).toBe(false);
    denied();
    const error = (await outcome) as SshHostKeyError;
    expect((error.cause as Error).message).toContain("[ts.example.com]:10022 is not in");
  });

  it("does not take an entry for port 22 as the one for the query port", async () => {
    // `ssh-keyscan` without -p records the SSH server on 22, which is another
    // server than the one on 10022 and may hold another key.
    const path = knownHostsFile("port-22", `ts.example.com ssh-ed25519 ${KEY_A}`);
    const { ask, denied, outcome } = await dial({ knownHosts: path });
    expect(ask(KEY_A)).toBe(false);
    denied();
    const error = (await outcome) as SshHostKeyError;
    expect((error.cause as Error).message).toContain("[ts.example.com]:10022 is not in");
  });

  it("refuses a revoked key", async () => {
    const path = knownHostsFile(
      "revoked",
      `[ts.example.com]:10022 ssh-ed25519 ${KEY_A}`,
      `@revoked * ssh-ed25519 ${KEY_A}`,
    );
    const { ask, denied, outcome } = await dial({ knownHosts: path });
    expect(ask(KEY_A)).toBe(false);
    denied();
    expect(((await outcome) as SshHostKeyError).cause).toMatchObject({
      message: expect.stringContaining("revoked") as unknown,
    });
  });

  it("reads the file again for each attempt, so a reconnection sees what it says then", async () => {
    const path = knownHostsFile("rotated", `[ts.example.com]:10022 ssh-ed25519 ${KEY_A}`);
    const before = await dial({ knownHosts: path });
    expect(before.ask(KEY_A)).toBe(true);
    before.abort.abort(new Error("done"));
    await before.outcome;

    writeFileSync(path, `[ts.example.com]:10022 ssh-ed25519 ${KEY_B}\n`);
    const after = await dial({ knownHosts: path });
    expect(after.ask(KEY_A)).toBe(false);
    expect(after.ask(KEY_B)).toBe(true);
    after.abort.abort(new Error("done"));
    await after.outcome;
  });

  it("fails the connection, opening nothing, when the file cannot be read", async () => {
    const attempt = connectSsh(dialOptions({ knownHosts: join(files, "does-not-exist") }));
    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toThrow("cannot be checked");
    await expect(attempt).rejects.toThrow("does-not-exist");
    expect(fake.FakeClient.instances).toHaveLength(0);
  });

  it("fails the connection, opening nothing, when a line cannot be read", async () => {
    const path = knownHostsFile("broken", "ts.example.com ssh-ed25519 not-base64!!");
    const attempt = connectSsh(dialOptions({ knownHosts: path }));
    await expect(attempt).rejects.toBeInstanceOf(SshHostKeyError);
    await expect(attempt).rejects.toThrow(`${path}:1`);
    expect(fake.FakeClient.instances).toHaveLength(0);
  });
});

describe("a connection the caller supplies", () => {
  const connection = (): Promise<SshClient> => Promise.reject(new Error("not reached"));

  it("takes no host key option, which nothing would read", async () => {
    for (const choice of [
      { hostKey: () => {} },
      { knownHosts: "/some/known_hosts" },
      { insecureIgnoreHostKey: true as const },
    ]) {
      await expect(
        connectSsh(
          unchecked({ host: "h", username: "u", password: PASSWORD, connection, ...choice }),
        ),
      ).rejects.toThrow("has no effect with connection");
    }
  });
});

describe("QueryClient", () => {
  const dialing = { kind: "ssh" as const, host: "h", username: "u", password: PASSWORD };
  /** The same, for a caller the types do not reach: `new QueryClient` is where the runtime check runs. */
  const transport = uncheckedTransport({
    kind: "ssh",
    host: "h",
    username: "u",
    password: PASSWORD,
  });

  it("takes the transport of a caller the types do not reach, and checks it at construction", () => {
    // The type would refuse this; a JavaScript caller has no type to refuse it.
    expect(() => new QueryClient({ transport })).toThrow("hostKey");
  });

  it("refuses to be built with no decision, naming all three options", () => {
    expect(() => new QueryClient({ transport })).toThrow("hostKey");
    expect(() => new QueryClient({ transport })).toThrow("knownHosts");
    expect(() => new QueryClient({ transport })).toThrow("insecureIgnoreHostKey");
    expect(() => new QueryClient({ transport })).not.toThrow(TypeError);
  });

  it("refuses two of them with a TypeError", () => {
    expect(
      () =>
        new QueryClient({
          transport: uncheckedTransport({ ...dialing, hostKey: () => {}, knownHosts: "/k" }),
        }),
    ).toThrow(TypeError);
  });

  it("builds with exactly one", () => {
    expect(() => new QueryClient({ transport: { ...dialing, hostKey: () => {} } })).not.toThrow();
    expect(() => new QueryClient({ transport: { ...dialing, knownHosts: "/k" } })).not.toThrow();
    expect(
      () => new QueryClient({ transport: { ...dialing, insecureIgnoreHostKey: true } }),
    ).not.toThrow();
  });

  it("builds with a connection and none of them", () => {
    expect(
      () =>
        new QueryClient({
          // A supplied connection carries no login: it is authenticated already.
          transport: { kind: "ssh", host: "h", connection: () => Promise.reject(new Error("x")) },
        }),
    ).not.toThrow();
  });

  it("hands the choice on to the connection it makes, and ends in a refusal when the key is refused", async () => {
    const client = new QueryClient({
      transport: {
        ...dialing,
        hostKey: () => {
          throw new Error("unexpected key");
        },
      },
    });
    const connecting = client.connect().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(fake.FakeClient.instances.at(-1)?.config).toBeDefined());
    const ssh = fake.FakeClient.instances.at(-1)!;
    expect(ssh.config!.hostVerifier(blob(KEY_A))).toBe(false);
    ssh.emit(
      "error",
      Object.assign(new Error("Host denied (verification failed)"), { level: "handshake" }),
    );

    const error = await connecting;
    expect(error).toBeInstanceOf(SshHostKeyError);
    expect(defaultShouldRetry(error as Error)).toBe(false);
    expect(client.status).toBe("disconnected");
  });
});

describe("defaultShouldRetry", () => {
  it("does not retry a host key that was refused: it stays refused", () => {
    expect(defaultShouldRetry(new SshHostKeyError("h", 22, "no"))).toBe(false);
  });
});
