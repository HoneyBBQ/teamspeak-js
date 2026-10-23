import { clientInternals } from "./client.js";
import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { ConnectionTimeoutError } from "./errors.js";
import {
  CommandTimeoutError,
  Codec,
  NotConnectedError,
  asClientID,
  type Logger,
} from "@honeybbq/teamspeak";
import { CommandThrottle } from "./throttle.js";
import { PacketType, type Packet } from "./transport/packet.js";
import {
  FakeSocket,
  completeCryptoInit,
  datagram,
  plainPacket,
  s2cHeader,
} from "./testing/fake-server.js";
import type { ClientOptions } from "./types.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** A socket whose connect() completes only when the test says so. */
class SlowSocket extends FakeSocket {
  #connected: (() => void) | undefined;
  override connect(_port: number, _address: string, callback: () => void): void {
    this.#connected = callback;
  }
  finishConnecting(): void {
    this.#connected?.();
  }
}

function clientOn(socket: () => FakeSocket, options: ClientOptions = {}): Client {
  return new Client(identity, "127.0.0.1:9987", "Bot", { socketFactory: socket, ...options });
}

function packet(type: PacketType, data: Uint8Array): Packet {
  return {
    typeFlagged: type,
    id: 1,
    clientID: 0,
    generationID: 0,
    data,
    receivedAt: performance.now(),
  };
}

/** A client that has completed a handshake against a socket that answers nothing. */
async function connected(
  options: ClientOptions = {},
): Promise<{ client: Client; socket: FakeSocket }> {
  let socket: FakeSocket | undefined;
  const client = clientOn(() => (socket = new FakeSocket()), options);
  const connecting = client.connect();
  await until(() => clientInternals(client).handler.isOpen);
  completeCryptoInit(clientInternals(client).crypt);
  clientInternals(client).clid = 5;
  clientInternals(client).markConnected();
  await connecting;
  return { client, socket: socket! };
}

describe("connect() interrupted", () => {
  it("never starts a socket that finishes connecting after disconnect()", async () => {
    let socket: SlowSocket | undefined;
    const client = clientOn(() => (socket = new SlowSocket()));
    const connectedEvents: unknown[] = [];
    client.on("connected", () => connectedEvents.push(true));

    const connecting = client.connect();
    connecting.catch(() => {}); // asserted below, after the socket finishes
    await until(() => socket !== undefined);
    await client.disconnect();
    socket!.finishConnecting();
    await settle();

    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
    expect(socket!.closed).toBe(true);
    // No Init1 went out: the handshake never began.
    expect(socket!.sent).toEqual([]);
    expect(clientInternals(client).handler.isOpen).toBe(false);
    expect(connectedEvents).toEqual([]);
  });

  it("abandons a resolver that ignores the signal", async () => {
    const client = clientOn(() => new FakeSocket(), {
      resolver: { resolve: () => new Promise(() => {}) },
    });
    const connecting = client.connect();
    await settle();
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("stops at the signal while the socket is still connecting", async () => {
    let socket: SlowSocket | undefined;
    const client = clientOn(() => (socket = new SlowSocket()));
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => socket !== undefined);
    const reason = new Error("gave up");
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(socket!.closed).toBe(true);
    socket!.finishConnecting();
    expect(socket!.sent).toEqual([]);
  });

  it("does not announce a handshake that completes after disconnect()", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    const events: string[] = [];
    client.on("connected", () => events.push("connected"));
    clientInternals(client).markConnected();
    await settle();
    expect(events).toEqual([]);
    expect(client.status).toBe("disconnected");
  });
});

