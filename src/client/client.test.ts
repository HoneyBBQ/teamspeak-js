import { clientInternals } from "./client.js";
import { afterEach, describe, it, expect } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import {
  Client,
  RemovedError,
  defaultShouldRetry,
  generateIdentitySync,
  type ClientOptions,
  type CommandTrace,
  commandChannel,
} from "./index.js";
import { PacketType, type Packet } from "./transport/packet.js";
import { FakeSocket, completeCryptoInit, dummyPacket } from "./testing/fake-server.js";
import {
  ClientStatus,
  type KickedEvent,
  type Logger,
  NotConnectedError,
  Reason,
  noopLogger,
} from "@honeybbq/teamspeak";

function commandPacket(text: string): Packet {
  return {
    typeFlagged: PacketType.Command,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: new TextEncoder().encode(text),
    receivedAt: performance.now(),
  };
}

/** A client already past the handshake, as initserver would have left it. */
function connectedClient(nickname: string, clid: number): Client {
  const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", nickname);
  clientInternals(client).clid = clid;
  clientInternals(client).handler.setClientID(clid);
  completeCryptoInit(clientInternals(client).crypt);
  return client;
}

describe("Client self identification on notifycliententerview", () => {
  it("does not adopt another client named <own nick><digits>", () => {
    // The server renames a client whose nickname is taken to "<nick><digits>",
    // so a lookalike is indistinguishable from us by nickname alone. Adopting
    // its clid would poison every outgoing packet header with a foreign id.
    const client = connectedClient("Bot", 5);

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot2"),
    );

    expect(clientInternals(client).clid).toBe(5);
  });

  it("tracks the server-applied rename on its own clientEnter", () => {
    const client = connectedClient("Bot", 5);

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=5 ctid=1 client_nickname=Bot2"),
    );

    expect(clientInternals(client).clid).toBe(5);
    expect(clientInternals(client).nickname).toBe("Bot2");
  });

  it("still learns its clid from the welcome enter when initserver carried no aclid", () => {
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot");
    completeCryptoInit(clientInternals(client).crypt);

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );

    expect(clientInternals(client).clid).toBe(7);
    expect(clientInternals(client).nickname).toBe("Bot");
  });

  it("adopts the first suffix match while the clid is still unknown, then locks it in", () => {
    // While initserver has given us no clid, a nickname match is the only
    // signal available, so the first one wins. The clid is then known, which
    // is what stops any later lookalike from taking over.
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot");
    completeCryptoInit(clientInternals(client).crypt);
    completeCryptoInit(clientInternals(client).crypt);

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot3"),
    );
    expect(clientInternals(client).clid).toBe(9);

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );
    expect(clientInternals(client).clid).toBe(9);
  });
});

describe("Client events for changes to clients", () => {
  /** Feed a packet, then let the queued events run. */
  async function feed(client: Client, ...lines: string[]): Promise<void> {
    for (const line of lines) clientInternals(client).handler.onPacket?.(commandPacket(line));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("takes the server's rename of this client from its own clientUpdated", async () => {
    const client = connectedClient("Bot", 5);

    await feed(client, "notifyclientupdated clid=5 client_nickname=Robot");
    expect(clientInternals(client).nickname).toBe("Robot");

    await feed(client, "notifyclientupdated clid=9 client_nickname=Other");
    expect(clientInternals(client).nickname).toBe("Robot");
  });

  it("delivers clientUpdated before the catch-all, and a following message with the new groups", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    client.on("clientUpdated", (e) =>
      seen.push(`updated:${e.changes.serverGroups!.map(String).join(",")}`),
    );
    client.on("clientServerGroupAdded", (e) => seen.push(`added:${String(e.groupID)}`));
    client.on("textMessage", (e) => seen.push(`text:${e.invokerGroups!.map(String).join(",")}`));
    client.on("notification", (e) => seen.push(e.name));

    await feed(
      client,
      "notifycliententerview clid=9 ctid=1 client_nickname=Bob client_servergroups=6",
      // The group event first, as one client sees it.
      "notifyservergroupclientadded sgid=8 clid=9 name=Bob cluid=u invokerid=2 invokername=Adm invokeruid=a",
      "notifyclientupdated clid=9 client_servergroups=6,8",
      "notifytextmessage targetmode=2 msg=hi invokerid=9 invokername=Bob",
    );

    expect(seen).toEqual([
      "notifycliententerview",
      "added:8",
      "notifyservergroupclientadded",
      "updated:6,8",
      "notifyclientupdated",
      "text:6,8",
      "notifytextmessage",
    ]);
  });
});

