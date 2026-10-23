import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { FakeSocket, dummyPacket, sessionPacket } from "./testing/fake-server.js";
import {
  ts3Events,
  ts3SelfID,
  ts3Welcome,
  ts6Events,
  ts6SelfID,
  ts6Welcome,
} from "./testing/view-recordings.js";
import {
  NotConnectedError,
  asChannelID,
  asClientID,
  asServerGroupID,
  listServerGroups,
  type Logger,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
import { getServerVariables } from "./api/voice.js";
import {
  ts3Groups,
  ts3ServerInit,
  ts3ServerVariables,
  ts6Groups,
  ts6ServerInit,
  ts6ServerVariables,
} from "./testing/group-recordings.js";
import type { ClientOptions } from "./types.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const line = (text: string): Uint8Array => new TextEncoder().encode(text);
const cid = (n: number): ReturnType<typeof asChannelID> => asChannelID(BigInt(n));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(condition()).toBe(true);
}

/** A client over fake sockets, one per connection attempt. */
function makeClient(options: ClientOptions = {}): { client: Client; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const client = new Client(identity, "127.0.0.1:9987", "watcher", {
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { client, sockets };
}

const packetIds = new WeakMap<FakeSocket, number>();
function nextId(socket: FakeSocket): number {
  const id = packetIds.get(socket) ?? 0;
  packetIds.set(socket, id + 1);
  return id;
}

/** Deliver lines under the session key, one packet each, as the server sends them. */
function send(client: Client, socket: FakeSocket, ...lines: string[]): void {
  const crypt = clientInternals(client).crypt;
  for (const text of lines) {
    if (text.length > 3_000) {
      // A datagram holds 4 KiB; the server fragments a longer command and the
      // client hands it on whole, which is what arrives here.
      clientInternals(client).handlePacket({
        typeFlagged: 0x02,
        id: 0,
        clientID: 0,
        generationID: 0,
        data: line(text),
        receivedAt: performance.now(),
      });
      continue;
    }
    socket.deliver(sessionPacket(crypt, 2, 0x20, nextId(socket), line(text)));
  }
}

/** Open the connection and deliver the server's key exchange; the welcome is for the caller. */
async function open(
  client: Client,
  sockets: FakeSocket[],
  index = 0,
): Promise<{ connecting: Promise<void> }> {
  const connecting = client.connect();
  connecting.catch(() => {});
  await until(() => sockets[index] !== undefined && clientInternals(client).handler.isOpen);
  const socket = sockets[index]!;
  const text = `clientinitiv alpha=${randomBytes(10).toString("base64")} beta=${randomBytes(54).toString("base64")} omega=${identity.publicKey()}`;
  socket.deliver(dummyPacket(clientInternals(client).crypt, 2, 0x20, nextId(socket), line(text)));
  return { connecting };
}

const recordings = {
  ts3: { welcome: ts3Welcome, events: ts3Events, self: ts3SelfID },
  ts6: { welcome: ts6Welcome, events: ts6Events, self: ts6SelfID },
};

const ids = (list: ReadonlyArray<{ readonly id: bigint }>): number[] =>
  list.map((c) => Number(c.id));

afterEach(() => {
  vi.useRealTimers();
});

describe.each(["ts3", "ts6"] as const)("the view from a %s welcome", (family) => {
  const { welcome, events, self } = recordings[family];
  const finished = welcome.indexOf("channellistfinished");

  /** A live client, after the whole recorded welcome. */
  async function live(): Promise<{ client: Client; socket: FakeSocket; sockets: FakeSocket[] }> {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...welcome);
    await connecting;
    await client.view.whenReady();
    await settle();
    return { client, socket: sockets[0]!, sockets };
  }

  it("is empty before connecting and loading until the welcome is done", async () => {
    const { client, sockets } = makeClient();
    expect(client.view.status).toBe("empty");
    expect(client.view.channels.size).toBe(0);
    expect(client.view.self).toBeUndefined();
    expect(client.view.children()).toEqual([]);
    expect(client.view.serverName).toBe("");
    expect(client.view.serverIconID).toBeUndefined();
    expect(client.view.serverBannerImageURL).toBeUndefined();

    const { connecting } = await open(client, sockets);
    expect(client.view.status).toBe("loading");
    send(client, sockets[0]!, ...welcome.slice(0, finished));
    await connecting;
    // Rows that arrived are not a tree until the last one has.
    expect(client.view.status).toBe("loading");
    expect(client.view.channels.size).toBe(0);
    send(client, sockets[0]!, "channellistfinished");
    await client.view.whenReady();
    expect(client.view.status).toBe("live");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("builds the tree from rows that come ancestors first, and is live at channellistfinished", async () => {
    const made = makeClient();
    const { connecting } = await open(made.client, made.sockets);
    const seen: string[] = [];
    made.client.on("connected", () => seen.push("connected"));
    made.client.on("viewReady", (event) => seen.push(`viewReady ${event.revision}`));
    // Only up to the terminator: no group lists, no permissions, no timer.
    send(made.client, made.sockets[0]!, ...welcome.slice(0, finished + 1));
    await connecting;
    await settle();

    const view = made.client.view;
    expect(view.status).toBe("live");
    // The own channel's ancestors came first, then the clients, then the rest.
    expect([...view.channels.keys()].map(Number)).toEqual([1, 2, 5, 6, 7, 3, 4]);
    expect(ids([...view.channels.values()])).toEqual([1, 2, 5, 6, 7, 3, 4]);
    expect(ids(view.children())).toEqual([1, 2, 3, 4]);
    expect(ids(view.children(cid(2)))).toEqual([5, 6, 7]);
    expect(ids(view.children(cid(5)))).toEqual([]);
    expect(ids(view.path(cid(6)))).toEqual([2, 6]);
    expect(view.path(cid(99))).toEqual([]);
    expect(view.channel(cid(6))).toMatchObject({ name: "Alpha-2", parentID: 2n, order: 5n });
    expect(view.channel(cid(1))).toMatchObject({ order: 0n, isDefault: true });
    for (const channel of view.channels.values()) {
      expect(channel.totalClients).toBeUndefined();
      expect(channel.totalFamilyClients).toBeUndefined();
    }
    expect(view.self?.id).toBe(self);
    expect(view.self?.nickname).toBe("watcher");
    expect(view.clientsIn(cid(2)).map((c) => c.id)).toContain(self);
    expect(view.clientsIn(cid(2))).toHaveLength(2);
    expect(view.clientsIn(cid(1))).toEqual([]);
    expect(view.client(asClientID(self))).toBe(view.self);
    expect(view.clients.size).toBe(2);

    expect(seen).toEqual(["connected", `viewReady ${view.revision}`]);
    await made.client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("keeps the rows after it out of the view and reports ready once", async () => {
    const { client, socket } = await live();
    const ready: number[] = [];
    client.on("viewReady", (event) => ready.push(event.revision));
    const revision = client.view.revision;
    send(client, socket, ...welcome.slice(finished + 1));
    await settle();
    expect(client.view.revision).toBeGreaterThanOrEqual(revision);
    expect(ready).toEqual([]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("follows the recorded series of changes, order included", async () => {
    const { client, socket } = await live();
    const view = client.view;
    const preorder = [
      [1, 2, 5, 6, 7, 3, 4, 8],
      [1, 9, 2, 5, 6, 7, 3, 4, 8],
      [10, 1, 9, 2, 5, 6, 7, 3, 4, 8],
      [10, 1, 9, 2, 5, 6, 7, 3, 4, 11, 8],
      [10, 1, 9, 2, 6, 7, 3, 5, 4, 11, 8],
      [10, 1, 8, 9, 2, 6, 7, 3, 5, 4, 11],
      [10, 1, 8, 2, 6, 7, 3, 5, 4, 11],
      [10, 1, 8, 2, 6, 7, 3, 5, 4],
      [10, 1, 8, 2, 6, 7, 3, 5],
      [10, 1, 8, 2, 6, 7, 3, 5],
      [10, 1, 8, 2, 6, 7, 3, 5],
    ];
    // Nine events change the tree, one after another; the three deletes of
    // steps 6 to 8 arrive as they were sent.
    expect(events).toHaveLength(preorder.length);
    const revisions: number[] = [];
    for (const [step, event] of events.entries()) {
      const before = view.revision;
      send(client, socket, event);
      await settle();
      expect(ids([...view.channels.values()]), `step ${step}`).toEqual(preorder[step]);
      expect(view.revision).toBeGreaterThan(before);
      revisions.push(view.revision);
      if (step === 1) {
        // Channel 2 was recorded after 1; the server now holds it after 9.
        // The view says what the server would send on the next connect.
        expect(view.channel(cid(2))?.order).toBe(9n);
      }
    }
    expect(new Set(revisions).size).toBe(revisions.length);
    const orders = Object.fromEntries(
      [...view.channels.values()].map((c) => [c.id, [c.parentID, c.order]]),
    );
    expect(orders).toEqual({
      10: [0n, 0n],
      1: [0n, 10n],
      8: [0n, 1n],
      2: [8n, 0n],
      6: [2n, 0n],
      7: [2n, 6n],
      3: [0n, 8n],
      5: [0n, 3n],
    });
    expect(view.channel(cid(6))?.name).toBe("Renamed");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("updates the view before the typed event is delivered", async () => {
    const { client, socket } = await live();
    const seen: number[][] = [];
    client.on("channelCreated", () => seen.push(ids([...client.view.channels.values()])));
    // Two notifications in one tick: the first listener already sees both.
    send(client, socket, events[0]!, events[1]!);
    await settle();
    expect(seen).toEqual([
      [1, 9, 2, 5, 6, 7, 3, 4, 8],
      [1, 9, 2, 5, 6, 7, 3, 4, 8],
    ]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the clients in the view", () => {
  const enter = (clid: number, channel: number, extra = ""): string =>
    `notifycliententerview cfid=0 ctid=${channel} reasonid=0 clid=${clid} client_unique_identifier=uid${clid} client_nickname=n${clid} client_servergroups=8 ${extra}`;

  async function live(): Promise<{ client: Client; socket: FakeSocket }> {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    await settle();
    return { client, socket: sockets[0]! };
  }

  it("drops a channel's clients when it is unsubscribed, in the roster and the view", async () => {
    const { client, socket } = await live();
    send(client, socket, enter(30, 3), enter(31, 3), enter(32, 4));
    await settle();
    const roster = clientInternals(client).clients;
    expect(client.view.clientsIn(cid(3)).map((c) => c.id)).toEqual([30, 31]);

    const order: string[] = [];
    client.on("channelUnsubscribed", () => {
      order.push(`unsubscribed ${client.view.clients.size}`);
    });
    const before = client.view.revision;
    send(client, socket, "notifychannelunsubscribed cid=3");
    await settle();

    expect(client.view.clientsIn(cid(3))).toEqual([]);
    expect(client.view.client(asClientID(30))).toBeUndefined();
    expect(roster.has(30)).toBe(false);
    expect(roster.has(31)).toBe(false);
    // The others stay: another channel's client, and this client itself.
    expect(client.view.client(asClientID(32))?.channelID).toBe(4n);
    expect(client.view.self).toBeDefined();
    expect(client.channelID).toBe(2n);
    expect(order).toEqual(["unsubscribed 3"]);
    expect(client.view.revision).toBeGreaterThan(before);

    // A new enter after a re-subscribe puts them back, in their new channel.
    send(client, socket, enter(30, 4), "notifychannelsubscribed cid=4");
    await settle();
    expect(client.view.client(asClientID(30))?.channelID).toBe(4n);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("does not drop the own client when its own channel is unsubscribed", async () => {
    const { client, socket } = await live();
    send(client, socket, "notifychannelunsubscribed cid=2");
    await settle();
    expect(client.view.self?.id).toBe(ts3SelfID);
    expect(client.view.clientsIn(cid(2)).map((c) => c.id)).toEqual([ts3SelfID]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("is the roster: invokerGroups and view.client agree after a group change", async () => {
    const { client, socket } = await live();
    const messages: Array<readonly ServerGroupID[] | undefined> = [];
    client.on("textMessage", (message) => messages.push(message.invokerGroups));
    const text =
      "notifytextmessage targetmode=2 msg=hi invokerid=30 invokername=n30 invokeruid=uid30";
    send(client, socket, enter(30, 2), text);
    await settle();
    expect(messages.at(-1)).toEqual(client.view.client(asClientID(30))?.serverGroups);

    // Both arrival orders of the group event and the update that carries the list.
    send(
      client,
      socket,
      "notifyservergroupclientadded sgid=6 clid=30 name=n30 cluid=uid30",
      "notifyclientupdated clid=30 client_servergroups=6,8",
      text,
    );
    await settle();
    expect(client.view.client(asClientID(30))?.serverGroups).toEqual([6n, 8n]);
    expect(messages.at(-1)).toEqual([6n, 8n]);
    send(
      client,
      socket,
      "notifyclientupdated clid=30 client_servergroups=8",
      "notifyservergroupclientdeleted sgid=6 clid=30 name=n30 cluid=uid30",
      text,
    );
    await settle();
    expect(messages.at(-1)).toEqual([8n]);
    expect(client.view.client(asClientID(30))?.serverGroups).toEqual([8n]);
    expect(client.view.clients).toBe(client.view.clients);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("hands out a clients map that a later change does not touch", async () => {
    const { client, socket } = await live();
    const view = client.view;
    send(client, socket, enter(30, 3));
    await settle();
    const before = view.clients;
    expect(view.clients).toBe(before);
    const known = [...before.keys()];
    const record = before.get(asClientID(30));

    send(client, socket, enter(31, 3), "notifyclientupdated clid=30 client_nickname=renamed");
    await settle();

    expect([...before.keys()]).toEqual(known);
    expect(before.get(asClientID(30))).toBe(record);
    expect(before.has(asClientID(31))).toBe(false);
    const after = view.clients;
    expect(after).not.toBe(before);
    expect(after.has(asClientID(31))).toBe(true);
    expect(after.get(asClientID(30))?.nickname).toBe("renamed");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("follows enter, move, update and leave, and counts each as a revision", async () => {
    const { client, socket } = await live();
    const view = client.view;
    const steps: string[] = [
      enter(30, 3),
      "notifyclientmoved clid=30 ctid=1 reasonid=0",
      "notifyclientupdated clid=30 client_nickname=renamed",
      "notifyclientleftview clid=30 ctid=0 reasonid=8",
    ];
    let revision = view.revision;
    for (const step of steps) {
      send(client, socket, step);
      await settle();
      expect(view.revision).toBeGreaterThan(revision);
      revision = view.revision;
    }
    expect(view.client(asClientID(30))).toBeUndefined();
    // An update for a client nobody announced changes nothing.
    send(client, socket, "notifyclientupdated clid=77 client_nickname=ghost");
    await settle();
    expect(view.revision).toBe(revision);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the view across connections", () => {
  it("is stale after a disconnect, readable, and cleared by the next connect", async () => {
    const { client, sockets } = makeClient();
    const ready: number[] = [];
    client.on("viewReady", (event) => ready.push(event.revision));
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    const channels = client.view.channels;
    const revision = client.view.revision;

    await client.disconnect({ signal: AbortSignal.timeout(1) });
    expect(client.view.status).toBe("stale");
    expect(client.view.channels).toBe(channels);
    expect(client.view.channels.size).toBe(7);
    expect(client.view.self?.id).toBe(ts3SelfID);
    expect(client.view.revision).toBeGreaterThan(revision);
    await expect(client.view.whenReady()).rejects.toBeInstanceOf(NotConnectedError);

    const { connecting: second } = await open(client, sockets, 1);
    expect(client.view.status).toBe("loading");
    expect(client.view.channels.size).toBe(0);
    expect(client.view.clients.size).toBe(0);
    expect(client.view.self).toBeUndefined();
    // The old map is what it was.
    expect(channels.size).toBe(7);
    send(client, sockets[1]!, ...ts6Welcome);
    await second;
    await client.view.whenReady();
    expect(client.view.status).toBe("live");
    expect(client.view.self?.id).toBe(ts6SelfID);
    await settle();
    expect(ready).toHaveLength(2);
    expect(ready[1]).toBeGreaterThan(ready[0]!);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("goes stale when the server removes the client, and rejects a pending whenReady", async () => {
    const { client, sockets } = makeClient();
    client.on("disconnected", () => {});
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome.slice(0, 3));
    await connecting;
    const pending = client.view.whenReady();
    const rejected = expect(pending).rejects.toThrow();
    send(
      client,
      sockets[0]!,
      `notifyclientleftview clid=${ts3SelfID} ctid=0 reasonid=5 reasonmsg=bye`,
    );
    await rejected;
    expect(client.view.status).toBe("stale");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("rejects a pending whenReady when disconnect() ends the connection", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome.slice(0, 2));
    await connecting;
    const pending = client.view.whenReady();
    const rejected = expect(pending).rejects.toBeInstanceOf(NotConnectedError);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    await rejected;
  });

  it("rejects whenReady with the signal's reason, and waits while empty", async () => {
    const { client } = makeClient();
    const controller = new AbortController();
    const waiting = client.view.whenReady({ signal: controller.signal });
    const rejected = expect(waiting).rejects.toBe("stop");
    controller.abort("stop");
    await rejected;
    await expect(client.view.whenReady({ signal: controller.signal })).rejects.toBe("stop");
    expect(client.view.status).toBe("empty");
  });

  it("goes stale when an attempt fails", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, "error id=2568 msg=insufficient\\sclient\\spermissions");
    await expect(connecting).rejects.toThrow();
    expect(client.view.status).toBe("stale");
    await expect(client.view.whenReady()).rejects.toThrow();
  });

  it("ignores a channellistfinished that comes before the connection is up", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, "channellistfinished");
    await settle();
    expect(client.view.status).toBe("loading");
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("what the view hands out", () => {
  it("never changes after it was read", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    const view = client.view;

    const channels = view.channels;
    const keys = [...channels.keys()];
    const top = view.children();
    const topIds = ids(top);
    const alpha = view.channel(cid(2))!;
    const alphaCopy = { ...alpha };
    const path = view.path(cid(6));
    const inAlpha = view.clientsIn(cid(2));
    const clientIds = inAlpha.map((c) => c.id);
    const me = view.self!;
    const meCopy = { ...me };

    send(
      client,
      sockets[0]!,
      ...ts3Events.slice(0, 5),
      `notifycliententerview clid=40 ctid=2 client_unique_identifier=u40 client_nickname=x`,
      `notifyclientupdated clid=${ts3SelfID} client_nickname=changed`,
      `notifychanneldeleted cid=3 invokerid=1`,
    );
    await settle();

    expect([...channels.keys()]).toEqual(keys);
    expect(ids(top)).toEqual(topIds);
    expect(view.channel(cid(2))).not.toBe(alpha);
    expect(alpha).toEqual(alphaCopy);
    expect(ids(path)).toEqual([2, 6]);
    expect(inAlpha.map((c) => c.id)).toEqual(clientIds);
    expect(me).toEqual(meCopy);
    expect(view.self?.nickname).toBe("changed");
    expect(view.channels).not.toBe(channels);
    expect(view.channels).toBe(view.channels);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("logs a channel event it cannot place, once, and keeps the channel", async () => {
    const debug: string[] = [];
    const logger: Logger = {
      debug: (message) => debug.push(message),
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const { client, sockets } = makeClient({ logger });
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    send(client, sockets[0]!, "notifychannelmoved cid=5 cpid=4 order=99 reasonid=1");
    await settle();
    expect(client.view.channel(cid(5))).toMatchObject({ parentID: 4n });
    expect(client.view.children(cid(4)).map((c) => c.id)).toEqual([5n]);
    expect(debug.filter((m) => m.includes("could not be placed"))).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

describe("the view under random notifications", () => {
  const names = [
    "notifychannelcreated",
    "notifychanneledited",
    "notifychannelmoved",
    "notifychanneldeleted",
    "notifychannelunsubscribed",
    "notifychannelsubscribed",
    "notifycliententerview",
    "notifyclientleftview",
    "notifyclientmoved",
    "notifyclientupdated",
    "notifychanneldescriptionchanged",
  ];
  const keys = [
    "cid",
    "cpid",
    "pid",
    "ctid",
    "clid",
    "order",
    "channel_order",
    "reasonid",
    "client_nickname",
    "channel_name",
    "invokerid",
  ];
  const small = fc.oneof(
    fc.integer({ min: 0, max: 14 }).map(String),
    fc.constantFrom("", "x", "-1", "99999999999999999999"),
  );
  const notification = fc.tuple(
    fc.constantFrom(...names),
    fc.array(fc.tuple(fc.constantFrom(...keys), small), { maxLength: 6 }),
  );

  it("never throws and never leaves a channel without its parent", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    const view = client.view;
    const runs: Array<Array<[string, Array<[string, string]>]>> = fc.sample(
      fc.array(notification, { minLength: 1, maxLength: 30 }),
      { numRuns: 60, seed: 11 },
    );
    for (const run of runs) {
      for (const [name, params] of run) {
        const text = [name, ...params.map(([k, v]) => `${k}=${v}`)].join(" ");
        expect(() => send(client, sockets[0]!, text)).not.toThrow();
      }
      await settle();
      const channels = view.channels;
      expect(view.status).toBe("live");
      for (const [channelID, channel] of channels) {
        expect(channel.id).toBe(channelID);
        expect(channel.parentID === 0n || channels.has(channel.parentID)).toBe(true);
        // Parents come before their children.
        const keysList = [...channels.keys()];
        if (channel.parentID !== 0n) {
          expect(keysList.indexOf(channel.parentID)).toBeLessThan(keysList.indexOf(channelID));
        }
      }
      for (const entry of view.clients.values()) expect(view.client(entry.id)).toBe(entry);
    }
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});

const groupRecordings = {
  ts3: {
    welcome: ts3Welcome,
    self: ts3SelfID,
    groups: ts3Groups,
    init: ts3ServerInit,
    vars: ts3ServerVariables,
  },
  ts6: {
    welcome: ts6Welcome,
    self: ts6SelfID,
    groups: ts6Groups,
    init: ts6ServerInit,
    vars: ts6ServerVariables,
  },
};

/** Properties as a command line holds them. */
const encoded = (properties: Readonly<Record<string, string>>): string =>
  Object.entries(properties)
    .map(([key, value]) => `${key}=${value.replaceAll(" ", "\\s").replaceAll("/", "\\/")}`)
    .join(" ");

/** The ids and names a recorded list line holds. */
function listed(text: string): Array<[bigint, string]> {
  return text
    .split("|")
    .map((row) => [BigInt(/(?:sgid|cgid)=(\d+)/.exec(row)![1]!), /name=(\S+)/.exec(row)![1]!]);
}

/** The first `n` rows of a list line, as the server would have sent a shorter list. */
const firstRows = (text: string, n: number): string => {
  const [name, ...rest] = text.split(" ");
  const rows = [name, ...rest].join(" ").split("|");
  return rows.slice(0, n).join("|");
};

const shown = (map: ReadonlyMap<bigint, { readonly name: string }>): Array<[bigint, string]> =>
  [...map].map(([id, group]) => [id, group.name.replaceAll(" ", "\\s")]);

describe.each(["ts3", "ts6"] as const)("the groups and server of a %s view", (family) => {
  const { welcome, groups, init, vars } = groupRecordings[family];
  const finished = welcome.indexOf("channellistfinished");

  /** A client that has had the welcome up to `channellistfinished`, with the recorded properties. */
  async function started(): Promise<{
    client: Client;
    socket: FakeSocket;
    viewChanged: number[];
    seen: string[];
  }> {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    const entries = encoded(init);
    const viewChanged: number[] = [];
    const seen: string[] = [];
    client.on("viewChanged", (event) => viewChanged.push(event.revision));
    client.on("viewReady", () => seen.push("viewReady"));
    client.on("viewChanged", () => seen.push("viewChanged"));
    send(
      client,
      sockets[0]!,
      `initserver ${entries} aclid=${groupRecordings[family].self} acn=watcher client_server_password=secret client_key_offset=3`,
      ...welcome.slice(1, finished + 1),
    );
    await connecting;
    await settle();
    return { client, socket: sockets[0]!, viewChanged, seen };
  }

  it("is ready before the groups, which a viewChanged then reports", async () => {
    const { client, socket, viewChanged, seen } = await started();
    const view = client.view;
    expect(view.status).toBe("live");
    expect(view.groupsLoaded).toBe(false);
    expect(view.serverGroups.size).toBe(0);
    expect(view.channelGroups.size).toBe(0);
    expect(seen[0]).toBe("viewReady");
    const ready = view.revision;

    send(client, socket, groups.channelGroups8);
    await settle();
    expect(view.groupsLoaded).toBe(false);
    send(client, socket, groups.serverGroups8);
    await settle();
    expect(view.groupsLoaded).toBe(true);
    expect(shown(view.channelGroups)).toEqual(listed(groups.channelGroups8));
    expect(shown(view.serverGroups)).toEqual(listed(groups.serverGroups8));
    expect(view.serverGroups.get(asServerGroupID(8n))).toMatchObject({ name: "Guest", type: 1 });
    expect(view.revision).toBeGreaterThan(ready);
    expect(viewChanged).toHaveLength(2);
    expect(viewChanged.at(-1)).toBe(view.revision);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("reports the groups once when the lists share a turn with the typed events", async () => {
    const { client, socket, viewChanged, seen } = await started();
    seen.length = 0;
    const events: string[] = [];
    client.on("clientEnter", () => events.push("clientEnter"));
    client.on("viewChanged", () => events.push("viewChanged"));
    send(
      client,
      socket,
      groups.channelGroups8,
      welcome
        .find((l) => l.startsWith("notifycliententerview"))!
        .replace("clid=18", "clid=40")
        .replace("clid=2 ", "clid=40 "),
      groups.serverGroups8,
    );
    await settle();
    expect(viewChanged).toHaveLength(1);
    expect(viewChanged[0]).toBe(client.view.revision);
    expect(events.at(-1)).toBe("viewChanged");
    expect(events.filter((e) => e === "viewChanged")).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("leaves the revision and the maps alone for an identical list", async () => {
    const { client, socket, viewChanged } = await started();
    send(client, socket, groups.channelGroups8, groups.serverGroups8);
    await settle();
    const view = client.view;
    const before = {
      revision: view.revision,
      server: view.serverGroups,
      channel: view.channelGroups,
    };
    const count = viewChanged.length;
    send(client, socket, groups.serverGroups8, groups.channelGroups8);
    await settle();
    expect(view.revision).toBe(before.revision);
    expect(view.serverGroups).toBe(before.server);
    expect(view.channelGroups).toBe(before.channel);
    expect(viewChanged).toHaveLength(count);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("replaces the set with each list: 62 in a row, then rename, copy and delete", async () => {
    const { client, socket } = await started();
    const view = client.view;
    send(client, socket, groups.channelGroups8, groups.serverGroups8);
    await settle();
    const big = listed(groups.serverGroupsBig);
    expect(big.length).toBeGreaterThan(62);
    const kept: Array<ReadonlyMap<ServerGroupID, unknown>> = [];
    for (let n = 9; n <= 70 && n <= big.length; n++) {
      const before = view.revision;
      send(client, socket, firstRows(groups.serverGroupsBig, n));
      await settle();
      expect(view.serverGroups.size).toBe(n);
      expect(view.revision).toBe(before + 1);
      expect([...view.serverGroups.keys()]).toEqual(big.slice(0, n).map(([id]) => id));
      kept.push(view.serverGroups);
    }
    // A map read earlier is as it was.
    expect(kept[0]!.size).toBe(9);

    send(client, socket, groups.channelGroupsBig, groups.serverGroupsBig);
    await settle();
    expect(shown(view.serverGroups)).toEqual(big);
    expect(shown(view.channelGroups)).toEqual(listed(groups.channelGroupsBig));
    for (const recorded of [
      groups.serverGroupsRenamed,
      groups.serverGroupsCopied,
      groups.serverGroupsDeleted,
    ]) {
      const before = view.revision;
      send(client, socket, recorded);
      await settle();
      expect(shown(view.serverGroups)).toEqual(listed(recorded));
      expect(view.revision).toBe(before + 1);
    }
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("takes a one-row list as a one-group set, skips a row without an id and keeps the last of a repeated id", async () => {
    const { client, socket } = await started();
    const view = client.view;
    send(client, socket, groups.channelGroups8, groups.serverGroups8);
    await settle();
    const row = (id: string, name: string): string =>
      `sgid=${id} name=${name} type=1 iconid=0 savedb=0 sortid=0 namemode=0 n_modifyp=75 n_member_addp=0 n_member_removep=0`;
    send(client, socket, `notifyservergrouplist ${row("3", "Only")}`);
    await settle();
    expect([...view.serverGroups.keys()]).toEqual([3n]);
    send(
      client,
      socket,
      `notifyservergrouplist ${row("4", "A")}|name=NoId type=1|${row("4", "B")}|${row("2", "C")}`,
    );
    await settle();
    expect(shown(view.serverGroups)).toEqual([
      [4n, "B"],
      [2n, "C"],
    ]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("answers a caller's listServerGroups as well as taking the list", async () => {
    const { client, socket } = await started();
    send(client, socket, groups.channelGroups8, groups.serverGroups8);
    await settle();
    const sent = socket.sent.length;
    const asked = listServerGroups(client, { timeoutMs: 2_000 });
    await until(() => socket.sent.length > sent);
    send(client, socket, groups.serverGroupsBig);
    for (let rc = 1; rc < 40; rc++) send(client, socket, `error id=0 msg=ok return_code=${rc}`);
    const answer = await asked;
    expect(answer.map((g) => g.id)).toEqual(listed(groups.serverGroupsBig).map(([id]) => id));
    expect(shown(client.view.serverGroups)).toEqual(listed(groups.serverGroupsBig));
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("returns the whole answer of getServerVariables and merges it into the view", async () => {
    const { client, socket } = await started();
    const sent = socket.sent.length;
    const asked = getServerVariables(client, { timeoutMs: 2_000 });
    await until(() => socket.sent.length > sent);
    const row = encoded(vars);
    send(client, socket, `notifyserverupdated ${row}`);
    for (let rc = 1; rc < 40; rc++) send(client, socket, `error id=0 msg=ok return_code=${rc}`);
    const answer = await asked;
    expect(answer).toEqual(vars);
    expect(answer).toHaveProperty("virtualserver_uptime");
    expect(client.view.server).not.toHaveProperty("virtualserver_uptime");
    expect(client.view.server["virtualserver_maxclients"]).toBe(vars["virtualserver_maxclients"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("keeps the lists when stale, ignores them then, and clears them on the next connect", async () => {
    const { client, socket, viewChanged } = await started();
    send(client, socket, groups.channelGroups8, groups.serverGroups8);
    await settle();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    expect(client.view.status).toBe("stale");
    await settle();
    expect(viewChanged.at(-1)).toBe(client.view.revision);
    expect(client.view.groupsLoaded).toBe(true);
    expect(client.view.serverGroups.size).toBe(8);
    expect(client.view.server["virtualserver_name"]).toBe(init["virtualserver_name"]);
    const stale = client.view.revision;
    send(client, socket, groups.serverGroupsBig);
    expect(client.view.serverGroups.size).toBe(8);
    expect(client.view.revision).toBe(stale);

    const second = client.connect();
    second.catch(() => {});
    await settle();
    expect(client.view.status).toBe("loading");
    expect(client.view.groupsLoaded).toBe(false);
    expect(client.view.serverGroups.size).toBe(0);
    expect(client.view.channelGroups.size).toBe(0);
    expect(client.view.server).toEqual({});
    await client.disconnect({ signal: AbortSignal.timeout(1) }).catch(() => {});
  });

  it("seeds the server from initserver with its virtualserver_ keys only", async () => {
    const { client } = await started();
    expect(client.view.server).toEqual(init);
    expect(Object.keys(client.view.server).every((key) => key.startsWith("virtualserver_"))).toBe(
      true,
    );
    expect(JSON.stringify(client.view.server)).not.toContain("secret");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("patches the server from serverEdited, and not for an empty edit", async () => {
    const { client, socket, viewChanged } = await started();
    const view = client.view;
    const before = { server: view.server, revision: view.revision };
    const count = viewChanged.length;
    send(client, socket, "notifyserveredited invokerid=5 invokername=admin invokeruid=x");
    await settle();
    expect(view.server).toBe(before.server);
    expect(view.revision).toBe(before.revision);
    expect(viewChanged).toHaveLength(count);

    send(
      client,
      socket,
      "notifyserveredited invokerid=5 invokername=admin invokeruid=x virtualserver_name=Renamed",
    );
    await settle();
    expect(view.server["virtualserver_name"]).toBe("Renamed");
    expect(view.server).not.toBe(before.server);
    expect(before.server["virtualserver_name"]).toBe(init["virtualserver_name"]);
    expect(view.revision).toBe(before.revision + 1);
    expect(viewChanged.at(-1)).toBe(view.revision);

    // The same value again moves nothing.
    const again = view.revision;
    send(client, socket, "notifyserveredited virtualserver_name=Renamed");
    await settle();
    expect(view.revision).toBe(again);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  // After EchoSixHIYA/teamspeak-js (0979775, 956d29c, by illusia).
  it("reads the server's name, icon and banner from the server, and follows edits", async () => {
    const { client, socket } = await started();
    const view = client.view;
    expect(view.serverName).toBe(init["virtualserver_name"]);
    // The recorded server has no icon ("0") and no banner ("").
    expect(view.serverIconID).toBeUndefined();
    expect(view.serverBannerImageURL).toBeUndefined();
    const before = client.serverCapabilities;

    send(
      client,
      socket,
      "notifyserveredited invokerid=5 invokername=admin invokeruid=x virtualserver_name=Renamed" +
        " virtualserver_icon_id=-1528016466" +
        " virtualserver_hostbanner_gfx_url=\\shttps:\\/\\/example.com\\/banner.png\\s",
    );
    await settle();
    expect(view.serverName).toBe("Renamed");
    // The server sends the CRC32 as a signed 32-bit number; the icon file is
    // named by the unsigned one.
    expect(view.serverIconID).toBe(2766950830);
    expect(view.serverBannerImageURL).toBe("https://example.com/banner.png");
    // The handshake's record holds what lasts the connection, not these.
    expect(client.serverCapabilities).toBe(before);

    send(client, socket, "notifyserveredited virtualserver_icon_id=2766950830");
    await settle();
    expect(view.serverIconID).toBe(2766950830);
    send(client, socket, "notifyserveredited virtualserver_icon_id=x");
    await settle();
    expect(view.serverIconID).toBeUndefined();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("merges a notifyserverupdated without the counters, and keeps what it lacks", async () => {
    const { client, socket } = await started();
    const view = client.view;
    send(client, socket, `notifyserverupdated ${encoded(vars)} virtualserver_future_key=7`);
    await settle();
    const counters = [
      "clientsonline",
      "queryclientsonline",
      "channelsonline",
      "uptime",
      "client_connections",
      "query_client_connections",
      "month_bytes_downloaded",
      "month_bytes_uploaded",
      "total_bytes_downloaded",
      "total_bytes_uploaded",
      "total_packetloss_speech",
      "total_packetloss_keepalive",
      "total_packetloss_control",
      "total_packetloss_total",
      "total_ping",
    ];
    // The recording carries all 15, and none is held.
    for (const name of counters) {
      expect(vars).toHaveProperty(`virtualserver_${name}`);
      expect(view.server).not.toHaveProperty(`virtualserver_${name}`);
    }
    expect(view.server["virtualserver_port"]).toBe(vars["virtualserver_port"]);
    expect(view.server["virtualserver_future_key"]).toBe("7");
    // Init-only keys survive the merge.
    expect(view.server["virtualserver_platform"]).toBe(init["virtualserver_platform"]);
    expect(view.server["virtualserver_maxclients"]).toBe(vars["virtualserver_maxclients"]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("sends viewChanged once for the packets of a turn, none while loading, none for a repeat", async () => {
    const { client, sockets } = makeClient();
    const changed: number[] = [];
    client.on("viewChanged", (event) => changed.push(event.revision));
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...welcome.slice(0, finished));
    await connecting;
    await settle();
    expect(changed).toEqual([]);
    send(client, sockets[0]!, "channellistfinished");
    await settle();
    // viewReady carried this revision.
    expect(changed).toEqual([]);

    const order: string[] = [];
    client.on("channelCreated", () => order.push("channelCreated"));
    client.on("viewChanged", () => order.push("viewChanged"));
    send(client, sockets[0]!, ...recordings[family].events.slice(0, 3), groups.serverGroups8);
    await settle();
    expect(order).toEqual(["channelCreated", "channelCreated", "channelCreated", "viewChanged"]);
    expect(changed).toEqual([client.view.revision]);

    send(client, sockets[0]!, groups.serverGroups8);
    await settle();
    expect(changed).toHaveLength(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
    await settle();
    expect(changed).toHaveLength(2);
    expect(changed.at(-1)).toBe(client.view.revision);
  });

  it("names what a channel delete and a client leave removed", async () => {
    const { client, socket } = await live(family);
    const view = client.view;
    const deleted: unknown[] = [];
    const left: unknown[] = [];
    client.on("channelDeleted", (event) => deleted.push(event));
    client.on("clientLeave", (event) => left.push(event));

    const channel = view.channel(cid(6))!;
    const other = view.clientsIn(cid(2)).find((c) => c.id !== recordings[family].self)!;
    send(client, socket, "notifychanneldeleted cid=6 invokerid=1 invokername=x invokeruid=y");
    send(
      client,
      socket,
      `notifyclientleftview cfid=2 ctid=0 reasonid=8 reasonmsg=bye clid=${other.id}`,
    );
    // A client never announced, and a channel never held.
    send(client, socket, "notifyclientleftview cfid=2 ctid=0 reasonid=8 clid=999");
    send(client, socket, "notifychanneldeleted cid=99 invokerid=1");
    await settle();
    expect(deleted).toHaveLength(2);
    expect(left).toHaveLength(2);
    expect((deleted[0] as { previous?: unknown }).previous).toBe(channel);
    expect(
      (deleted[0] as { previous: { order: bigint; totalClients: unknown } }).previous.order,
    ).toBe(5n);
    expect(deleted[1]).not.toHaveProperty("previous");
    expect((left[0] as { previous?: unknown }).previous).toMatchObject({ id: other.id });
    expect(left[1]).not.toHaveProperty("previous");
    expect(view.channel(cid(6))).toBeUndefined();
    expect(view.client(other.id)).toBeUndefined();
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("gives a force-deleted parent's children first, each with its own record", async () => {
    const { client, socket } = await live(family);
    const deleted: Array<{ channelID: bigint; previous?: { name: string } | undefined }> = [];
    client.on("channelDeleted", (event) => deleted.push(event));
    send(client, socket, "notifychanneldeleted cid=5 invokerid=1");
    send(client, socket, "notifychanneldeleted cid=2 invokerid=1");
    await settle();
    expect(deleted.map((e) => [e.channelID, e.previous?.name])).toEqual([
      [5n, "Alpha-1"],
      [2n, "Alpha"],
    ]);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("gives no previous for a channel event while the view is loading", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    const deleted: unknown[] = [];
    client.on("channelDeleted", (event) => deleted.push(event));
    send(client, sockets[0]!, ...welcome.slice(0, 3), "notifychanneldeleted cid=2 invokerid=1");
    await connecting;
    await settle();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toHaveProperty("previous");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  /** A live client after the recorded welcome. */
  async function live(name: "ts3" | "ts6"): Promise<{ client: Client; socket: FakeSocket }> {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...groupRecordings[name].welcome);
    await connecting;
    await client.view.whenReady();
    await settle();
    return { client, socket: sockets[0]! };
  }
});

describe("the view of random group and server notifications", () => {
  it("never throws, and holds the last list", async () => {
    const { client, sockets } = makeClient();
    const { connecting } = await open(client, sockets);
    send(client, sockets[0]!, ...ts3Welcome);
    await connecting;
    await client.view.whenReady();
    const view = client.view;
    const row = fc.record({
      id: fc.oneof(fc.integer({ min: 0, max: 20 }).map(String), fc.constantFrom("", "x", "-1")),
      name: fc.constantFrom("a", "b", "c", ""),
    });
    const lines: Array<Array<{ id: string; name: string }>> = fc.sample(
      fc.array(row, { maxLength: 8 }),
      { numRuns: 80, seed: 5 },
    );
    for (const rows of lines) {
      const text = `notifyservergrouplist ${rows.map((r) => `sgid=${r.id} name=${r.name || "n"}`).join("|")}`;
      expect(() =>
        send(client, sockets[0]!, text, "notifyserveredited virtualserver_name=a"),
      ).not.toThrow();
      await settle();
      const expected = new Set(
        rows.filter((r) => /^[1-9]\d*$/.test(r.id)).map((r) => BigInt(r.id)),
      );
      expect(new Set(view.serverGroups.keys())).toEqual(expected);
    }
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
