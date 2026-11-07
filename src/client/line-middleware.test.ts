import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Client, clientInternals, onSentLine } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { HandshakeError } from "./errors.js";
import {
  CommandTimeoutError,
  NotConnectedError,
  ServerError,
  type CommandLine,
  type LineMiddleware,
} from "@honeybbq/teamspeak";
import { PacketType, type Packet } from "./transport/packet.js";
import {
  FakeSocket,
  completeCryptoInit,
  dummyPacket,
  sessionPacket,
} from "./testing/fake-server.js";
import type { ClientOptions } from "./types.js";
import { Pacer, paced, resendOnFlood } from "../../examples/flood-control.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const line = (text: string): Uint8Array => new TextEncoder().encode(text);

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

afterEach(() => onSentLine(undefined));

/** A client that has completed a handshake against a socket that answers nothing. */
async function connected(
  options: ClientOptions = {},
): Promise<{ client: Client; socket: FakeSocket }> {
  let socket: FakeSocket | undefined;
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    socketFactory: () => (socket = new FakeSocket()),
    ...options,
  });
  const connecting = client.connect();
  await until(() => clientInternals(client).handler.isOpen);
  completeCryptoInit(clientInternals(client).crypt);
  clientInternals(client).clid = 5;
  clientInternals(client).markConnected();
  await connecting;
  return { client, socket: socket! };
}

function packet(text: string): Packet {
  return {
    typeFlagged: PacketType.Command,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: line(text),
    receivedAt: performance.now(),
  };
}

/** Answer the command a line carried, with an error line of its own. */
function answer(client: Client, sent: string, error: string, extra = ""): void {
  const rc = /return_code=(\d+)/.exec(sent)![1];
  clientInternals(client).handlePacket(packet(`error id=${error} msg=x${extra} return_code=${rc}`));
}

/** The lines that went to the connection, in order. */
function wire(): string[] {
  const lines: string[] = [];
  onSentLine((_c, text) => void lines.push(text));
  return lines;
}

/** A middleware that records the lines it passes on. */
function recorder(seen: CommandLine[]): LineMiddleware {
  return (next) => (l, o) => {
    seen.push(l);
    return next(l, o);
  };
}