describe("Client events for channels, the server and plugins", () => {
  async function feed(client: Client, ...lines: string[]): Promise<void> {
    for (const line of lines) clientInternals(client).handler.onPacket?.(commandPacket(line));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("delivers each, through event middleware, and the catch-all after it", async () => {
    const names: string[] = [];
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot", {
      eventMiddleware: [
        (next) => (event) => {
          names.push(event.name);
          next(event);
        },
      ],
    });
    clientInternals(client).clid = 5;
    completeCryptoInit(clientInternals(client).crypt);
    const seen: string[] = [];
    for (const name of [
      "channelCreated",
      "channelEdited",
      "channelMoved",
      "channelDeleted",
      "channelDescriptionChanged",
      "channelPasswordChanged",
      "serverEdited",
      "channelSubscribed",
      "channelUnsubscribed",
      "pluginCommand",
      "clientChatComposing",
    ] as const) {
      client.on(name, () => seen.push(name));
    }

    await feed(
      client,
      "notifychannelcreated cid=9 cpid=0 channel_name=x invokerid=2 invokername=A invokeruid=a",
      "notifychanneledited cid=9 reasonid=10 invokerid=2 invokername=A invokeruid=a channel_topic=t",
      "notifychannelmoved cid=9 cpid=0 order=0 reasonid=1 invokerid=2 invokername=A invokeruid=a",
      "notifychanneldeleted invokerid=0 invokername=Server cid=9",
      "notifychanneldescriptionchanged cid=9",
      "notifychannelpasswordchanged cid=9",
      "notifyserveredited invokerid=2 invokername=A invokeruid=a virtualserver_name=n",
      "notifychannelsubscribed cid=9 es=1",
      "notifychannelunsubscribed cid=9",
      "notifyplugincmd name=p data=d invokerid=5 invokername=Bot invokeruid=u",
      "notifyclientchatcomposing clid=9 cluid=u",
    );

    expect(seen).toHaveLength(11);
    // Each typed event is followed by its notification, in the middleware too.
    expect(names.filter((n) => n !== "notification")).toEqual(seen);
    expect(names.filter((n) => n === "notification")).toHaveLength(11);
    expect(names.slice(0, 2)).toEqual(["channelCreated", "notification"]);
  });

  it("gives the answer to a description fetch to the catch-all only", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    client.on("channelEdited", (e) => seen.push(`edited:${String(e.channelID)}`));
    client.on("notification", (e) => seen.push(`${e.name}:${e.params["channel_description"]}`));

    await feed(
      client,
      "notifychanneledited cid=9 channel_description=text reasonid=9",
      "notifychanneledited cid=9 reasonid=10 invokerid=2 invokername=A invokeruid=a channel_topic=t",
    );

    expect(seen).toEqual(["notifychanneledited:text", "edited:9", "notifychanneledited:undefined"]);
  });
});

const silentSockets: Socket[] = [];
afterEach(() => {
  for (const socket of silentSockets.splice(0)) socket.close();
});

/**
 * A client pointed at a UDP socket that never answers, so its handshake never
 * completes. A port with nothing bound would refuse the datagrams instead.
 */
