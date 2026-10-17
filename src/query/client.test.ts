import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { QueryClient } from "./index.js";
import type {
  QueryClientOptions,
  QueryEventCategory,
  QueryTransport,
  QueryTransportOptions,
  SshChannel,
  SshClient,
} from "./index.js";
import {
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  ServerError,
  TeamspeakError,
  asClientDBID,
  createChannel,
  iterateClientDatabase,
  listBans,
  listChannels,
} from "@honeybbq/teamspeak";
import { MissingDependencyError, QueryAuthError } from "./errors.js";
import { defaultShouldRetry } from "./reconnect.js";

/** A transport that records what is sent and lets the test answer. */
class FakeTransport implements QueryTransport {
  supportsNotifications: boolean;
  sent: string[] = [];
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;
  closed = false;
  /** Answer commands automatically, so a test can drive a whole connect(). */
  auto: ((line: string) => string[] | undefined) | undefined;
  #waiters: Array<() => void> = [];

  constructor(supportsNotifications = true) {
    this.supportsNotifications = supportsNotifications;
  }

  async send(line: string): Promise<void> {
    this.sent.push(line);
    for (const waiter of this.#waiters.splice(0)) waiter();
    const lines = this.auto?.(line);
    if (lines) this.receive(...lines);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onClose?.(undefined);
  }

  /** Wait until n commands have been sent. */
  async sentCount(n: number): Promise<void> {
    while (this.sent.length < n) await new Promise<void>((r) => this.#waiters.push(r));
  }

  receive(...lines: string[]): void {
    for (const line of lines) this.onLine?.(line);
  }
}

/** A client over `transport`, opened through the `custom` escape hatch. */
function clientOn(
  transport: FakeTransport,
  options: Partial<QueryClientOptions> = {},
): QueryClient {
  return new QueryClient({ ...options, transport: custom(transport) });
}

function custom(transport: QueryTransport): QueryTransportOptions {
  return { kind: "custom", open: async () => transport };
}

/** Answer every command with `ok`, and `version` with a row. */
function autoOk(transport: FakeTransport, version = "3.13.8"): void {
  transport.auto = (line) =>
    line.startsWith("version")
      ? [`version=${version} build=1 platform=Linux`, "error id=0 msg=ok"]
      : ["error id=0 msg=ok"];
}

/**
 * A connected client over a fresh fake transport, with `events` off so that
 * connecting sends nothing but `version`. `baseline` is how many lines that
 * took, so a test asserts on the commands of its own.
 *
 * The transport stops answering by itself once connected: what a test expects
 * to be sent is then exactly what it receives.
 */
async function connected(options: Partial<QueryClientOptions> = {}): Promise<{
  client: QueryClient;
  transport: FakeTransport;
  baseline: number;
}> {
  const transport = new FakeTransport();
  autoOk(transport);
  const client = clientOn(transport, { events: false, ...options });
  await client.connect();
  transport.auto = undefined;
  return { client, transport, baseline: transport.sent.length };
}

/**
 * A byte stream a transport reads and writes, with nothing on the other end.
 * `TcpConnector` and an SSH shell both hand one back.
 */
function fakeStream(): Duplex & SshChannel & { feed(text: string): void } {
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Duplex & SshChannel & { feed(text: string): void };
  stream.feed = (text) => stream.emit("data", Buffer.from(text));
  return stream;
}

/**
 * The transport of a client the test has just connected, which is not
 * `undefined` then — and is what the accessor exists to hand over.
 */
function liveTransport(client: QueryClient): QueryTransport {
  const transport = client.transport;
  if (transport === undefined) throw new Error("the client has no transport");
  return transport;
}

/** An SSH client that opens a shell over `channel`; the rest is never used. */
function fakeSsh(channel: SshChannel, opened: string[]): SshClient {
  return {
    connect() {
      opened.push("connect");
    },
    shell(_pty, callback) {
      opened.push("shell");
      callback(undefined, channel);
    },
    end() {
      opened.push("end");
    },
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

/** Poll until `done`, which a reconnection needs: its delay is its own. */
async function waitFor(done: () => boolean, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("QueryClient options", () => {
  it("rejects an option that cannot be one, naming the option", () => {
    expect(() => new QueryClient({} as unknown as QueryClientOptions)).toThrow(TypeError);
    expect(
      () => new QueryClient({ transport: { kind: "nope" } } as unknown as QueryClientOptions),
    ).toThrow(TypeError);
    expect(() => new QueryClient({ transport: { kind: "tcp", host: "" } })).toThrow(TypeError);
    expect(
      () => new QueryClient({ transport: { kind: "web", url: "http://h", apiKey: "" } }),
    ).toThrow(TypeError);
    // SSH logs in by itself, so a login with it is a contradiction.
    expect(
      () =>
        new QueryClient({
          transport: { kind: "ssh", host: "h", username: "u", password: "p", hostKey: () => {} },
          login: { name: "u", password: "p" },
        }),
    ).toThrow(TypeError);
  });

  it("rejects a number that is out of range, naming the option", () => {
    expect(() => new QueryClient({ transport: { kind: "tcp", host: "h", port: 0 } })).toThrow(
      RangeError,
    );
    expect(() => new QueryClient({ transport: { kind: "tcp", host: "h", port: 70_000 } })).toThrow(
      RangeError,
    );
    expect(
      () =>
        new QueryClient({
          transport: { kind: "custom", open: async () => null as never },
          server: { port: 0 },
        }),
    ).toThrow(RangeError);
  });

  it("rejects an unknown notification category", () => {
    const nonsense = { categories: ["nope"] } as unknown as { categories: QueryEventCategory[] };
    expect(
      () =>
        new QueryClient({
          transport: { kind: "tcp", host: "h" },
          events: nonsense,
        }),
    ).toThrow(TypeError);
  });

  // The transport says whether it can deliver notifications; asking for them
  // on one that cannot is the caller's mistake, and is reported where it is
  // made rather than leaving a listener that never runs.
  it("refuses `events` on the WebQuery transport, at construction", () => {
    const web = { kind: "web", url: "http://h", apiKey: "k" } as const;
    expect(() => new QueryClient({ transport: web, events: true })).toThrow(TypeError);
    expect(() => new QueryClient({ transport: web, events: false })).toThrow(TypeError);
    expect(() => new QueryClient({ transport: web })).not.toThrow();
    // With a custom transport the capability is only known once it is opened.
    const offline = new FakeTransport(false);
    expect(() => clientOn(offline, { events: true })).not.toThrow();
  });

  // The entry point's own default: no transport is no client.
  it("requires a transport", () => {
    expect(() => new QueryClient({} as QueryClientOptions)).toThrow(/transport/);
  });
});

describe("QueryClient lifecycle", () => {
  it("runs login, use, version, whoami and the registrations, in that order", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport, {
      login: { name: "serveradmin", password: "pw" },
      server: { id: 1 },
      nickname: "bot",
    });

    await client.connect();

    expect(transport.sent).toEqual([
      "login client_login_name=serveradmin client_login_password=pw",
      "use sid=1 client_nickname=bot",
      "version",
      "whoami",
      "servernotifyregister event=server",
      "servernotifyregister event=channel id=0",
      "servernotifyregister event=textserver",
      "servernotifyregister event=textchannel",
      "servernotifyregister event=textprivate",
      "clientlist -uid -groups -away -voice",
    ]);
    expect(client.status).toBe("connected");
    expect(client.serverFamily).toBe("ts3");
  });

  it("asks for the categories it was given, and for none when told so", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport, { events: { categories: ["textprivate", "bans"] } });
    await client.connect();
    expect(transport.sent.filter((l) => l.startsWith("servernotifyregister"))).toEqual([
      "servernotifyregister event=textprivate",
      "servernotifyregister event=bans",
    ]);
    // The channel and server events come from those categories, so leaving
    // them out registers for neither.
    expect(transport.sent.some((l) => /event=(channel|server)\b/.test(l))).toBe(false);

    const quiet = new FakeTransport();
    autoOk(quiet);
    const silent = clientOn(quiet, { events: false });
    await silent.connect();
    expect(quiet.sent.filter((l) => l.startsWith("servernotifyregister"))).toEqual([]);
    expect(quiet.sent).not.toContain("clientlist -uid -groups -away -voice");
  });

  it("reads the family from the server's version", async () => {
    const transport = new FakeTransport();
    autoOk(transport, "6.0.0-beta13.1");
    const client = clientOn(transport);
    expect(client.serverFamily).toBe("unknown");
    await client.connect();
    expect(client.serverFamily).toBe("ts6");
  });

  it("closes the transport and reports the failure when setting up fails", async () => {
    const transport = new FakeTransport();
    transport.auto = (line) =>
      line.startsWith("login") ? ["error id=520 msg=invalid\\sloginname"] : ["error id=0 msg=ok"];
    const client = clientOn(transport, { login: { name: "u", password: "wrong" } });

    await expect(client.connect()).rejects.toBeInstanceOf(ServerError);
    expect(client.status).toBe("disconnected");
    expect(transport.closed).toBe(true);
  });

  it("emits connected, and disconnected on an explicit teardown", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport);
    const seen: string[] = [];
    client.on("connected", (e) => seen.push(`connected reconnected=${e.reconnected}`));
    client.on("disconnected", (e) => seen.push(`disconnected willReconnect=${e.willReconnect}`));

    await client.connect();
    await client.disconnect();

    expect(seen).toEqual(["connected reconnected=false", "disconnected willReconnect=false"]);
    expect(client.status).toBe("disconnected");
    await expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("refuses a second connect while one is connected", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport);
    await client.connect();
    await expect(client.connect()).rejects.toThrow("already connecting or connected");
  });

