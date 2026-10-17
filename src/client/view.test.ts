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
  type Logger,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
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