async function silentServerClient(options: ClientOptions = {}): Promise<Client> {
  const silent = createSocket("udp4");
  silentSockets.push(silent);
  await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", resolve));
  const addr = `127.0.0.1:${silent.address().port}`;
  return new Client(generateIdentitySync(0), "silent.example", "Bot", {
    resolver: { resolve: async () => [{ addr, source: "test", expiry: new Date() }] },
    ...options,
  });
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

/** Wait for every queued delivery to run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("connect()", () => {
  it("rejects with the server error instead of timing out", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);

    // A handshake the server rejects before the welcome sequence completes.
    clientInternals(client).handler.onPacket?.(
      commandPacket("error id=1028 msg=invalid\\sserver\\spassword"),
    );

    await expect(connecting).rejects.toThrow(/invalid server password/);
    expect(client.status).toBe(ClientStatus.Disconnected);
  });

  it("abandons the attempt when the signal aborts, and can try again", async () => {
    const client = await silentServerClient();
    const controller = new AbortController();
    const connecting = client.connect({ signal: controller.signal });
    await until(() => clientInternals(client).handler.isOpen);

    const reason = new Error("caller went away");
    controller.abort(reason);

    await expect(connecting).rejects.toBe(reason);
    expect(client.status).toBe(ClientStatus.Disconnected);

    const again = client.connect({ signal: AbortSignal.timeout(20) });
    await expect(again).rejects.not.toThrow(/already/);
  });

  it("rejects at once on a signal that has already aborted", async () => {
    const client = await silentServerClient();
    const reason = new Error("too late");

    await expect(client.connect({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(client.status).toBe(ClientStatus.Disconnected);
  });

  // Without a signal, a connect() that disconnect() interrupted used to wait
  // forever.
  it("rejects when disconnect() is called during the handshake", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);

    await client.disconnect();

    await expect(connecting).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("resolves once the handshake completes", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);

    clientInternals(client).markConnected();

    await expect(connecting).resolves.toBeUndefined();
    expect(client.status).toBe(ClientStatus.Connected);
    await client.disconnect();
  });
});

describe("events", () => {
  it("delivers events in the order they arrived", async () => {
    const client = connectedClient("Bot", 5);
    const seen: number[] = [];
    client.on("clientEnter", (info) => seen.push(info.id));

    for (let id = 10; id < 60; id++) {
      clientInternals(client).handler.onPacket?.(
        commandPacket(`notifycliententerview clid=${id} ctid=1 client_nickname=C${id}`),
      );
    }
    await settle();

    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 10));
  });

  it("stops delivering once unsubscribed, including events already queued", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    const unsubscribe = client.on("poked", (e) => seen.push(e.message));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=queued"),
    );
    unsubscribe();
    unsubscribe(); // a second call is harmless
    await settle();

    expect(seen).toEqual([]);
  });

  it("is a Disposable, so a listener can live for a scope", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    {
      using _listener = client.on("poked", (e) => seen.push(e.message));
    }
    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=after"),
    );
    await settle();

    expect(seen).toEqual([]);
  });

  it("once() hears only the next occurrence", async () => {
    const client = connectedClient("Bot", 5);
    const seen: string[] = [];
    client.once("poked", (e) => seen.push(e.message));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=first"),
    );
    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=second"),
    );
    await settle();

    expect(seen).toEqual(["first"]);
  });

  // The middleware used to guess which event it had by the payload's shape.
  it("names the event for middleware, which can drop it", async () => {
    const names: string[] = [];
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot", {
      eventMiddleware: [
        (next) => (event) => {
          names.push(event.name);
          if (event.name !== "poked") next(event);
        },
      ],
    });
    clientInternals(client).clid = 5;
    completeCryptoInit(clientInternals(client).crypt);
    const poked: string[] = [];
    client.on("poked", (e) => poked.push(e.message));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=dropped"),
    );
    clientInternals(client).handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=X"),
    );
    await settle();

    expect(names).toEqual(["poked", "notification", "clientEnter", "notification"]);
    expect(poked).toEqual([]);
  });
});

describe("being removed by the server", () => {
  async function connected(): Promise<Client> {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    completeCryptoInit(clientInternals(client).crypt);
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;
    return client;
  }

  it("reports a server kick and ends the session at once, with the cause", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    const disconnected: Array<Error | undefined> = [];
    client.on("kicked", (e) => kicked.push(e));
    client.on("disconnected", (e) => disconnected.push(e.error));

    clientInternals(client).handler.onPacket?.(
      commandPacket(
        "notifyclientleftview clid=5 reasonid=5 reasonmsg=behave invokerid=1 invokername=Admin",
      ),
    );
    await settle();

    expect(kicked).toEqual([
      expect.objectContaining({
        reason: Reason.KickServer,
        reasonMessage: "behave",
        invokerName: "Admin",
      }),
    ]);
    expect(disconnected[0]).toBeInstanceOf(RemovedError);
    expect(client.status).toBe(ClientStatus.Disconnected);
    expect(defaultShouldRetry(disconnected[0])).toBe(false);
  });

  it("retries a server that stopped, which is not a kick", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    const disconnected: Array<Error | undefined> = [];
    client.on("kicked", (e) => kicked.push(e));
    client.on("disconnected", (e) => disconnected.push(e.error));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientleftview clid=5 reasonid=11 reasonmsg=restart"),
    );
    await settle();

    expect(kicked).toEqual([]);
    expect(defaultShouldRetry(disconnected[0])).toBe(true);
  });

  // A channel kick arrives as a move, which is not where it used to be looked for.
  it("reports a channel kick, which leaves the session up", async () => {
    const client = await connected();
    const kicked: KickedEvent[] = [];
    client.on("kicked", (e) => kicked.push(e));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientmoved clid=5 ctid=1 reasonid=4 reasonmsg=out invokername=Admin"),
    );
    await settle();

    expect(kicked).toEqual([
      expect.objectContaining({ reason: Reason.KickChannel, reasonMessage: "out" }),
    ]);
    expect(client.status).toBe(ClientStatus.Connected);
    await client.disconnect();
  });

  it("hears a deliberate disconnect as undefined", async () => {
    const client = await connected();
    const disconnected: Array<Error | undefined> = [];
    client.on("disconnected", (e) => disconnected.push(e.error));

    await client.disconnect({ signal: AbortSignal.timeout(50) });
    await settle();

    expect(disconnected).toEqual([undefined]);
  });
});

describe("diagnostics channels", () => {
  it("traces a command by name, never with its parameters", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;

    const traced: Array<{ event: string; command: string }> = [];
    const handlers = {
      start: (m: CommandTrace) => traced.push({ event: "start", command: m.command }),
      asyncEnd: (m: CommandTrace) => traced.push({ event: "end", command: m.command }),
      error: (m: CommandTrace) => traced.push({ event: "error", command: m.command }),
    };
    commandChannel.subscribe(handlers);
    try {
      const answered = client.exec("clientmove clid=5 cid=1 cpw=secret", { timeoutMs: 1_000 });
      await new Promise((r) => setImmediate(r));
      clientInternals(client).handler.onPacket?.(commandPacket("error id=0 msg=ok return_code=1"));
      await answered;
    } finally {
      commandChannel.unsubscribe(handlers);
    }

    expect(traced).toEqual([
      { event: "start", command: "clientmove" },
      { event: "end", command: "clientmove" },
    ]);
    expect(JSON.stringify(traced)).not.toContain("secret");
    await client.disconnect({ signal: AbortSignal.timeout(50) });
  });
});

// After EchoSixHIYA/teamspeak-js (4b82c32, by illusia).
describe("notification", () => {
  it("delivers every notification as it arrived, after the event it produces", async () => {
    const client = connectedClient("Bot", 5);
    const order: string[] = [];
    client.on("poked", () => order.push("poked"));
    client.on("notification", (n) => order.push(`${n.name} ${n.params["msg"] ?? ""}`.trim()));

    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyclientpoke invokerid=1 msg=hi"),
    );
    clientInternals(client).handler.onPacket?.(
      commandPacket("notifyserveredited virtualserver_name=X"),
    );
    await settle();

    expect(order).toEqual(["poked", "notifyclientpoke hi", "notifyserveredited"]);
  });
});

describe("events()", () => {
  it("iterates events in order, buffering those that arrive mid-loop", async () => {
    const client = connectedClient("Bot", 5);
    const controller = new AbortController();
    const seen: string[] = [];

    const loop = (async () => {
      for await (const poke of client.events("poked", { signal: controller.signal })) {
        seen.push(poke.message);
        await settle();
        if (seen.length === 3) controller.abort();
      }
    })().catch((error: unknown) => {
      expect((error as Error).name).toBe("AbortError");
    });
    for (const msg of ["a", "b", "c", "d"]) {
      clientInternals(client).handler.onPacket?.(
        commandPacket(`notifyclientpoke invokerid=1 msg=${msg}`),
      );
    }
    await loop;

    expect(seen.slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("answers concurrent next() calls in order, none lost", async () => {
    const client = connectedClient("Bot", 5);
    const iterator = client.events("poked");
    const first = iterator.next();
    const second = iterator.next();
    const third = iterator.next();
    for (const msg of ["a", "b", "c"]) {
      clientInternals(client).handler.onPacket?.(
        commandPacket(`notifyclientpoke invokerid=1 msg=${msg}`),
      );
    }
    const values = (await Promise.all([first, second, third])).map(
      (r) => (r.value as { message: string }).message,
    );
    expect(values).toEqual(["a", "b", "c"]);
    await iterator.return?.();
  });

  it("ends every pending next() when the iterator is returned", async () => {
    const client = connectedClient("Bot", 5);
    const iterator = client.events("poked");
    const pending = [iterator.next(), iterator.next()];
    await iterator.return?.();
    await expect(Promise.all(pending)).resolves.toEqual([
      { value: undefined, done: true },
      { value: undefined, done: true },
    ]);
  });

  it("stops listening when the loop exits early", async () => {
    const client = connectedClient("Bot", 5);
    const loop = (async () => {
      for await (const _poke of client.events("poked")) break;
    })();
    clientInternals(client).handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=x"));
    await loop;

    // Nothing is left listening: a later event has nowhere to go.
    clientInternals(client).handler.onPacket?.(commandPacket("notifyclientpoke invokerid=1 msg=y"));
    await settle();
  });

  it("ends when the client disconnects", async () => {
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;

    const loop = (async () => {
      const seen: string[] = [];
      for await (const poke of client.events("poked")) seen.push(poke.message);
      return seen;
    })();
    await settle();
    await client.disconnect({ signal: AbortSignal.timeout(50) });

    await expect(loop).resolves.toEqual([]);
  });

  it("lets go of the signal when a disconnect ends it, though for-await never calls return()", async () => {
    const { getEventListeners } = await import("node:events");
    const client = await silentServerClient();
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    clientInternals(client).clid = 5;
    clientInternals(client).markConnected();
    await connecting;

    const controller = new AbortController();
    const loop = (async () => {
      for await (const _poke of client.events("poked", { signal: controller.signal })) {
        // nothing arrives
      }
    })();
    await settle();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(50) });
    await loop;

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("secrets", () => {
  it("are not in a client's inspect() or JSON form, even once connected", async () => {
    const { inspect } = await import("node:util");
    const { createHash } = await import("node:crypto");
    const client = await silentServerClient({
      serverPassword: "server-secret",
      defaultChannelPassword: "channel-secret",
    });
    const connecting = client.connect();
    await until(() => clientInternals(client).handler.isOpen);
    clientInternals(client).crypt.setSharedSecret(
      new Uint8Array(10).fill(7),
      new Uint8Array(54).fill(9),
      new Uint8Array(20).fill(3),
    );
    clientInternals(client).markConnected();
    await connecting;

    const hash = createHash("sha1").update("server-secret").digest("base64");
    const forms = [inspect(client, { depth: 10, showHidden: true }), JSON.stringify(client)];
    for (const form of forms) {
      for (const secret of ["server-secret", "channel-secret", hash, "ivStruct", "privateKey"]) {
        expect(form).not.toContain(secret);
      }
    }
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("before crypto init", () => {
  /** A client whose handshake has started, on a socket the test feeds. */
  async function connecting(logger?: Logger): Promise<{
    client: Client;
    socket: FakeSocket;
    attempt: Promise<void>;
  }> {
    let socket: FakeSocket | undefined;
    const client = new Client(generateIdentitySync(0), "127.0.0.1:9987", "Bot", {
      socketFactory: () => (socket = new FakeSocket()),
      ...(logger ? { logger } : {}),
    });
    const attempt = client.connect();
    attempt.catch(() => {});
    await until(() => clientInternals(client).handler.isOpen);
    return { client, socket: socket!, attempt };
  }
  const line = (text: string): Uint8Array => new TextEncoder().encode(text);

  // Under the public dummy key anyone on the path can make a packet.
  it("drops every notification, initserver and row: they could be forged", async () => {
    const { client, socket } = await connecting();
    const crypt = clientInternals(client).crypt;
    const heard: string[] = [];
    client.on("textMessage", (m) => heard.push(m.message));
    client.on("poked", (m) => heard.push(m.message));
    client.on("notification", (n) => heard.push(n.name));

    const forged = [
      "notifytextmessage targetmode=3 msg=forged invokerid=7 invokername=Admin invokeruid=x",
      "notifyclientpoke invokerid=7 invokername=Admin invokeruid=x msg=forged",
      "initserver aclid=9 virtualserver_name=Forged",
      "virtualserver_name=row",
    ];
    forged.forEach((text, id) => socket.deliver(dummyPacket(crypt, 2, 0x20, id, line(text))));
    await settle();

    expect(heard).toEqual([]);
    expect(client.status).toBe(ClientStatus.Connecting);
    expect(clientInternals(client).clid).toBe(0);
    await client.disconnect();
  });

  it("fails the attempt on an error, but never takes the ban path", async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...noopLogger, warn: (message) => warnings.push(message) };
    const { client, socket, attempt } = await connecting(logger);
    const crypt = clientInternals(client).crypt;

    socket.deliver(dummyPacket(crypt, 2, 0x20, 0, line("error id=3329 msg=banned")));

    await expect(attempt).rejects.toMatchObject({ code: 3329 });
    expect(client.status).toBe(ClientStatus.Disconnected);
    expect(warnings).not.toContain("banned by the server, closing the connection");
  });
});