  it("fails what is waiting when the connection drops", async () => {
    const { client, transport, baseline } = await connected();

    const answered = client.exec("whoami");
    await transport.sentCount(baseline + 1);
    transport.onClose?.(new Error("reset"));

    await expect(answered).rejects.toBeInstanceOf(NotConnectedError);
    expect(client.status).toBe("disconnected");
  });

  it("disconnects when the enclosing scope ends", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    let client!: QueryClient;
    {
      await using scoped = clientOn(transport);
      client = scoped;
      await scoped.connect();
    }
    expect(client.status).toBe("disconnected");
  });
});

describe("QueryClient commands", () => {
  it("runs the typed commands, with the rows before the error as the answer", async () => {
    const { client, transport, baseline } = await connected();

    const channels = listChannels(client);
    await transport.sentCount(baseline + 1);
    transport.receive(
      "cid=1 pid=0 channel_order=0 channel_name=Lobby|cid=2 pid=0 channel_order=1 channel_name=Two",
      "error id=0 msg=ok",
    );

    expect((await channels).map((c) => c.name)).toEqual(["Lobby", "Two"]);
  });

  // ServerQuery takes the password itself; the voice protocol wants the hash.
  it("sends a channel password as it is", async () => {
    const { client, transport, baseline } = await connected();

    const created = createChannel(client, { name: "Room", password: "hunter2" });
    await transport.sentCount(baseline + 1);
    transport.receive("cid=7", "error id=0 msg=ok");
    await created;

    expect(transport.sent[baseline]).toContain("channel_password=hunter2");
  });

  it("sends a typed command through the command middleware, and a raw line without it", async () => {
    const seen: string[] = [];
    const { client, transport, baseline } = await connected({
      commandMiddleware: [
        (next) => (request, options) => {
          seen.push(String(request.command));
          return next(request, options);
        },
      ],
    });

    const typed = client.send({ command: "whoami" });
    await transport.sentCount(baseline + 1);
    transport.receive("client_id=1", "error id=0 msg=ok");
    await typed;
    const raw = client.exec("whoami");
    await transport.sentCount(baseline + 2);
    transport.receive("client_id=1", "error id=0 msg=ok");
    await raw;

    // The typed command went through the middleware; the raw line did not.
    expect(seen).toEqual(["whoami"]);
  });

  it("walks a paged command until the server reports the end", async () => {
    const { client, transport, baseline } = await connected();

    const seen: bigint[] = [];
    const walk = (async () => {
      for await (const entry of iterateClientDatabase(client, { pageSize: 2 })) {
        seen.push(entry.databaseID);
      }
    })();
    await transport.sentCount(baseline + 1);
    transport.receive("cldbid=1 client_nickname=a|cldbid=2 client_nickname=b", "error id=0 msg=ok");
    await transport.sentCount(baseline + 2);
    transport.receive("cldbid=3 client_nickname=c|cldbid=4 client_nickname=d", "error id=0 msg=ok");
    await transport.sentCount(baseline + 3);
    transport.receive("error id=1281 msg=database\\sempty\\sresult\\sset");
    await walk;

    expect(seen).toEqual([1n, 2n, 3n, 4n].map(asClientDBID));
    expect(transport.sent.slice(baseline)).toEqual([
      "clientdblist start=0 duration=2",
      "clientdblist start=2 duration=2",
      "clientdblist start=4 duration=2",
    ]);
  });

  // The server answers an empty list with 1281 rather than with no rows.
  it("reads an empty list as empty, not as a refusal", async () => {
    const { client, transport, baseline } = await connected();

    const bans = listBans(client);
    await transport.sentCount(baseline + 1);
    transport.receive("error id=1281 msg=database\\sempty\\sresult\\sset");

    expect(await bans).toEqual([]);
  });

  it("rejects with the server's error", async () => {
    const { client, transport, baseline } = await connected();

    const answered = client.exec("channeldelete cid=9");
    await transport.sentCount(baseline + 1);
    transport.receive("error id=768 msg=invalid\\schannelID");

    await expect(answered).rejects.toBeInstanceOf(ServerError);
    await expect(answered).rejects.toMatchObject({ code: ErrorCode.ChannelInvalidID });
  });

  it("sends one command at a time, in order", async () => {
    const { client, transport, baseline } = await connected();

    const first = client.exec("first");
    const second = client.exec("second");
    await transport.sentCount(baseline + 1);
    expect(transport.sent.slice(baseline)).toEqual(["first"]);

    transport.receive("a=1", "error id=0 msg=ok");
    await transport.sentCount(baseline + 2);
    transport.receive("b=2", "error id=0 msg=ok");

    expect(await first).toEqual([{ a: "1" }]);
    expect(await second).toEqual([{ b: "2" }]);
  });

  // With no return_code, a late answer would otherwise be taken for the next
  // command's.
  it("discards the answer of a command that gave up waiting", async () => {
    const { client, transport, baseline } = await connected();

    const slow = client.exec("slow", { timeoutMs: 10 });
    await expect(slow).rejects.toBeInstanceOf(CommandTimeoutError);

    const next = client.exec("next");
    await transport.sentCount(baseline + 2);
    transport.receive("late=1", "error id=0 msg=ok", "mine=1", "error id=0 msg=ok");

    expect(await next).toEqual([{ mine: "1" }]);
  });

  it("does not mistake a notification for part of an answer", async () => {
    const { client, transport, baseline } = await connected();

    const answered = client.exec("whoami");
    await transport.sentCount(baseline + 1);
    transport.receive("notifytextmessage targetmode=3 msg=hi", "client_id=1", "error id=0 msg=ok");

    expect(await answered).toEqual([{ client_id: "1" }]);
  });

  it("logs in and selects a server with the query's own syntax", async () => {
    const { client, transport, baseline } = await connected();

    const login = client.login("serveradmin", "pa ss");
    await transport.sentCount(baseline + 1);
    transport.receive("error id=0 msg=ok");
    await login;
    const used = client.use({ id: 1 }, { nickname: "probe bot" });
    await transport.sentCount(baseline + 2);
    transport.receive("error id=0 msg=ok");
    // The client asks who it is on the new server.
    await transport.sentCount(baseline + 3);
    transport.receive("client_id=5", "error id=0 msg=ok");
    await used;
    const byPort = client.use({ port: 9987 });
    await transport.sentCount(baseline + 4);
    transport.receive("error id=0 msg=ok");
    await transport.sentCount(baseline + 5);
    transport.receive("client_id=6", "error id=0 msg=ok");
    await byPort;

    expect(transport.sent.slice(baseline)).toEqual([
      "login client_login_name=serveradmin client_login_password=pa\\sss",
      "use sid=1 client_nickname=probe\\sbot",
      "whoami",
      "use port=9987",
      "whoami",
    ]);
  });

  it("registers for a notification category", async () => {
    const { client, transport, baseline } = await connected();
    const registered = client.registerNotifications("channel", 0);
    await transport.sentCount(baseline + 1);
    transport.receive("error id=0 msg=ok");
    // The roster is read again once the server has accepted it.
    await transport.sentCount(baseline + 2);
    transport.receive("error id=0 msg=ok");
    await registered;
    expect(transport.sent.slice(baseline)).toEqual([
      "servernotifyregister event=channel id=0",
      "clientlist -uid -groups -away -voice",
    ]);
  });

  it("unregisters one category, one channel, or everything", async () => {
    const { client, transport, baseline } = await connected();
    const calls = [
      () => client.unregisterNotifications("server"),
      () => client.unregisterNotifications("channel", 3),
      () => client.unregisterNotifications(),
    ];
    for (const [i, call] of calls.entries()) {
      const done = call();
      await transport.sentCount(baseline + i + 1);
      transport.receive("error id=0 msg=ok");
      await done;
    }
    expect(transport.sent.slice(baseline)).toEqual([
      "servernotifyunregister event=server",
      "servernotifyunregister event=channel id=3",
      "servernotifyunregister",
    ]);
  });

  it("logs out", async () => {
    const { client, transport, baseline } = await connected();
    const done = client.logout();
    await transport.sentCount(baseline + 1);
    transport.receive("error id=0 msg=ok");
    await done;
    expect(transport.sent.slice(baseline)).toEqual(["logout"]);
  });

  // The voice protocol leaves out the fields a row repeats; ServerQuery never
  // does, so a row that lacks one must stay without it.
  it("does not complete a row from the row before it", async () => {
    const { client, transport, baseline } = await connected();
    const answered = client.exec("x");
    await transport.sentCount(baseline + 1);
    transport.receive("a=1 b=2|a=3", "error id=0 msg=ok");
    expect(await answered).toEqual([{ a: "1", b: "2" }, { a: "3" }]);
  });

  it("does not take the late answer of a slow send for the next command's", async () => {
    // A transport whose send carries the whole round trip.
    class SlowTransport extends FakeTransport {
      override async send(line: string): Promise<void> {
        this.sent.push(line);
        if (line.startsWith("version")) {
          this.receive("version=3.13.8 build=1 platform=Linux", "error id=0 msg=ok");
          return;
        }
        if (line.startsWith("whoami")) {
          this.receive("client_id=1", "error id=0 msg=ok");
          return;
        }
        if (line === "slow") {
          await new Promise((r) => setTimeout(r, 30));
          this.receive("late=1", "error id=0 msg=ok");
        }
      }
    }
    const transport = new SlowTransport();
    const client = clientOn(transport, { events: false });
    await client.connect();

    await expect(client.exec("slow", { timeoutMs: 5 })).rejects.toBeInstanceOf(CommandTimeoutError);
    const next = client.exec("next");
    await new Promise((r) => setTimeout(r, 50));
    transport.receive("mine=1", "error id=0 msg=ok");

    expect(await next).toEqual([{ mine: "1" }]);
  });

  it("rejects with the transport's error when a send fails, and expects no answer", async () => {
    class FailingTransport extends FakeTransport {
      fail = true;
      override async send(line: string): Promise<void> {
        this.sent.push(line);
        if (line.startsWith("version")) {
          this.receive("version=3.13.8 build=1 platform=Linux", "error id=0 msg=ok");
          return;
        }
        if (line.startsWith("whoami")) {
          this.receive("client_id=1", "error id=0 msg=ok");
          return;
        }
        if (this.fail) {
          this.fail = false;
          throw new Error("http 502");
        }
      }
    }
    const transport = new FailingTransport();
    const client = clientOn(transport, { events: false });
    await client.connect();

    await expect(client.exec("a")).rejects.toThrow("http 502");
    const next = client.exec("b");
    await new Promise((r) => setTimeout(r, 10));
    transport.receive("ok=1", "error id=0 msg=ok");
    expect(await next).toEqual([{ ok: "1" }]);
  });

  // ftinitupload answers `error id=0` and reports its refusal in the row.
  it("reads a refused transfer negotiation as the error it is", async () => {
    const { client, transport, baseline } = await connected();

    const refused = client.exec("ftinitupload clientftfid=2 name=/a cid=1");
    await transport.sentCount(baseline + 1);
    transport.receive(
      "clientftfid=2 status=2058 msg=file\\sis\\sin\\suse size=0",
      "error id=0 msg=ok",
    );
    await expect(refused).rejects.toMatchObject({ code: 2058 });

    const granted = client.exec("ftinitupload clientftfid=3 name=/a cid=1");
    await transport.sentCount(baseline + 2);
    transport.receive("clientftfid=3 serverftfid=1 ftkey=k port=30033", "error id=0 msg=ok");
    expect(await granted).toEqual([
      { clientftfid: "3", serverftfid: "1", ftkey: "k", port: "30033" },
    ]);
  });
});

