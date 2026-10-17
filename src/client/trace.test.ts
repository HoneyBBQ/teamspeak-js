import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { Client, clientInternals, onSentLine } from "./client.js";
import { unknownServerCapabilities } from "./capabilities.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { ConnectPhase, type ClientTrace } from "./trace.js";
import { ConnectionTimeoutError, HandshakeError, InvalidAddressError } from "./errors.js";
import {
  NotConnectedError,
  asChannelGroupID,
  asChannelID,
  asClientID,
  getClientConnectionInfo,
} from "@honeybbq/teamspeak";
import { parseCommand } from "../core/internal.js";
import { GroupWhisperScope, GroupWhisperType } from "./types.js";
import {
  FakeSocket,
  completeCryptoInit,
  dummyPacket,
  init1Packet,
  sessionPacket,
} from "./testing/fake-server.js";
import type { ClientOptions } from "./types.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const line = (text: string): Uint8Array => new TextEncoder().encode(text);

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** A socket whose connect() never completes. */
class SlowSocket extends FakeSocket {
  override connect(): void {}
}

interface Recorded {
  readonly name: string;
  readonly info: Record<string, unknown>;
}

/** A trace with every hook set, recording each call in order. */
function recordingTrace(): {
  trace: ClientTrace;
  calls: Recorded[];
  names: () => string[];
} {
  const calls: Recorded[] = [];
  const record =
    (name: string) =>
    (info: object): void => {
      calls.push({ name, info: info as Record<string, unknown> });
    };
  const trace: ClientTrace = {
    resolveStart: record("resolveStart"),
    resolveDone: record("resolveDone"),
    connectStart: record("connectStart"),
    connectDone: record("connectDone"),
    handshakeDone: record("handshakeDone"),
    sessionStart: record("sessionStart"),
    welcomeDone: record("welcomeDone"),
    attemptFailed: record("attemptFailed"),
    disconnectStart: record("disconnectStart"),
    disconnectDone: record("disconnectDone"),
    sessionEnd: record("sessionEnd"),
    reconnectScheduled: record("reconnectScheduled"),
    reconnectStopped: record("reconnectStopped"),
  };
  return { trace, calls, names: () => calls.map((c) => c.name) };
}

function makeClient(options: ClientOptions = {}): {
  client: Client;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { client, sockets };
}

/** Each connection numbers its command packets from 0: one counter per socket. */
const packetIds = new WeakMap<FakeSocket, number>();
function nextId(socket: FakeSocket): number {
  const id = packetIds.get(socket) ?? 0;
  packetIds.set(socket, id + 1);
  return id;
}

/** Deliver the server's clientinitiv, which derives the shared secret. */
function deliverInitIV(client: Client, socket: FakeSocket, omega = identity.publicKey()): void {
  const crypt = clientInternals(client).crypt;
  const text = `clientinitiv alpha=${randomBytes(10).toString("base64")} beta=${randomBytes(54).toString("base64")} omega=${omega}`;
  socket.deliver(dummyPacket(crypt, 2, 0x20, nextId(socket), line(text)));
}

/** Deliver lines under the session key, once the handshake has derived it. */
function deliverSession(client: Client, socket: FakeSocket, text: string): void {
  const crypt = clientInternals(client).crypt;
  socket.deliver(sessionPacket(crypt, 2, 0x20, nextId(socket), line(text)));
}

