import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "./index.js";
import type { QueryTransportOptions, SshChannel, SshClient } from "./index.js";

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

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("rows that arrive after the error line (TeamSpeak 6 over SSH)", () => {
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

  it("gives a create the row that followed its error line, and sends nothing before", async () => {
    const created = client.exec("channelcreate channel_name=a");
    await flush();
    channel.feed(OK);
    await flush();
    // The next command waits for this answer to be complete.
    const next = client.exec("whoami");
    await flush();
    expect(channel.writes).toEqual(["channelcreate channel_name=a\n"]);
    channel.feed("cid=7\n\r");
    expect(await created).toEqual([{ cid: "7" }]);
    await flush();
    channel.feed(`client_id=3\n\r${OK}`);
    expect(await next).toEqual([{ client_id: "3" }]);
  });

  it("does not hand a row that missed its grace to the next command", async () => {
    const created = client.exec("channelcreate channel_name=a");
    await flush();
    channel.feed(OK);
    await vi.advanceTimersByTimeAsync(300);
    expect(await created).toEqual([]);
    const next = client.exec("whoami");
    await flush();
    channel.feed(`cid=7\n\rclient_id=3\n\r${OK}`);
    expect(await next).toEqual([{ client_id: "3" }]);
  });

  it("answers at once when the row came first", async () => {
    const created = client.exec("banadd ip=1.2.3.4");
    await flush();
    channel.feed(`banid=9\n\r${OK}`);
    expect(await created).toEqual([{ banid: "9" }]);
  });

  it("does not hold an answer for a command that returns nothing", async () => {
    const edited = client.exec("clientedit clid=1");
    await flush();
    channel.feed(OK);
    expect(await edited).toEqual([]);
  });

  it("gives a read the rows that followed its error line, and the next command none of them", async () => {
    const listed = client.exec("clientlist");
    await flush();
    channel.feed(OK);
    await flush();
    const next = client.exec("whoami");
    await flush();
    expect(channel.writes).toEqual(["clientlist\n"]);
    channel.feed("clid=1 client_nickname=a|clid=2 client_nickname=b\n\r");
    await vi.advanceTimersByTimeAsync(30);
    expect(await listed).toEqual([
      { clid: "1", client_nickname: "a" },
      { clid: "2", client_nickname: "b" },
    ]);
    await flush();
    channel.feed(`client_id=3\n\r${OK}`);
    expect(await next).toEqual([{ client_id: "3" }]);
  });

  it("answers a read at once when its rows came first", async () => {
    const listed = client.exec("clientlist");
    await flush();
    channel.feed(`clid=1\n\r${OK}`);
    expect(await listed).toEqual([{ clid: "1" }]);
  });

  it("does not hold a refusal", async () => {
    const created = client.exec("channelcreate channel_name=a");
    await flush();
    channel.feed("error id=2568 msg=insufficient\\sclient\\spermissions\n\r");
    await expect(created).rejects.toThrow();
  });

  it("keeps every banid of a banclient, whether before, after or on both sides of the error line", async () => {
    const all = client.exec("banclient clid=1|clid=2");
    await flush();
    channel.feed(OK);
    await flush();
    const next = client.exec("whoami");
    await flush();
    for (const id of [4, 5, 6]) {
      channel.feed(`banid=${id}\n\r`);
      await vi.advanceTimersByTimeAsync(5);
    }
    // Quiet for a moment: the answer is whole, and only then does the next go.
    expect(channel.writes).toEqual(["banclient clid=1|clid=2\n"]);
    await vi.advanceTimersByTimeAsync(30);
    expect(await all).toEqual([{ banid: "4" }, { banid: "5" }, { banid: "6" }]);
    await flush();
    channel.feed(`client_id=3\n\r${OK}`);
    expect(await next).toEqual([{ client_id: "3" }]);

    const split = client.exec("banclient clid=1");
    await flush();
    channel.feed(`banid=7\n\r${OK}`);
    await vi.advanceTimersByTimeAsync(2);
    channel.feed("banid=8\n\r");
    await vi.advanceTimersByTimeAsync(30);
    expect(await split).toEqual([{ banid: "7" }, { banid: "8" }]);
  });

  it("does not drop the row of a create of the same kind after one whose row never came", async () => {
    const first = client.exec("channelcreate channel_name=a");
    await flush();
    channel.feed(OK);
    await vi.advanceTimersByTimeAsync(300);
    expect(await first).toEqual([]);
    const second = client.exec("channelcreate channel_name=b");
    await flush();
    channel.feed(`cid=9\n\r${OK}`);
    expect(await second).toEqual([{ cid: "9" }]);
  });
});