// The seams: a caller with its own socket, its own SSH client, or neither.
describe("QueryClient transport seams", () => {
  it("opens a tcp connection through the connect it was given", async () => {
    const stream = fakeStream();
    const dialled: Array<[string, number]> = [];
    const client = new QueryClient({
      transport: {
        kind: "tcp",
        host: "ts.example.com",
        port: 10011,
        connect: (host, port) => {
          dialled.push([host, port]);
          return stream;
        },
      },
      events: false,
    });

    expect(client.transport).toBeUndefined();
    const connecting = client.connect();
    await waitFor(() => dialled.length === 1);
    // The server's two-line banner, then the version and whoami the setup asks for.
    stream.feed("TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface.\n\r");
    await waitFor(() => client.transport !== undefined);
    liveTransport(client).onLine?.("version=3.13.8 build=1 platform=Linux");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    // The next command is sent once that answer is read.
    await new Promise((r) => setTimeout(r, 0));
    liveTransport(client).onLine?.("client_id=1");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    await connecting;

    expect(dialled).toEqual([["ts.example.com", 10011]]);
    // The live transport is readable, and says what it can do.
    expect(liveTransport(client).supportsNotifications).toBe(true);
    await client.disconnect();
    expect(client.transport).toBeUndefined();
  });

  it("uses an SSH client it was handed, without a handshake of its own", async () => {
    const channel = fakeStream();
    const opened: string[] = [];
    const client = new QueryClient({
      // A supplied connection carries no login: it authenticated already.
      transport: {
        kind: "ssh",
        host: "ts.example.com",
        connection: fakeSsh(channel, opened),
      },
      events: false,
    });

    const connecting = client.connect();
    await waitFor(() => opened.includes("shell"));
    channel.feed("TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface.\n\r");
    await waitFor(() => client.transport !== undefined);
    liveTransport(client).onLine?.("version=6.0.0-beta13.1 build=1 platform=Linux");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    // The next command is sent once that answer is read.
    await new Promise((r) => setTimeout(r, 0));
    liveTransport(client).onLine?.("client_id=1");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    await connecting;

    // `connect` is what dials and authenticates; a client the caller handed
    // over is one they say is connected already.
    expect(opened).not.toContain("connect");
    expect(client.serverFamily).toBe("ts6");
    await client.disconnect();
    // The session is released once the channel is closed, which is what
    // releases an SSH connection the caller handed over.
    channel.destroy();
    await waitFor(() => opened.includes("end"));
  });

  it("asks an SSH factory for a client, and rejects a connect that is not one", async () => {
    const channel = fakeStream();
    let made = 0;
    const client = new QueryClient({
      transport: {
        kind: "ssh",
        host: "h",
        connection: async () => {
          made++;
          return fakeSsh(channel, []);
        },
      },
      events: false,
    });

    const connecting = client.connect();
    await waitFor(() => made === 1);
    channel.feed("TS3\n\rWelcome.\n\r");
    await waitFor(() => client.transport !== undefined);
    liveTransport(client).onLine?.("version=3.13.8 build=1 platform=Linux");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    // The next command is sent once that answer is read.
    await new Promise((r) => setTimeout(r, 0));
    liveTransport(client).onLine?.("client_id=1");
    liveTransport(client).onLine?.("error id=0 msg=ok");
    await connecting;

    expect(made).toBe(1);
    await client.disconnect();

    expect(
      () =>
        new QueryClient({
          transport: {
            kind: "tcp",
            host: "h",
            connect: "nope",
          } as unknown as QueryTransportOptions,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new QueryClient({
          transport: {
            kind: "ssh",
            host: "h",
            username: "u",
            password: "p",
            connection: 3,
          } as unknown as QueryTransportOptions,
        }),
    ).toThrow(TypeError);
  });
});

describe("QueryClient errors", () => {
  it("names the missing package in the error an ssh transport needs", () => {
    const error = new MissingDependencyError();
    expect(error).toBeInstanceOf(TeamspeakError);
    expect(error.package).toBe("ssh2");
    expect(error.message).toContain("ssh2");
  });

  it("keeps the ssh login name in an authentication failure", () => {
    const error = new QueryAuthError("serveradmin", "SSH authentication failed for serveradmin");
    expect(error).toBeInstanceOf(TeamspeakError);
    expect(error.username).toBe("serveradmin");
  });

  // An ssh account the server refuses, and an ssh2 that is not installed, are
  // both facts that do not change between attempts.
  it("never retries what cannot change", () => {
    expect(defaultShouldRetry(new MissingDependencyError())).toBe(false);
    expect(defaultShouldRetry(new QueryAuthError("u", "no"))).toBe(false);
    expect(defaultShouldRetry(new ServerError(ErrorCode.ClientInvalidPassword, "bad"))).toBe(false);
    // A dropped connection, or a server that stopped answering, is worth one.
    expect(defaultShouldRetry(new Error("socket hang up"))).toBe(true);
  });
});

describe("QueryClient reconnection", () => {
  it("does not retry a connection it never established", async () => {
    const transport = new FakeTransport();
    let logins = 0;
    transport.auto = (line) => {
      if (line.startsWith("login")) {
        logins++;
        return ["error id=520 msg=invalid\\sloginname"];
      }
      return ["error id=0 msg=ok"];
    };
    const client = clientOn(transport, {
      login: { name: "u", password: "wrong" },
      events: false,
      reconnect: { backoff: { initialDelayMs: 1 } },
    });

    await expect(client.connect()).rejects.toBeInstanceOf(ServerError);
    await new Promise((r) => setTimeout(r, 30));

    // `connect()` is the caller's to retry; the option only covers a session
    // that dropped after it was established.
    expect(logins).toBe(1);
    expect(client.status).toBe("disconnected");
  });

  it("stops at a login the reconnect attempt is refused", async () => {
    const transport = new FakeTransport();
    let logins = 0;
    transport.auto = (line) => {
      if (line.startsWith("version")) {
        return ["version=3.13.8 build=1 platform=Linux", "error id=0 msg=ok"];
      }
      if (line.startsWith("login")) {
        // Accepted once, so the first connection succeeds; refused after, so
        // the reconnect attempt cannot get in.
        return ++logins === 1 ? ["error id=0 msg=ok"] : ["error id=520 msg=invalid\\sloginname"];
      }
      return ["error id=0 msg=ok"];
    };
    const client = clientOn(transport, {
      login: { name: "u", password: "pw" },
      events: false,
      reconnect: { backoff: { initialDelayMs: 1, jitter: 0 } },
    });
    const seen: Array<{ error: Error | undefined; willReconnect: boolean }> = [];
    client.on("disconnected", (e) => seen.push(e));

    await client.connect();
    transport.onClose?.(new Error("reset"));
    await waitFor(() => client.status === "disconnected" && seen.length > 0);
    await new Promise((r) => setTimeout(r, 50));

    expect(seen[0]?.willReconnect).toBe(true);
    // The attempt's login is refused, so the loop stops and says so.
    expect(seen.at(-1)?.willReconnect).toBe(false);
    expect(logins).toBe(2);
    expect(client.status).toBe("disconnected");
  });

  it("reconnects a dropped session, and says so when it has", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport, {
      events: false,
      reconnect: { backoff: { initialDelayMs: 1, jitter: 0 } },
    });
    const reconnects: boolean[] = [];
    client.on("connected", (e) => reconnects.push(e.reconnected));

    await client.connect();
    // The loop's own attempt is answered the same way the first connection
    // was; the transport keeps answering by itself for that reason.
    transport.onClose?.(new Error("reset"));
    await waitFor(() => client.status === "connected");
    await new Promise((r) => setTimeout(r, 10));

    expect(reconnects).toEqual([false, true]);
    await client.disconnect();
  });

  it("does not reconnect after a deliberate disconnect", async () => {
    const transport = new FakeTransport();
    autoOk(transport);
    const client = clientOn(transport, {
      events: false,
      reconnect: { backoff: { initialDelayMs: 1, jitter: 0 } },
    });
    await client.connect();
    await client.disconnect();
    const dropped = transport.sent.length;
    transport.onClose?.(new Error("reset"));
    await new Promise((r) => setTimeout(r, 30));

    expect(client.status).toBe("disconnected");
    expect(transport.sent.length).toBe(dropped);
  });
});