/** Drive a full handshake over the wire, up to and including initserver. */
async function handshake(client: Client, sockets: FakeSocket[], index = 0): Promise<void> {
  await until(() => sockets[index] !== undefined && clientInternals(client).handler.isOpen);
  deliverInitIV(client, sockets[index]!);
  deliverSession(client, sockets[index]!, "initserver aclid=7 virtualserver_version=3.13.7");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a successful attempt", () => {
  it("reports the milestones in order, sessionStart before connect() resolves", async () => {
    const { trace, calls, names } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    let resolved = false;
    const connecting = client.connect().then(() => {
      resolved = true;
    });
    const connectedEvents: string[] = [];
    client.on("connected", () => connectedEvents.push("connected"));

    await handshake(client, sockets);
    await connecting;
    expect(names()).toEqual([
      "resolveStart",
      "resolveDone",
      "connectStart",
      "connectDone",
      "handshakeDone",
      "sessionStart",
    ]);
    deliverSession(client, sockets[0]!, "channellistfinished");
    await until(() => names().includes("welcomeDone"));
    expect(names().at(-1)).toBe("welcomeDone");

    const byName = new Map(calls.map((c) => [c.name, c.info]));
    expect(byName.get("resolveStart")).toMatchObject({
      addr: "127.0.0.1:9987",
      attempt: 1,
      reconnect: false,
    });
    expect(byName.get("resolveDone")).toMatchObject({
      addr: "127.0.0.1:9987",
      target: "127.0.0.1:9987",
      attempt: 1,
      reconnect: false,
    });
    expect(byName.get("connectStart")).toMatchObject({
      target: "127.0.0.1:9987",
    });
    for (const name of ["resolveDone", "handshakeDone", "sessionStart", "welcomeDone"]) {
      expect(byName.get(name)!["durationMs"]).toBeGreaterThanOrEqual(0);
    }
    expect(byName.get("sessionStart")).toMatchObject({ clientID: 7 });
    await settle();
    expect(connectedEvents).toEqual(["connected"]);
    expect(resolved).toBe(true);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("calls sessionStart before connect() resolves and before connected, and the hook can read the client", async () => {
    const order: string[] = [];
    let seenStatus: string | undefined;
    let seenID: number | undefined;
    const { client, sockets } = makeClient({
      trace: {
        sessionStart: (info) => {
          order.push("sessionStart");
          seenStatus = client.status;
          seenID = info.clientID;
          expect(client.clientID).toBe(info.clientID);
        },
      },
    });
    client.on("connected", () => order.push("connected"));
    const connecting = client.connect().then(() => order.push("resolved"));
    await handshake(client, sockets);
    await connecting;
    await settle();

    expect(order.slice(0, 2)).toEqual(["sessionStart", "resolved"]);
    expect(order).toContain("connected");
    expect(order.indexOf("sessionStart")).toBeLessThan(order.indexOf("connected"));
    expect(seenStatus).toBe("connected");
    expect(seenID).toBe(7);
    expect(client.clientID).toBe(7);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the resolver's source, and falls back to the address with the error", async () => {
    const sourced = recordingTrace();
    const first = makeClient({
      trace: sourced.trace,
      resolver: {
        resolve: async () => [{ addr: "127.0.0.1:1234", source: "SRV" }],
      },
    });
    const a = first.client.connect();
    a.catch(() => {});
    await until(() => sourced.names().includes("connectStart"));
    expect(sourced.calls.find((c) => c.name === "resolveDone")!.info).toMatchObject({
      target: "127.0.0.1:1234",
      source: "SRV",
      error: undefined,
    });
    await first.client.disconnect();

    const failure = new Error("no such name");
    const fell = recordingTrace();
    const second = makeClient({
      trace: fell.trace,
      resolver: {
        resolve: async () => {
          throw failure;
        },
      },
    });
    const b = second.client.connect();
    b.catch(() => {});
    await until(() => fell.names().includes("connectStart"));
    expect(fell.calls.find((c) => c.name === "resolveDone")!.info).toMatchObject({
      target: "127.0.0.1:9987",
      source: "",
      error: failure,
    });
    await second.client.disconnect();
  });

  it("fires welcomeDone at most once, and never before sessionStart", async () => {
    const { trace, names } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "channellistfinished");
    await settle();
    expect(names()).not.toContain("welcomeDone");

    deliverSession(client, sockets[0]!, "initserver aclid=7 virtualserver_version=3.13.7");
    await connecting;
    deliverSession(client, sockets[0]!, "channellistfinished");
    deliverSession(client, sockets[0]!, "channellistfinished");
    await settle();
    expect(names().filter((n) => n === "welcomeDone")).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("a failed attempt", () => {
  /** Exactly one attemptFailed with this phase, and no sessionStart. */
  function expectFailedIn(
    calls: Recorded[],
    phase: ConnectPhase,
    check: (error: unknown) => void,
  ): void {
    expect(calls.filter((c) => c.name === "sessionStart")).toHaveLength(0);
    const failed = calls.filter((c) => c.name === "attemptFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.info).toMatchObject({
      phase,
      attempt: 1,
      reconnect: false,
    });
    expect(failed[0]!.info["durationMs"]).toBeGreaterThanOrEqual(0);
    check(failed[0]!.info["error"]);
    expect(calls.at(-1)!.name).toBe("attemptFailed");
  }

  it("in open, when the address is invalid once resolved", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      trace: trace,
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBeInstanceOf(InvalidAddressError));
  });

  it("in open, when the signal aborts the address lookup", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      trace: trace,
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await settle();
    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(reason));
    expect(calls.map((c) => c.name)).not.toContain("resolveDone");
  });

  it("in open, when the signal aborts while the socket is opening", async () => {
    const { trace, calls } = recordingTrace();
    let socket: SlowSocket | undefined;
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      trace: trace,
      socketFactory: () => (socket = new SlowSocket()),
    });
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => socket !== undefined);
    const reason = new Error("gave up");
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(reason));
  });

  it("in open, when the socket errors", async () => {
    const { trace, calls } = recordingTrace();
    const boom = new Error("socket boom");
    class FailingSocket extends FakeSocket {
      #onError: Array<(error: Error) => void> = [];
      override connect(): void {
        queueMicrotask(() => {
          for (const listener of this.#onError) listener(boom);
        });
      }
      override once(event: "error", listener: (error: Error) => void): this {
        this.#onError.push(listener);
        return super.once(event, listener);
      }
    }
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      trace: trace,
      socketFactory: () => new FailingSocket(),
    });
    await expect(client.connect()).rejects.toBe(boom);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBe(boom));
  });

  it("in handshake, when the socket closes before the shared secret", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    sockets[0]!.close();
    await expect(connecting).rejects.toBeInstanceOf(Error);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) => expect(e).toBeInstanceOf(Error));
  });

  it("in handshake, on a HandshakeError", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!, "bm90IGEga2V5");
    await expect(connecting).rejects.toBeInstanceOf(HandshakeError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) => expect(e).toBeInstanceOf(HandshakeError));
    expect(calls.map((c) => c.name)).not.toContain("handshakeDone");
  });

  it("in handshake, on the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({ trace: trace });
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    for (let second = 0; second < 70; second++) vi.advanceTimersByTime(1_000);
    await expect(connecting).rejects.toBeInstanceOf(ConnectionTimeoutError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) =>
      expect(e).toBeInstanceOf(ConnectionTimeoutError),
    );
  });

  it("in handshake, when disconnect() ends it", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expectFailedIn(calls, ConnectPhase.Handshake, (e) =>
      expect(e).toBeInstanceOf(NotConnectedError),
    );
  });

  it("in open, when disconnect() ends it during the lookup", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      trace: trace,
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const connecting = client.connect();
    await settle();
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expectFailedIn(calls, ConnectPhase.Open, (e) => expect(e).toBeInstanceOf(NotConnectedError));
  });

  it("in join, when the server refuses before initserver", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "error id=520 msg=wrong\\spassword");
    await expect(connecting).rejects.toMatchObject({ code: 520 });
    expectFailedIn(calls, ConnectPhase.Join, (e) => expect(e).toMatchObject({ code: 520 }));
    expect(calls.map((c) => c.name)).toContain("handshakeDone");
  });

  it("with exactly one attemptFailed even when the failure is reported twice", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(client, sockets[0]!, "error id=520 msg=a");
    deliverSession(client, sockets[0]!, "error id=521 msg=b");
    sockets[0]!.close();
    await expect(connecting).rejects.toMatchObject({ code: 520 });
    await client.disconnect().catch(() => {});
    await settle();
    expect(calls.filter((c) => c.name === "attemptFailed")).toHaveLength(1);
  });
});

