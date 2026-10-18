import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "./index.js";
import type { QueryTransportOptions, SshChannel, SshClient } from "./index.js";
import { CommandTimeoutError } from "@honeybbq/teamspeak";

type Channel = Duplex & SshChannel & { feed(text: string): void; writes: string[] };

function channelOf(): Channel {
  const writes: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const text = Buffer.from(chunk).toString();
      writes.push(text);
      callback();
      // The server answers `quit` by ending the session.
      if (text === "quit\n") queueMicrotask(() => stream.emit("close"));
    },
  }) as Channel;
  stream.writes = writes;
  stream.feed = (text) => stream.emit("data", Buffer.from(text));
  return stream;
}

function sshOver(channel: SshChannel): SshClient {
  return {
    connect() {},
    shell(_pty, callback) {
      callback(undefined, channel);
    },
    end() {},
    once() {
      return this;
    },
    on() {
      return this;
    },
    off() {
      return this;
    },
  };
}

const OK = "error id=0 msg=ok\n\r";
const BANNER = "TS3\n\rWelcome.\n\r";

/** Real timers until the handshake commands are done, then fake ones. */
async function connected(transport: QueryTransportOptions, channel: Channel): Promise<QueryClient> {
  const client = new QueryClient({ transport, events: false });
  const connecting = client.connect();
  const sent = async (n: number): Promise<void> => {
    while (channel.writes.length < n) await new Promise((r) => setTimeout(r, 2));
  };
  await new Promise((r) => setTimeout(r, 5));
  channel.feed(BANNER);
  await sent(1);
  channel.feed(`version=6.0.0 build=1 platform=Linux\n\r${OK}`);
  await sent(2);
  channel.feed(`client_id=1\n\r${OK}`);
  await connecting;
  channel.writes.length = 0;
  return client;
}

const nudges = (channel: Channel): number => channel.writes.filter((w) => w === "\n").length;
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("the SSH nudge for a held reply", () => {
  let channel: Channel;
  let client: QueryClient;

  beforeEach(async () => {
    channel = channelOf();
    client = await connected({ kind: "ssh", host: "h", connection: sshOver(channel) }, channel);
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await client.disconnect();
  });

  it("writes nothing for a command answered within 2 seconds", async () => {
    const done = client.exec("version");
    await flush();
    await vi.advanceTimersByTimeAsync(1_900);
    channel.feed(`version=1\n\r${OK}`);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nudges(channel)).toBe(0);
  });

  it("writes an empty line at 2 seconds, then each second, until the error line arrives", async () => {
    const done = client.exec("version", { timeoutMs: 60_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(nudges(channel)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges(channel)).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nudges(channel)).toBe(3);
    channel.feed(OK);
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nudges(channel)).toBe(3);
  });

  it("resolves with the row when the terminator was held after an on-time data row", async () => {
    const done = client.exec("version", { timeoutMs: 60_000 });
    await flush();
    channel.feed("version=1\n\r");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nudges(channel)).toBe(1);
    channel.feed(OK);
    await expect(done).resolves.toEqual([{ version: "1" }]);
  });

  it("stops after a timeout, a cancel and a close", async () => {
    const timedOut = client.exec("version", { timeoutMs: 3_500 }).catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(await timedOut).toBeInstanceOf(CommandTimeoutError);
    expect(nudges(channel)).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nudges(channel)).toBe(2);

    // The timed-out command's own error line is still due; read it.
    channel.feed(OK);
    const controller = new AbortController();
    const cancelled = client
      .exec("version", { signal: controller.signal, timeoutMs: 60_000 })
      .catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(nudges(channel)).toBe(3);
    controller.abort(new Error("stop"));
    await cancelled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nudges(channel)).toBe(3);
    channel.feed(OK);

    const closing = client.exec("version", { timeoutMs: 60_000 }).catch((e: unknown) => e);
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(nudges(channel)).toBe(4);
    await client.disconnect();
    await closing;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(nudges(channel)).toBe(4);
  });

  it("times the command awaiting its answer, so a queued one is not nudged before it is sent", async () => {
    const first = client.exec("version", { timeoutMs: 60_000 });
    const second = client.exec("whoami", { timeoutMs: 60_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(2_500);
    // Only the first command was sent, and it has been nudged once.
    expect(channel.writes.filter((w) => w !== "\n")).toEqual(["version\n"]);
    expect(nudges(channel)).toBe(1);
    channel.feed(OK);
    await first;
    await flush();
    expect(channel.writes.filter((w) => w !== "\n")).toEqual(["version\n", "whoami\n"]);
    // The first command's schedule (3 s) is gone; the second counts from now.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(nudges(channel)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges(channel)).toBe(2);
    channel.feed(OK);
    await second;
  });

  it("does not nudge a custom transport", async () => {
    await client.disconnect();
    const plain = channelOf();
    const ssh = sshOver(plain);
    vi.useRealTimers();
    const other = await connected(
      {
        kind: "custom",
        open: async () => (await import("./ssh.js")).connectSsh({ host: "h", connection: ssh }),
      },
      plain,
    );
    vi.useFakeTimers();
    const done = other.exec("version", { timeoutMs: 60_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(nudges(plain)).toBe(0);
    plain.feed(OK);
    await done;
    await other.disconnect();
  });
});