describe("line middleware", () => {
  it("passes typed commands, raw lines and lines nobody answers, in the order given", async () => {
    const order: string[] = [];
    const tag =
      (name: string): LineMiddleware =>
      (next) =>
      (l, o) => {
        order.push(`${name}:${l.name}`);
        return next(l, o);
      };
    const seen: CommandLine[] = [];
    const { client } = await connected({
      lineMiddleware: [tag("outer"), tag("inner"), recorder(seen)],
    });
    const sent = wire();

    const typed = client.send({ command: "whoami", params: [["a", "b c"]] });
    const raw = client.exec("clientlist");
    const none = client.execNoWait("clientupdate client_away=1");
    await expect(none).resolves.toBeUndefined();
    await settle();
    expect(seen.map((l) => l.name)).toEqual(["whoami", "clientlist", "clientupdate"]);
    // The line as it goes on the wire, escaped, with no return code yet.
    expect(seen[0]!.text).toBe("whoami a=b\\sc");
    expect(order.slice(0, 2)).toEqual(["outer:whoami", "inner:whoami"]);
    expect(sent).toHaveLength(3);
    answer(client, sent[0]!, "0");
    answer(client, sent[1]!, "0");
    await expect(typed).resolves.toEqual([]);
    await expect(raw).resolves.toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("still resolves a no-wait line once written when a middleware replaces the line and the signal", async () => {
    const replacing: LineMiddleware = (next) => (l, o) =>
      next({ ...l }, { signal: AbortSignal.any([o.signal, new AbortController().signal]) });
    const { client } = await connected({ lineMiddleware: [replacing] });
    const sent = wire();
    await client.execNoWait("clientupdate client_away=1");
    // Written with no return code, and nothing waits for an answer.
    expect(sent).toEqual(["clientupdate client_away=1"]);
    expect(sent[0]).not.toContain("return_code");
    // A line that is answered still gets its return code.
    const answered = client.exec("whoami");
    await settle();
    expect(sent[1]).toMatch(/return_code=\d+/);
    answer(client, sent[1]!, "0");
    await answered;
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("lets a line be refused before it is written", async () => {
    const { client } = await connected({
      lineMiddleware: [() => () => Promise.reject(new Error("no"))],
    });
    const sent = wire();
    await expect(client.exec("whoami")).rejects.toThrow("no");
    await expect(client.execNoWait("clientupdate")).rejects.toThrow("no");
    expect(sent).toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("does not pass the goodbye, which leaves at once", async () => {
    const seen: CommandLine[] = [];
    let release: (() => void) | undefined;
    const holding: LineMiddleware = (next) => async (l, o) => {
      seen.push(l);
      await new Promise<void>((resolve) => (release = resolve));
      return next(l, o);
    };
    const { client } = await connected({ lineMiddleware: [holding] });
    const sent = wire();
    const waiting = expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
    const waitingNoWait = expect(client.execNoWait("clientupdate")).rejects.toBeInstanceOf(
      NotConnectedError,
    );
    await settle();
    expect(seen.map((l) => l.name)).toEqual(["whoami", "clientupdate"]);

    await client.disconnect({ signal: AbortSignal.timeout(20) });
    await waiting;
    await waitingNoWait;
    // The goodbye was the only line written, and it did not pass the middleware.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^clientdisconnect /);
    expect(seen).toHaveLength(2);
    release?.();
  });

  it("aborts the signal of a line held when disconnect() begins, and never writes it", async () => {
    let signal: AbortSignal | undefined;
    let nextCalled = false;
    const holding: LineMiddleware = (next) => async (l, o) => {
      signal = o.signal;
      await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve()));
      nextCalled = true;
      return next(l, o);
    };
    const { client } = await connected({ lineMiddleware: [holding] });
    const sent = wire();
    const waiting = expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
    await settle();
    expect(signal?.aborted).toBe(false);

    await client.disconnect({ signal: AbortSignal.timeout(20) });
    await waiting;
    expect(signal?.aborted).toBe(true);
    // The middleware went on after the abort; the base looked at the
    // connection once more and refused.
    expect(nextCalled).toBe(true);
    expect(sent.filter((l) => !l.startsWith("clientdisconnect"))).toEqual([]);
  });

  it("refuses a line that a middleware hands on after the disconnect has begun", async () => {
    let release: (() => void) | undefined;
    const holding: LineMiddleware = (next) => async (l) => {
      await new Promise<void>((resolve) => (release = resolve));
      return next(l, { signal: new AbortController().signal });
    };
    const { client } = await connected({ lineMiddleware: [holding] });
    const sent = wire();
    const waiting = expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
    await settle();
    const leaving = client.disconnect({ signal: AbortSignal.timeout(20) });
    release?.();
    await waiting;
    await leaving;
    expect(sent.filter((l) => !l.startsWith("clientdisconnect"))).toEqual([]);
  });

  it("bounds the whole chain, a middleware's wait included, by the timeout", async () => {
    const hung: LineMiddleware = () => () => new Promise(() => {});
    const { client } = await connected({ lineMiddleware: [hung] });
    const started = Date.now();
    await expect(client.exec("whoami", { timeoutMs: 30 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(500);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("aborts the signal a middleware is given on the caller's signal and the timeout", async () => {
    const signals: AbortSignal[] = [];
    const holding: LineMiddleware = () => (_l, o) => {
      signals.push(o.signal);
      return new Promise(() => {});
    };
    const { client } = await connected({ lineMiddleware: [holding] });
    const reason = new Error("stop");
    const caller = new AbortController();
    const byCaller = expect(client.exec("whoami", { signal: caller.signal })).rejects.toBe(reason);
    const byTimeout = expect(client.exec("whoami", { timeoutMs: 20 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    await settle();
    caller.abort(reason);
    await byCaller;
    await byTimeout;
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(signals[0]!.reason).toBe(reason);
    expect(signals[1]!.reason).toBeInstanceOf(CommandTimeoutError);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("registers a return code for each call of next, and fires onSent once", async () => {
    const twice: LineMiddleware = (next) => async (l, o) => {
      try {
        return await next(l, o);
      } catch {
        return next(l, o);
      }
    };
    const { client } = await connected({ lineMiddleware: [twice] });
    const sent = wire();
    let onSent = 0;
    const result = client.exec("whoami", { onSent: () => onSent++ });
    await settle();
    expect(sent).toHaveLength(1);
    expect(onSent).toBe(1);
    answer(client, sent[0]!, "1024");
    await settle();
    expect(sent).toHaveLength(2);
    expect(onSent).toBe(1);
    const codes = sent.map((s) => /return_code=(\d+)/.exec(s)![1]);
    expect(new Set(codes).size).toBe(2);
    answer(client, sent[1]!, "0");
    await expect(result).resolves.toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("fires onSent after the middleware, when the line is handed to the connection", async () => {
    let release: (() => void) | undefined;
    const holding: LineMiddleware = (next) => async (l, o) => {
      await new Promise<void>((resolve) => (release = resolve));
      return next(l, o);
    };
    const { client } = await connected({ lineMiddleware: [holding] });
    const sent = wire();
    let onSent = 0;
    const result = client.exec("whoami", { onSent: () => onSent++ });
    await settle();
    expect(onSent).toBe(0);
    release?.();
    await settle();
    expect(onSent).toBe(1);
    answer(client, sent[0]!, "0");
    await result;
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("goes out at once with no middleware", async () => {
    const { client } = await connected();
    const sent = wire();
    const result = client.exec("whoami");
    expect(sent).toHaveLength(1);
    answer(client, sent[0]!, "0");
    await result;
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("a command refused as flooding", () => {
  // Measured on TeamSpeak 3 and 6: error 524 names a wait and did not run the
  // command. The client reports it as any server error and sends nothing more.
  it("rejects as the server's error, and is not sent again", async () => {
    const { client } = await connected();
    const sent = wire();
    const result = client.exec("whoami");
    const failed = expect(result).rejects.toSatisfy(
      (error: unknown) => error instanceof ServerError && error.code === 524,
    );
    await settle();
    answer(client, sent[0]!, "524", " extra_msg=retry\\sin\\s200ms");
    await failed;
    await new Promise((r) => setTimeout(r, 450));
    expect(sent).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the resend recipe of docs/flood-control.md", () => {
  // The server named a wait and did not run the command: the recipe pauses for
  // twice the wait, sends it again under a new return code, and holds every
  // other line meanwhile.
  it("sends a refused command again after twice the wait, with the others held", async () => {
    const pacer = new Pacer({ perSecond: 1000, burst: 100, start: 100 });
    const { client } = await connected({ lineMiddleware: [resendOnFlood(pacer), paced(pacer)] });
    const sent = wire();
    const times: number[] = [];
    onSentLine((_c, text) => void (sent.push(text), times.push(performance.now())));

    const first = client.exec("whoami");
    await settle();
    expect(sent).toHaveLength(1);
    answer(client, sent[0]!, "524", " extra_msg=retry\\sin\\s100ms");
    await settle();
    const other = client.exec("clientlist");
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toHaveLength(1);
    await until(() => sent.length >= 2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(190);
    expect(sent[1]).toMatch(/^whoami /);
    answer(client, sent[1]!, "0");
    await expect(first).resolves.toEqual([]);
    await until(() => sent.length >= 3);
    answer(client, sent[2]!, "0");
    await expect(other).resolves.toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("gives up after three resends with the server's error", async () => {
    const pacer = new Pacer({ perSecond: 1000, burst: 100, start: 100 });
    const { client } = await connected({ lineMiddleware: [resendOnFlood(pacer), paced(pacer)] });
    const sent = wire();
    const failed = expect(client.exec("whoami")).rejects.toMatchObject({ code: 524 });
    for (let n = 1; n <= 4; n++) {
      await until(() => sent.length >= n);
      answer(client, sent[n - 1]!, "524", " extra_msg=retry\\sin\\s5ms");
    }
    await failed;
    expect(sent).toHaveLength(4);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the connection's own lines", () => {
  /** Each connection numbers its command packets from 0: one counter per socket. */
  const ids = new WeakMap<FakeSocket, number>();
  const nextId = (socket: FakeSocket): number => {
    const id = ids.get(socket) ?? 0;
    ids.set(socket, id + 1);
    return id;
  };
  const deliverInitIV = (client: Client, socket: FakeSocket): void => {
    const crypt = clientInternals(client).crypt;
    const text = `clientinitiv alpha=${randomBytes(10).toString("base64")} beta=${randomBytes(10).toString("base64")} omega=${identity.publicKey()}`;
    socket.deliver(dummyPacket(crypt, 2, 0x20, nextId(socket), line(text)));
  };
  const deliverSession = (client: Client, socket: FakeSocket, text: string): void => {
    const crypt = clientInternals(client).crypt;
    socket.deliver(sessionPacket(crypt, 2, 0x20, nextId(socket), line(text)));
  };

  async function handshake(
    options: ClientOptions,
    initserver: string,
  ): Promise<{ client: Client; socket: FakeSocket; connecting: Promise<void> }> {
    let socket: FakeSocket | undefined;
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      socketFactory: () => (socket = new FakeSocket()),
      ...options,
    });
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => socket !== undefined && clientInternals(client).handler.isOpen);
    deliverInitIV(client, socket!);
    deliverSession(client, socket!, initserver);
    return { client, socket: socket!, connecting };
  }

  it("keeps the handshake's clientinit out of the middleware, and sends nothing else after initserver", async () => {
    const seen: CommandLine[] = [];
    const { client, socket, connecting } = await handshake(
      { lineMiddleware: [recorder(seen)] },
      "initserver aclid=7 virtualserver_version=3.13.7",
    );
    const sent = wire();
    await connecting;
    await settle();
    // clientinit went to the socket: there is more than the Init1 packet.
    expect(socket.sent.length).toBeGreaterThan(1);
    expect(seen).toEqual([]);
    // Nothing is said to tell the server this client is unmuted.
    expect(sent).toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("sends setconnectioninfo through the middleware", async () => {
    const seen: CommandLine[] = [];
    const { client, socket, connecting } = await handshake(
      { lineMiddleware: [recorder(seen)] },
      "initserver aclid=7 virtualserver_version=3.13.7",
    );
    await connecting;
    deliverSession(client, socket, "notifyconnectioninforequest");
    await until(() => seen.length > 0);
    expect(seen[0]!.name).toBe("setconnectioninfo");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("fails the attempt when initserver names no client id", async () => {
    for (const initserver of [
      "initserver virtualserver_version=3.13.7",
      "initserver aclid=0 virtualserver_version=3.13.7",
      "initserver aclid=x virtualserver_version=3.13.7",
    ]) {
      const { client, connecting } = await handshake({}, initserver);
      await expect(connecting).rejects.toBeInstanceOf(HandshakeError);
      expect(client.status).toBe("disconnected");
    }
    vi.restoreAllMocks();
  });
});