describe("reconnecting", () => {
  it("reports reconnectScheduled, and numbers the attempts it makes", async () => {
    const { trace, calls, names } = recordingTrace();
    const { client, sockets } = makeClient({
      trace: trace,
      reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;

    sockets[0]!.close();
    await until(() => sockets.length === 2);
    const scheduled = calls.find((c) => c.name === "reconnectScheduled")!;
    expect(scheduled.info).toMatchObject({ attempt: 1, delayMs: 20 });
    expect(scheduled.info["cause"]).toBeInstanceOf(Error);

    await handshake(client, sockets, 1);
    await until(() => client.status === "connected");
    const starts = calls.filter((c) => c.name === "resolveStart");
    expect(starts.map((c) => c.info)).toMatchObject([
      { attempt: 1, reconnect: false },
      { attempt: 1, reconnect: true },
    ]);
    expect(names().filter((n) => n === "sessionStart")).toHaveLength(2);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports a failed reconnection attempt, then schedules the next", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      trace: trace,
      reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.close();
    await until(() => sockets.length === 2);
    await until(() => clientInternals(client).handler.isOpen);
    sockets[1]!.close();
    await until(() => sockets.length === 3);

    const failed = calls.filter((c) => c.name === "attemptFailed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.info).toMatchObject({
      attempt: 1,
      reconnect: true,
      phase: "handshake",
    });
    const scheduled = calls.filter((c) => c.name === "reconnectScheduled");
    expect(scheduled.map((c) => c.info["attempt"])).toEqual([1, 2]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("a hook that fails", () => {
  /** Run `body` with queueMicrotask's rethrows collected rather than thrown. */
  async function collecting(body: () => Promise<void>): Promise<unknown[]> {
    const rethrown: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      rethrown.push(task);
    });
    try {
      await body();
      await settle();
    } finally {
      spy.mockRestore();
    }
    const errors: unknown[] = [];
    for (const task of rethrown) {
      try {
        task();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  it("is reported, whether it throws or rejects, and the connection completes", async () => {
    const boom = new Error("hook boom");
    const rejection = new Error("hook rejection");
    const trace: ClientTrace = {
      resolveStart: () => {
        throw boom;
      },
      // oxlint-disable-next-line typescript/no-misused-promises -- a hook that rejects is the case under test
      handshakeDone: async () => {
        throw rejection;
      },
      sessionStart: () => {
        throw boom;
      },
    };
    const { client, sockets } = makeClient({ trace: trace });
    const connected: string[] = [];
    client.on("connected", () => connected.push("connected"));
    const errors = await collecting(async () => {
      const connecting = client.connect();
      await handshake(client, sockets);
      await connecting;
    });
    expect(errors.filter((e) => e === boom)).toHaveLength(2);
    expect(errors.filter((e) => e === rejection)).toHaveLength(1);
    expect(client.status).toBe("connected");
    expect(connected).toEqual(["connected"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("is reported as an uncaught exception, as a throwing listener's is", async () => {
    const boom = new Error("uncaught hook");
    const seen: unknown[] = [];
    const listener = (error: unknown): void => {
      seen.push(error);
    };
    // vitest installs its own handler; ours only observes.
    process.on("uncaughtException", listener);
    try {
      const { client, sockets } = makeClient({
        trace: {
          sessionStart: () => {
            throw boom;
          },
        },
      });
      const connecting = client.connect();
      await handshake(client, sockets);
      await connecting;
      await settle();
      await settle();
      expect(seen).toContain(boom);
      expect(client.status).toBe("connected");
      await client.disconnect({ signal: AbortSignal.timeout(1) });
    } finally {
      process.off("uncaughtException", listener);
    }
  });

  it("does not turn a failure into another one", async () => {
    const { client } = makeClient({
      trace: {
        attemptFailed: () => {
          throw new Error("hook boom");
        },
      },
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    const errors = await collecting(async () => {
      await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    });
    expect(errors).toHaveLength(1);
  });
});

// Not supported (the documented rule forbids it), but it must not break the
// client either.
// Calling disconnect() from a hook is not supported (the rule is to use a
// `connected` listener). These tests only pin that it does no harm.
describe("disconnect() from a hook", () => {
  it("is safe from sessionStart: the attempt stays a success and the client ends disconnected", async () => {
    const calls: string[] = [];
    let leaving: Promise<void> | undefined;
    const { client, sockets } = makeClient({
      trace: {
        sessionStart: () => {
          calls.push("sessionStart");
          leaving = clientRef!.disconnect({ signal: AbortSignal.timeout(1) });
        },
        attemptFailed: () => calls.push("attemptFailed"),
      },
    });
    const clientRef: Client | undefined = client;
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    client.on("disconnected", () => events.push("disconnected"));
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await leaving;
    await settle();
    expect(calls).toEqual(["sessionStart"]);
    expect(events).toEqual(["connected", "disconnected"]);
    expect(client.status).toBe("disconnected");
  }, 5_000);

  it("is safe from handshakeDone: the attempt fails once, in join", async () => {
    const calls: Array<[string, unknown]> = [];
    let leaving: Promise<void> | undefined;
    const { client, sockets } = makeClient({
      trace: {
        handshakeDone: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
        sessionStart: () => calls.push(["sessionStart", undefined]),
        attemptFailed: (info) => calls.push(["attemptFailed", info.phase]),
      },
    });
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    await leaving;
    expect(calls).toEqual([["attemptFailed", "join"]]);
    expect(client.status).toBe("disconnected");
  }, 5_000);
});

// Not supported either; see above.
describe("disconnect() from other hooks", () => {
  it("is safe from resolveStart: the attempt fails once, in open", async () => {
    const calls: Array<[string, unknown]> = [];
    let leaving: Promise<void> | undefined;
    const { client } = makeClient({
      trace: {
        resolveStart: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
        resolveDone: () => calls.push(["resolveDone", undefined]),
        attemptFailed: (info) => calls.push(["attemptFailed", info.phase]),
      },
    });
    await expect(client.connect()).rejects.toBeInstanceOf(NotConnectedError);
    await leaving;
    expect(calls).toEqual([["attemptFailed", "open"]]);
    expect(client.status).toBe("disconnected");
  }, 5_000);

  it("is safe from attemptFailed", async () => {
    let leaving: Promise<void> | undefined;
    const events: string[] = [];
    const { client } = makeClient({
      trace: {
        attemptFailed: () => {
          leaving = client.disconnect({ signal: AbortSignal.timeout(1) });
        },
      },
      resolver: { resolve: async () => [{ addr: "127.0.0.1:99999" }] },
    });
    client.on("disconnected", () => events.push("disconnected"));
    await expect(client.connect()).rejects.toBeInstanceOf(InvalidAddressError);
    await leaving;
    await settle();
    expect(events).toEqual(["disconnected"]);
    expect(client.status).toBe("disconnected");
  }, 5_000);
});

describe("without a trace", () => {
  it("connects with no trace", async () => {
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("connects with a trace that has no hooks, and copies it", async () => {
    const trace: { sessionStart?: () => void } = {};
    const { client, sockets } = makeClient({ trace: trace });
    // Added after construction: the client holds a copy, so this is never called.
    trace.sessionStart = () => {
      throw new Error("must not run");
    };
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("works through the internals seam used by other tests", async () => {
    const { trace, names } = recordingTrace();
    const { client } = makeClient({ trace: trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    completeCryptoInit(clientInternals(client).crypt);
    clientInternals(client).markHandshakeDone();
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;
    expect(names()).toEqual([
      "resolveStart",
      "resolveDone",
      "connectStart",
      "connectDone",
      "handshakeDone",
      "sessionStart",
    ]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

// ---- The fuller milestones, and the end of a session ---------------------------

/** An Init1 step 4 packet, which carries the RSA puzzle: x, n and the level. */
function puzzlePacket(level: number): Uint8Array {
  const data = new Uint8Array(1 + 64 + 64 + 4 + 100);
  data[0] = 3;
  data[64] = 5; // x
  data[128] = 7; // n
  new DataView(data.buffer).setUint32(129, level, false);
  return init1Packet(data);
}

describe("what each milestone knows", () => {
  it("reports the candidates, the local address and the target on a failure", async () => {
    const { trace, calls } = recordingTrace();
    class BoundSocket extends FakeSocket {
      address(): { address: string; port: number } {
        return { address: "127.0.0.1", port: 50123 };
      }
    }
    const candidates = [
      { addr: "127.0.0.1:1111", source: "SRV" },
      { addr: "127.0.0.1:2222", source: "Direct" },
    ];
    const client = new Client(identity, "127.0.0.1:9987", "Bot", {
      trace,
      socketFactory: () => new BoundSocket(),
      resolver: { resolve: async () => candidates },
    });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    const done = calls.find((c) => c.name === "resolveDone")!.info;
    expect(done["candidates"]).toEqual(candidates);
    expect(done["target"]).toBe("127.0.0.1:1111");
    expect(calls.find((c) => c.name === "connectDone")!.info).toMatchObject({
      target: "127.0.0.1:1111",
      localAddr: "127.0.0.1:50123",
    });
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expect(calls.find((c) => c.name === "attemptFailed")!.info["target"]).toBe("127.0.0.1:1111");
  });

  it("leaves target empty and the local address empty when it cannot know them", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({
      trace,
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const connecting = client.connect();
    await settle();
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expect(calls.find((c) => c.name === "attemptFailed")!.info["target"]).toBe("");

    const bare = recordingTrace();
    const second = makeClient({ trace: bare.trace });
    const again = second.client.connect();
    await until(() => clientInternals(second.client).handler.isOpen);
    expect(bare.calls.find((c) => c.name === "connectDone")!.info["localAddr"]).toBe("");
    await second.client.disconnect();
    await again.catch(() => {});
  });

  it("reports the puzzle, the resends and the server's public key at handshakeDone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    sockets[0]!.deliver(puzzlePacket(3));
    // Nothing is acknowledged: the Init1 packet goes out again.
    vi.advanceTimersByTime(1_200);
    const omega = identity.publicKey();
    deliverInitIV(client, sockets[0]!, omega);
    deliverSession(client, sockets[0]!, "initserver aclid=7 virtualserver_version=3.13.7");
    await connecting;
    const info = calls.find((c) => c.name === "handshakeDone")!.info;
    expect(info["puzzleLevel"]).toBe(3);
    expect(info["puzzleDurationMs"]).toBeGreaterThanOrEqual(0);
    expect(info["resends"]).toBeGreaterThanOrEqual(1);
    expect(info["serverPublicKey"]).toBe(omega);
    vi.useRealTimers();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports puzzle level 0 and no resends when the server sent no puzzle", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    expect(calls.find((c) => c.name === "handshakeDone")!.info).toMatchObject({
      puzzleLevel: 0,
      puzzleDurationMs: 0,
      resends: 0,
    });
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the accepted nickname, talk power and initserver without its secrets", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(
      client,
      sockets[0]!,
      "initserver aclid=7 acn=Bot\\s2 client_talk_power=75 virtualserver_name=My\\sServer " +
        "virtualserver_version=3.13.7 virtualserver_id=4 " +
        "client_server_password=hunter2 client_default_channel_password=hunter3 " +
        "client_default_token=tok client_key_offset=99",
    );
    await connecting;
    const info = calls.find((c) => c.name === "sessionStart")!.info;
    expect(info["nickname"]).toBe("Bot 2");
    expect(info["talkPower"]).toBe(75);
    const initServer = info["initServer"] as Record<string, string>;
    expect(initServer["virtualserver_name"]).toBe("My Server");
    expect(initServer["aclid"]).toBe("7");
    for (const secret of [
      "client_server_password",
      "client_default_channel_password",
      "client_default_token",
      "client_key_offset",
    ]) {
      expect(initServer).not.toHaveProperty(secret);
    }
    expect(Object.isFrozen(initServer)).toBe(true);
    expect(
      JSON.stringify(
        calls.map((c) => c.info),
        (_, v) => (typeof v === "bigint" ? String(v) : v),
      ),
    ).not.toContain("hunter");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the capability fields", async () => {
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    deliverInitIV(client, sockets[0]!);
    deliverSession(
      client,
      sockets[0]!,
      "initserver aclid=7 virtualserver_version=3.13.7 virtualserver_id=4 " +
        "virtualserver_unique_identifier=abc= virtualserver_hostmessage=Hello " +
        "virtualserver_hostmessage_mode=2",
    );
    await connecting;
    expect(client.serverCapabilities).toMatchObject({
      serverID: 4n,
      serverUID: "abc=",
      hostMessage: "Hello",
      hostMessageMode: 2,
    });
    expect(unknownServerCapabilities()).toMatchObject({
      serverID: 0n,
      serverUID: "",
      hostMessage: "",
      hostMessageMode: 0,
    });
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports where the client landed and what the welcome delivered", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    deliverSession(
      client,
      sockets[0]!,
      "channellist cid=1 channel_name=A|cid=2 channel_name=B|cid=5 channel_name=C",
    );
    deliverSession(
      client,
      sockets[0]!,
      "notifycliententerview clid=7 ctid=5 client_nickname=Bot client_unique_identifier=x",
    );
    deliverSession(
      client,
      sockets[0]!,
      "notifycliententerview clid=9 ctid=2 client_nickname=Other client_unique_identifier=y",
    );
    deliverSession(client, sockets[0]!, "channellistfinished");
    await until(() => calls.some((c) => c.name === "welcomeDone"));
    expect(calls.find((c) => c.name === "welcomeDone")!.info).toMatchObject({
      channelID: asChannelID(5n),
      channels: 3,
      clients: 2,
    });
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the end of a session", () => {
  /** Answer the goodbye the client sends, so that it is acknowledged. */
  function acknowledgeGoodbye(client: Client, socket: FakeSocket): () => Promise<void> {
    let returnCode: string | undefined;
    onSentLine((_, text) => {
      if (text.startsWith("clientdisconnect")) returnCode = /return_code=(\S+)/.exec(text)?.[1];
    });
    return async () => {
      await until(() => returnCode !== undefined);
      deliverSession(client, socket, `error id=0 msg=ok return_code=${returnCode}`);
      onSentLine(undefined);
    };
  }

  it("goes disconnectStart, disconnectDone, sessionEnd, disconnected; acknowledged", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const order: string[] = [];
    client.on("disconnected", () => order.push("disconnected"));
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await settle();
    calls.length = 0;
    const answer = acknowledgeGoodbye(client, sockets[0]!);

    const leaving = client.disconnect();
    await answer();
    await leaving;
    expect(calls.map((c) => c.name)).toEqual(["disconnectStart", "disconnectDone", "sessionEnd"]);
    expect(order).toEqual(["disconnected"]);
    expect(calls[1]!.info).toMatchObject({ acknowledged: true });
    expect(calls[1]!.info["durationMs"]).toBeGreaterThanOrEqual(0);
    expect(calls[2]!.info).toMatchObject({
      clientID: 7,
      error: undefined,
      attempt: 1,
      reconnect: false,
    });
    expect(calls[2]!.info["durationMs"]).toBeGreaterThanOrEqual(0);
  });

  it("takes the server's announcement that this client left as the answer, as real servers send it", async () => {
    // TeamSpeak 3 and 6 answer clientdisconnect with notifyclientleftview
    // about this client and no error line; waiting for the error line held
    // every disconnect() for its full timeout.
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await settle();
    calls.length = 0;
    let saidGoodbye = false;
    onSentLine((_, text) => {
      if (text.startsWith("clientdisconnect")) saidGoodbye = true;
    });

    const started = performance.now();
    const leaving = client.disconnect({ signal: AbortSignal.timeout(5_000) });
    await until(() => saidGoodbye);
    onSentLine(undefined);
    deliverSession(client, sockets[0]!, `notifyclientleftview cfid=1 ctid=0 reasonid=8 clid=7`);
    await leaving;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls[1]!.info).toMatchObject({ acknowledged: true });
  });

  it("reports acknowledged false when the server does not answer", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const order: string[] = [];
    client.on("disconnected", () => order.push(`disconnected after ${calls.length} hooks`));
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await settle();
    calls.length = 0;
    await client.disconnect({ signal: AbortSignal.timeout(20) });
    expect(calls.map((c) => c.name)).toEqual(["disconnectStart", "disconnectDone", "sessionEnd"]);
    expect(calls[1]!.info).toMatchObject({ acknowledged: false });
    // sessionEnd came before the disconnected event was delivered.
    expect(order).toEqual(["disconnected after 3 hooks"]);
  });

  it("does not call disconnectStart when there is no session, and reports no sessionEnd", async () => {
    const { trace, calls } = recordingTrace();
    const { client } = makeClient({ trace });
    await client.disconnect();
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    await client.disconnect();
    await connecting.catch(() => {});
    const names = calls.map((c) => c.name);
    expect(names).not.toContain("disconnectStart");
    expect(names).not.toContain("sessionEnd");
  });

  it("reports sessionEnd with its cause on a drop, before reconnectScheduled", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      trace,
      reconnect: { backoff: { initialDelayMs: 5_000, maxDelayMs: 5_000, jitter: 0 } },
    });
    const events: string[] = [];
    client.on("disconnected", () => events.push(`disconnected after ${calls.length}`));
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await settle();
    const before = calls.length;
    sockets[0]!.close();
    await until(() => calls.some((c) => c.name === "reconnectScheduled"));
    const after = calls.slice(before).map((c) => c.name);
    expect(after).toEqual(["sessionEnd", "reconnectScheduled"]);
    const end = calls[before]!.info;
    expect(end["error"]).toBeInstanceOf(Error);
    expect(end).toMatchObject({ clientID: 7, attempt: 1, reconnect: false });
    await settle();
    expect(events).toEqual([`disconnected after ${before + 2}`]);
    await client.disconnect();
  });

  it("reports reconnectStopped when shouldRetry declines", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      trace,
      reconnect: { shouldRetry: () => false },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.close();
    await until(() => calls.some((c) => c.name === "reconnectStopped"));
    const stopped = calls.find((c) => c.name === "reconnectStopped")!.info;
    expect(stopped["attempts"]).toBe(0);
    expect(stopped["cause"]).toBeInstanceOf(Error);
    expect(calls.map((c) => c.name)).not.toContain("reconnectScheduled");
  });

  it("reports reconnectStopped with no cause when disconnect() stops the loop", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      trace,
      reconnect: { backoff: { initialDelayMs: 60_000, maxDelayMs: 60_000, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.close();
    await until(() => calls.some((c) => c.name === "reconnectScheduled"));
    await client.disconnect();
    await until(() => calls.some((c) => c.name === "reconnectStopped"));
    const stopped = calls.find((c) => c.name === "reconnectStopped")!.info;
    expect(stopped["attempts"]).toBe(0);
    expect(stopped["cause"]).toBeUndefined();
  });

  it("reports exactly one sessionEnd per session", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({
      trace,
      reconnect: { backoff: { initialDelayMs: 20, maxDelayMs: 20, jitter: 0 } },
    });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.close();
    await until(() => sockets.length === 2);
    await handshake(client, sockets, 1);
    await until(() => client.status === "connected");
    // The server's kick, then the goodbye of a client that is already gone.
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    await client.disconnect().catch(() => {});
    await settle();
    const ends = calls.filter((c) => c.name === "sessionEnd");
    expect(ends).toHaveLength(2);
    expect(ends.map((c) => c.info["reconnect"])).toEqual([false, true]);
  });

  it("reports one sessionEnd when the server removes the client", async () => {
    const { trace, calls } = recordingTrace();
    const { client, sockets } = makeClient({ trace });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    deliverSession(
      client,
      sockets[0]!,
      "notifyclientleftview clid=7 reasonid=5 reasonmsg=bye invokerid=2 invokername=Admin invokeruid=x",
    );
    await until(() => calls.some((c) => c.name === "sessionEnd"));
    await client.disconnect().catch(() => {});
    expect(calls.filter((c) => c.name === "sessionEnd")).toHaveLength(1);
    expect(calls.find((c) => c.name === "sessionEnd")!.info["error"]).toBeInstanceOf(Error);
  });
});

describe("the connect and leave options", () => {
  it("drops the privilege key once joined and keeps the meta data", async () => {
    const { client, sockets } = makeClient({ privilegeKey: "tok+/=", metaData: "m d" });
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;

    expect(client.status).toBe("connected");
    expect(clientInternals(client).initOptions.privilegeKey).toBe("");
    expect(clientInternals(client).initOptions.metaData).toBe("m d");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("says goodbye with the reason message it is given, escaped", async () => {
    const lines: string[] = [];
    onSentLine((_, text) => lines.push(text));
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await client.disconnect({ reasonMessage: "back soon|bye", signal: AbortSignal.timeout(1) });
    onSentLine(undefined);

    expect(lines.find((l) => l.startsWith("clientdisconnect"))).toMatch(
      /^clientdisconnect reasonid=8 reasonmsg=back\\ssoon\\pbye/,
    );
  });

  it("keeps the Shutdown goodbye by default", async () => {
    const lines: string[] = [];
    onSentLine((_, text) => lines.push(text));
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    onSentLine(undefined);

    expect(lines.find((l) => l.startsWith("clientdisconnect"))).toMatch(
      /^clientdisconnect reasonid=8 reasonmsg=Shutdown/,
    );
  });

  it("refuses to whisper while not connected, in either form", () => {
    const { client } = makeClient();
    const audio = new Uint8Array([1]);
    expect(() => client.sendWhisper(audio, { channels: [asChannelID(2n)] }, 5)).toThrow(
      NotConnectedError,
    );
    expect(() =>
      client.sendGroupWhisper(audio, { type: GroupWhisperType.AllClients, scope: 0 }, 5),
    ).toThrow(NotConnectedError);
  });

  it("writes a group whisper with the id of the group it names", async () => {
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    sockets[0]!.sent.length = 0;
    client.sendGroupWhisper(
      new Uint8Array([0xee]),
      {
        type: GroupWhisperType.ChannelGroup,
        scope: GroupWhisperScope.CurrentChannel,
        group: asChannelGroupID(0x0102n),
      },
      5,
    );
    client.sendWhisper(new Uint8Array([0xee]), { channels: [asChannelID(0x0304n)] }, 5);

    const [group, direct] = sockets[0]!.sent;
    expect(group![8 + 4]).toBe(0xa1);
    expect([...group!.subarray(8 + 5 + 3)]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 1, 2, 0xee]);
    expect(direct![8 + 4]).toBe(0x81);
    expect([...direct!.subarray(8 + 5 + 3)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 3, 4, 0xee]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the connection info request", () => {
  it("is answered with setconnectioninfo carrying the connection's own counters", async () => {
    const lines: string[] = [];
    onSentLine((_, text) => lines.push(text));
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    deliverSession(client, sockets[0]!, "notifyconnectioninforequest");
    await until(() => lines.some((l) => l.startsWith("setconnectioninfo")));
    onSentLine(undefined);

    const answer = parseCommand(lines.find((l) => l.startsWith("setconnectioninfo"))!)!.params;
    expect(Number(answer["connection_packets_received_control"])).toBeGreaterThan(0);
    expect(Number(answer["connection_bytes_sent_control"])).toBeGreaterThan(0);
    expect(answer).not.toHaveProperty("connection_ping");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  // Recorded on TeamSpeak 6 with several commands in flight: the error of the
  // command arrived before its row, and unprompted rows for the same client
  // came in between. Each call must still get its own client's row.
  it("answers getconnectioninfo whether the row or the error comes first", async () => {
    const lines: string[] = [];
    onSentLine((_, text) => lines.push(text));
    const { client, sockets } = makeClient();
    const connecting = client.connect();
    await handshake(client, sockets);
    await connecting;
    const rcOf = (n: number): string =>
      /return_code=(\S+)/.exec(lines.filter((l) => l.startsWith("getconnectioninfo"))[n]!)![1]!;
    const row = (clid: number): string =>
      `notifyconnectioninfo clid=${clid} connection_ping=${clid}.0000`;

    const first = getClientConnectionInfo(client, asClientID(192));
    const second = getClientConnectionInfo(client, asClientID(193));
    await until(() => lines.filter((l) => l.startsWith("getconnectioninfo")).length === 2);
    deliverSession(client, sockets[0]!, `error id=0 msg=ok return_code=${rcOf(0)}`);
    deliverSession(client, sockets[0]!, row(192));
    deliverSession(client, sockets[0]!, row(193));
    deliverSession(client, sockets[0]!, `error id=0 msg=ok return_code=${rcOf(1)}`);

    expect((await first).id).toBe(192);
    expect((await second).id).toBe(193);
    onSentLine(undefined);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