describe("connect() during disconnect()", () => {
  it("waits for the goodbye, then connects on a new socket", async () => {
    const sockets: FakeSocket[] = [];
    const client = clientOn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const first = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    clientInternals(client).markConnected();
    await first;

    const events: string[] = [];
    client.on("disconnected", (e) => events.push(`disconnected:${e.error?.name ?? "-"}`));
    // The fake server never acknowledges the goodbye, so it waits its second.
    const leaving = client.disconnect();
    await settle();
    const reconnecting = client.connect();
    await leaving;
    await until(() => sockets.length === 2 && clientInternals(client).handler.isOpen);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets[1]!.closed).toBe(false);
    expect(client.status).toBe("connecting");

    clientInternals(client).markConnected();
    await reconnecting;
    await settle();
    expect(events).toEqual(["disconnected:-"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("rejects when disconnect() is called again during the wait", async () => {
    const { client } = await connected();
    const leaving = client.disconnect();
    await settle();
    const reconnecting = client.connect();
    const again = client.disconnect();
    await expect(reconnecting).rejects.toBeInstanceOf(NotConnectedError);
    await Promise.all([leaving, again]);
    expect(client.status).toBe("disconnected");
  });
});

describe("a listener that throws", () => {
  it("does not stop the others, and is rethrown on its own", async () => {
    const { client } = await connected();
    const got: string[] = [];
    client.on("textMessage", () => {
      throw new Error("listener boom");
    });
    client.on("textMessage", (m) => got.push(`second:${m.message}`));
    client.on("poked", (m) => got.push(`poke:${m.message}`));

    const rethrown: Array<() => void> = [];
    const spy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      rethrown.push(task);
    });
    try {
      const lines = [
        "notifytextmessage targetmode=1 msg=a invokerid=2",
        "notifyclientpoke msg=p invokerid=2",
        "notifytextmessage targetmode=1 msg=b invokerid=2",
      ].join("\n");
      clientInternals(client).handlePacket(
        packet(PacketType.Command, new TextEncoder().encode(lines)),
      );
      await settle();
      await settle();
    } finally {
      spy.mockRestore();
    }
    expect(got).toEqual(["second:a", "poke:p", "second:b"]);
    expect(rethrown).toHaveLength(2);
    for (const task of rethrown) expect(task).toThrow("listener boom");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("sending without a connection", () => {
  it("throws a NotConnectedError for voice, whispers and execNoWait", async () => {
    const client = clientOn(() => new FakeSocket());
    expect(() => client.sendVoice(new Uint8Array(4), Codec.OpusVoice)).toThrow(NotConnectedError);
    expect(() => client.sendWhisper(new Uint8Array(4), {}, Codec.OpusVoice)).toThrow(
      NotConnectedError,
    );
    await expect(client.execNoWait("clientupdate")).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("throws after a disconnect too", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    expect(() => client.sendVoice(new Uint8Array(4), Codec.OpusVoice)).toThrow(NotConnectedError);
    await expect(client.exec("whoami")).rejects.toBeInstanceOf(NotConnectedError);
  });

  // The socket is open while connecting, but before crypto init a command
  // would go out under the public dummy key, a channel password with it.
  it("refuses everything while the handshake is still running, and sends nothing", async () => {
    let socket: FakeSocket | undefined;
    const client = clientOn(() => (socket = new FakeSocket()));
    const connecting = client.connect();
    connecting.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    const before = socket!.sent.length;

    await expect(client.exec("clientmove clid=1 cid=2 cpw=SECRETHASH")).rejects.toBeInstanceOf(
      NotConnectedError,
    );
    await expect(client.send({ command: "whoami" })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(client.execNoWait("clientupdate")).rejects.toBeInstanceOf(NotConnectedError);
    expect(() => client.sendVoice(new Uint8Array(4), Codec.OpusVoice)).toThrow(NotConnectedError);
    expect(() =>
      client.sendWhisper(new Uint8Array(4), { clients: [asClientID(1)] }, Codec.OpusVoice),
    ).toThrow(NotConnectedError);
    expect(socket!.sent.length).toBe(before);
    await client.disconnect();
  });
});

describe("the command throttle", () => {
  it("removes its abort listener when the wait ends normally", async () => {
    const throttle = new CommandThrottle();
    const controller = new AbortController();
    for (let i = 0; i < 7; i++) await throttle.wait(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("is bounded by a command's timeout and signal", async () => {
    const { client } = await connected();
    // Spend the tokens, so the next command waits for its turn.
    for (let i = 0; i < 8; i++) await client.execNoWait("clientupdate");

    const started = Date.now();
    await expect(client.exec("whoami", { timeoutMs: 30 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(200);

    const reason = new Error("stop");
    await expect(
      client.execNoWait("clientupdate", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("events()", () => {
  it("stops listening and drops the buffer as soon as the signal aborts", async () => {
    const { client } = await connected();
    const controller = new AbortController();
    const iterator = client.events("poked", { signal: controller.signal });
    const poke = new TextEncoder().encode("notifyclientpoke invokerid=1 msg=x");
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, poke));
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, poke));
    await settle();

    const reason = new Error("stop");
    const pending = iterator.next();
    controller.abort(reason);
    // That call took the first buffered event; the abort discards the other.
    await expect(pending).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toBe(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("events() abort", () => {
  it("rejects the pending next() with the signal's reason, and removes the listener", async () => {
    const { client } = await connected();
    const controller = new AbortController();
    const iterator = client.events("poked", { signal: controller.signal });
    const first = iterator.next();
    const second = iterator.next();
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("voice delivery", () => {
  it("drops voice past 256 pending deliveries, and warns about it once", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (msg) => warnings.push(msg),
      error() {},
    };
    const { client } = await connected({ logger });
    let heard = 0;
    client.on("voiceData", () => heard++);

    const frame = Uint8Array.of(0, 1, 0, 9, Codec.OpusVoice, 1, 2, 3);
    for (let i = 0; i < 1000; i++)
      clientInternals(client).handler.onPacket?.(packet(PacketType.Voice, frame));
    await settle();

    expect(heard).toBeGreaterThan(0);
    expect(heard).toBeLessThanOrEqual(257);
    expect(warnings.filter((w) => w.startsWith("voice dropped"))).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("delivers a speaker's end of speech, a packet with no data, as an event with empty data", async () => {
    const { client } = await connected();
    const heard: number[] = [];
    client.on("voiceData", (e) => heard.push(e.data.length));

    const handler = clientInternals(client).handler;
    handler.onPacket?.(packet(PacketType.Voice, Uint8Array.of(0, 1, 0, 9, Codec.OpusVoice, 1, 2)));
    handler.onPacket?.(packet(PacketType.Voice, Uint8Array.of(0, 2, 0, 9, Codec.OpusVoice)));
    // Shorter than the header: not a voice packet.
    handler.onPacket?.(packet(PacketType.Voice, Uint8Array.of(0, 3, 0, 9)));
    await settle();

    expect(heard).toEqual([2, 0]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the drops since the last warning, not since the start", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const counts: unknown[] = [];
      const logger: Logger = {
        debug() {},
        info() {},
        warn: (msg, fields) => {
          if (msg.startsWith("voice dropped"))
            counts.push((fields as { dropped?: number } | undefined)?.dropped);
        },
        error() {},
      };
      const { client } = await connected({ logger });
      let heard = 0;
      client.on("voiceData", () => heard++);
      const frame = Uint8Array.of(0, 1, 0, 9, Codec.OpusVoice, 1, 2, 3);
      const burst = async (): Promise<void> => {
        for (let i = 0; i < 1000; i++)
          clientInternals(client).handler.onPacket?.(packet(PacketType.Voice, frame));
        await settle();
      };

      await burst();
      const firstDropped = 1000 - heard;
      vi.advanceTimersByTime(11_000);
      await burst();

      // The first report comes with the first drop; the second counts the rest
      // of that burst and the first drop of the next.
      expect(counts).toEqual([1, firstDropped]);
      await client.disconnect({ signal: AbortSignal.timeout(1) });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reconnecting", () => {
  it("ends the loop with an error log when shouldRetry throws", async () => {
    const errors: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (msg) => errors.push(msg),
    };
    const { client } = await connected({
      logger,
      reconnect: {
        shouldRetry: () => {
          throw new Error("buggy policy");
        },
      },
    });
    const leave = new TextEncoder().encode("notifyclientleftview clid=5 reasonid=11");
    clientInternals(client).handler.onPacket?.(packet(PacketType.Command, leave));
    await until(() => errors.length > 0);
    expect(errors[0]).toMatch(/shouldRetry/);
  });
});

describe("command middleware", () => {
  it("sees typed requests, can answer them itself, and never sees raw lines", async () => {
    const seen: string[] = [];
    const { client } = await connected({
      commandMiddleware: [
        (next) => async (request, options) => {
          seen.push(request.command);
          if (request.command === "whoami") return [{ client_id: "42" }];
          return next(request, options);
        },
      ],
    });
    const { whoAmI } = await import("@honeybbq/teamspeak");

    await expect(whoAmI(client)).resolves.toMatchObject({ clientID: 42 });
    await client.execNoWait("clientupdate");
    expect(seen).toEqual(["whoami"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the idle timeout", () => {
  /** Run a connected client's timers for `seconds`, with a datagram every ten. */
  async function idleFor(
    seconds: number,
    datagramFor: (client: Client, id: number) => Uint8Array,
  ): Promise<{ client: Client; dropped: Array<Error | undefined> }> {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
    try {
      const { client, socket } = await connected();
      const dropped: Array<Error | undefined> = [];
      client.on("disconnected", (e) => dropped.push(e.error));
      for (let second = 1; second <= seconds; second++) {
        if (second % 10 === 0) socket.deliver(datagramFor(client, second));
        vi.advanceTimersByTime(1_000);
      }
      await settle();
      return { client, dropped };
    } finally {
      vi.useRealTimers();
    }
  }

  // Anyone can send datagrams that do not decrypt; they must not keep a
  // session the server has left looking alive.
  it("is not reset by datagrams that do not decrypt", async () => {
    const { client, dropped } = await idleFor(70, (_, id) =>
      datagram(new Uint8Array(8).fill(1), s2cHeader(id, 2), new Uint8Array(16).fill(2)),
    );
    expect(client.status).toBe("disconnected");
    expect(dropped[0]).toBeInstanceOf(ConnectionTimeoutError);
  });

  it("is reset by every packet that does", async () => {
    const { client, dropped } = await idleFor(70, (c, id) =>
      plainPacket(clientInternals(c).crypt.fakeSignature, 4, 0, id, new Uint8Array(0)),
    );
    expect(client.status).toBe("connected");
    expect(dropped).toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("one session after another", () => {
  // The old session's `disconnected` used to be still queued when
  // disconnect() resolved, and reached whatever the new session had set up.
  it("delivers disconnected before disconnect() resolves", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.abort() });
    const late: unknown[] = [];
    client.on("disconnected", (error) => late.push(error));
    const next = client.connect();
    next.catch(() => {});
    await settle();
    await settle();

    expect(late).toEqual([]);
    expect(client.status).toBe("connecting");
    await client.disconnect();
  });

  it("does not end an events() iterator started for the new session", async () => {
    const { client } = await connected();
    await client.disconnect({ signal: AbortSignal.abort() });
    const iterator = client.events("textMessage");
    const next = client.connect();
    next.catch(() => {});

    const first = await Promise.race([
      iterator.next(),
      (async () => {
        for (let i = 0; i < 5; i++) await settle();
        return "still open";
      })(),
    ]);
    expect(first).toBe("still open");
    await client.disconnect();
  });

  it("makes a connect() after a drop wait until the drop has been heard", async () => {
    const { client } = await connected();
    const statusWhenHeard: string[] = [];
    client.on("disconnected", () => statusWhenHeard.push(client.status));
    clientInternals(client).handler.onClosed?.(new Error("gone"));
    const next = client.connect();
    next.catch(() => {});
    await until(() => client.status === "connecting");

    // Heard while the old session was over and the new one not yet begun.
    expect(statusWhenHeard).toEqual(["disconnected"]);
    await client.disconnect();
  });

  it("delivers connected after connect() resolves, to a listener added then", async () => {
    let socket: FakeSocket | undefined;
    const client = clientOn(() => (socket = new FakeSocket()));
    const connecting = client.connect();
    await until(() => socket !== undefined && clientInternals(client).handler.isOpen);
    completeCryptoInit(clientInternals(client).crypt);
    clientInternals(client).markConnected();
    await connecting;
    let heard = false;
    client.on("connected", () => (heard = true));
    await settle();

    expect(heard).toBe(true);
    await client.disconnect({ signal: AbortSignal.abort() });
  });
});

describe("the goodbye", () => {
  // A server that never acknowledges it holds disconnect() a second at most,
  // even for a caller whose own signal would allow longer.
  it("waits a second at most, however long the caller's signal allows", async () => {
    const { client } = await connected();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let done = false;
      const leaving = client
        .disconnect({ signal: new AbortController().signal })
        .then(() => (done = true));
      await vi.advanceTimersByTimeAsync(990);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await leaving;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits less when the caller's signal aborts sooner", async () => {
    const { client } = await connected();
    const started = Date.now();
    await client.disconnect({ signal: AbortSignal.timeout(20) });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("address resolution", () => {
  // A custom resolver used to be bounded by nothing but the caller's signal.
  it("holds a custom resolver to the 10 s budget, then connects as given", async () => {
    let seen: AbortSignal | undefined;
    const client = clientOn(() => new FakeSocket(), {
      resolver: {
        resolve: (_addr, options) => {
          seen = options?.signal;
          return new Promise(() => {});
        },
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let connecting: Promise<void>;
    try {
      connecting = client.connect();
      connecting.catch(() => {});
      await vi.advanceTimersByTimeAsync(9_990);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await until(() => clientInternals(client).handler.isOpen);
    expect(client.status).toBe("connecting");
    await client.disconnect();
    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
  });
});
