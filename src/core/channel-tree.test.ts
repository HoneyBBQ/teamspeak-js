import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ChannelTree } from "./channel-tree.js";
import { asChannelID, asClientID, asUID, type ChannelID } from "./command/ids.js";
import { handleNotification } from "./notifications.js";
import { parseChannel } from "./api/command.js";
import type { Channel, ChannelChanges } from "./api/command.js";
import type {
  ChannelCreatedEvent,
  ChannelDeletedEvent,
  ChannelEditedEvent,
  ChannelMovedEvent,
} from "./events.js";
import { prng } from "../client/testing/fake-server.js";

const id = (n: number | bigint): ChannelID => asChannelID(BigInt(n));
const who = { invokerID: asClientID(1), invokerName: "admin", invokerUID: asUID("serveradmin") };

function created(
  channel: number,
  parent: number,
  order: number | undefined,
  name = `c${channel}`,
): ChannelCreatedEvent {
  const changes: ChannelChanges = {
    name,
    parentID: id(parent),
    ...(order === undefined ? {} : { order: id(order) }),
  };
  return { channelID: id(channel), parentID: id(parent), changes, ...who };
}
const edited = (channel: number, changes: ChannelChanges): ChannelEditedEvent => ({
  channelID: id(channel),
  reason: 10,
  changes,
  ...who,
});
const moved = (channel: number, parent: number, order: number): ChannelMovedEvent => ({
  channelID: id(channel),
  parentID: id(parent),
  order: id(order),
  reason: 1,
  ...who,
});
const deleted = (channel: number): ChannelDeletedEvent => ({ channelID: id(channel), ...who });

function row(channel: number, parent: number, order: number): Channel {
  return parseChannel({
    cid: String(channel),
    cpid: String(parent),
    channel_order: String(order),
    channel_name: `c${channel}`,
  });
}

/** The ids of `tree` in pre-order, with each channel's parent and order. */
function shape(tree: ChannelTree): string[] {
  const out: string[] = [];
  const walk = (parent: ChannelID): void => {
    for (const channel of tree.children(parent)) {
      out.push(`${channel.id}<${channel.parentID}:${channel.order}`);
      walk(channel.id);
    }
  };
  walk(id(0));
  return out;
}

/**
 * Alpha(2) holds 5, 6, 7; the top level is 1, 2, 3, 4. The welcome sends
 * 2 first, then the rest.
 */
const start = ChannelTree.from([
  row(2, 0, 1),
  row(1, 0, 0),
  row(5, 2, 0),
  row(6, 2, 5),
  row(7, 2, 6),
  row(3, 0, 2),
  row(4, 0, 3),
]);

describe("ChannelTree.from", () => {
  it("orders siblings by predecessor whatever order the rows come in", () => {
    expect(shape(start)).toEqual(["1<0:0", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3"]);
    expect(start.size).toBe(7);
    expect(start.consistent).toBe(true);
  });

  it("is the same tree for every shuffle of the rows", () => {
    const rows = [row(2, 0, 1), row(1, 0, 0), row(5, 2, 0), row(6, 2, 5), row(3, 0, 2)];
    const expected = shape(ChannelTree.from(rows));
    const random = prng(7);
    for (let i = 0; i < 50; i++) {
      const shuffled = [...rows].sort(() => random() - 0.5);
      expect(shape(ChannelTree.from(shuffled))).toEqual(expected);
    }
  });

  it("orders a long chain of siblings without recursing", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => row(i + 1, 0, i));
    const tree = ChannelTree.from(rows.map((_, i) => rows[rows.length - 1 - i]!));
    expect(tree.consistent).toBe(true);
    expect(tree.children().map((c) => Number(c.id))).toEqual(rows.map((_, i) => i + 1));
  });

  it("reads the path from the root", () => {
    expect(start.path(id(6)).map((c) => c.id)).toEqual([id(2), id(6)]);
    expect(start.path(id(99))).toEqual([]);
    expect(start.get(id(7))?.name).toBe("c7");
    expect(start.get(id(99))).toBeUndefined();
    expect(start.children(id(99))).toEqual([]);
    expect(start.children().map((c) => c.id)).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("keeps what cannot be a tree, and says so", () => {
    // A predecessor that is not a sibling, a missing parent, and a loop.
    const bad = ChannelTree.from([row(1, 0, 9), row(2, 8, 0), row(3, 4, 0), row(4, 3, 0)]);
    expect(bad.consistent).toBe(false);
    expect(bad.size).toBe(4);
    for (const channel of shape(bad)) expect(channel).toBeTruthy();
    expect(bad.path(id(3)).length).toBeGreaterThan(0);
    for (const c of [1, 2, 3, 4]) {
      const parent = bad.get(id(c))!.parentID;
      expect(parent === id(0) || bad.get(parent) !== undefined).toBe(true);
    }
    expect(ChannelTree.from([row(1, 0, 0), row(1, 0, 0)]).consistent).toBe(false);
    expect(ChannelTree.from([row(1, 0, 0), row(2, 0, 0)]).consistent).toBe(false);
  });
});

// One case per row of the table of what the server does to a channel's
// siblings: the event, and the tree it must give.
describe("ChannelTree.apply, per server operation", () => {
  const cases: Array<[string, (tree: ChannelTree) => ChannelTree, string[]]> = [
    [
      "create without an order: appended, after the last sibling",
      (tree) => tree.applyCreated(created(8, 0, 4)),
      ["1<0:0", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3", "8<0:4"],
    ],
    [
      "create after channel 1: the next sibling's order becomes the new channel",
      (tree) => tree.applyCreated(created(9, 0, 1)),
      ["1<0:0", "9<0:1", "2<0:9", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3"],
    ],
    [
      "create first: the former first sibling's order becomes the new channel",
      (tree) => tree.applyCreated(created(10, 0, 0)),
      ["10<0:0", "1<0:10", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3"],
    ],
    [
      "create under a parent: first child",
      (tree) => tree.applyCreated(created(11, 4, 0)),
      ["1<0:0", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3", "11<4:0"],
    ],
    [
      "move to another parent: both neighbours are re-pointed",
      (tree) => tree.applyMoved(moved(5, 0, 3)),
      ["1<0:0", "2<0:1", "6<2:0", "7<2:6", "3<0:2", "5<0:3", "4<0:5"],
    ],
    [
      "move a channel with children: the subchannels go with it",
      (tree) => tree.applyMoved(moved(2, 4, 0)),
      ["1<0:0", "3<0:1", "4<0:3", "2<4:0", "5<2:0", "6<2:5", "7<2:6"],
    ],
    [
      "edit the order: a move within the parent",
      (tree) => tree.applyEdited(edited(1, { order: id(3) })),
      ["2<0:0", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "1<0:3", "4<0:1"],
    ],
    [
      "edit the order to first",
      (tree) => tree.applyEdited(edited(4, { order: id(0) })),
      ["4<0:0", "1<0:4", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2"],
    ],
    [
      "edit the name: nothing moves",
      (tree) => tree.applyEdited(edited(6, { name: "Renamed" })),
      ["1<0:0", "2<0:1", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3"],
    ],
    [
      "delete a middle sibling: the next one is re-pointed",
      (tree) => tree.applyDeleted(deleted(6)),
      ["1<0:0", "2<0:1", "5<2:0", "7<2:5", "3<0:2", "4<0:3"],
    ],
    [
      "delete the first sibling",
      (tree) => tree.applyDeleted(deleted(1)),
      ["2<0:0", "5<2:0", "6<2:5", "7<2:6", "3<0:2", "4<0:3"],
    ],
  ];

  it.each(cases)("%s", (_name, change, expected) => {
    const next = change(start);
    expect(shape(next)).toEqual(expected);
    expect(next.consistent).toBe(true);
    expect(next).not.toBe(start);
  });

  it("takes a name edit into the record", () => {
    expect(start.applyEdited(edited(6, { name: "Renamed" })).get(id(6))?.name).toBe("Renamed");
    expect(start.applyCreated(created(9, 0, 1, "Between")).get(id(9))?.name).toBe("Between");
  });

  it("deletes a channel with children as the server does: children first", () => {
    const next = start
      .applyDeleted(deleted(5))
      .applyDeleted(deleted(6))
      .applyDeleted(deleted(7))
      .applyDeleted(deleted(2));
    expect(shape(next)).toEqual(["1<0:0", "3<0:1", "4<0:3"]);
    expect(next.consistent).toBe(true);
  });

  it("leaves the tree it was called on as it was", () => {
    const before = shape(start);
    const channel = start.get(id(2));
    const kids = start.children(id(2));
    start.applyMoved(moved(2, 4, 0));
    start.applyDeleted(deleted(2));
    expect(shape(start)).toEqual(before);
    expect(start.get(id(2))).toBe(channel);
    expect(start.children(id(2))).toEqual(kids);
  });

  it("keeps a channel it cannot place at the end of its parent, and is not consistent", () => {
    // Moving to a place that is not a sibling of the target, or to a
    // predecessor the tree does not hold, is an error on the server: no
    // notification. One that arrives anyway is kept, not dropped.
    const badOrder = start.applyMoved(moved(5, 4, 99));
    expect(shape(badOrder)).toEqual([
      "1<0:0",
      "2<0:1",
      "6<2:0",
      "7<2:6",
      "3<0:2",
      "4<0:3",
      "5<4:0",
    ]);
    expect(badOrder.consistent).toBe(false);

    const unknownParent = start.applyCreated(created(9, 77, 0));
    expect(unknownParent.get(id(9))?.parentID).toBe(id(0));
    expect(unknownParent.consistent).toBe(false);

    expect(
      start
        .applyCreated(created(9, 0, undefined))
        .children()
        .at(-1)?.id,
    ).toBe(id(9));
    expect(start.applyCreated(created(9, 0, undefined)).consistent).toBe(false);
  });

  it("stays inconsistent once it is", () => {
    const tree = start.applyDeleted(deleted(99));
    expect(tree.consistent).toBe(false);
    expect(shape(tree)).toEqual(shape(start));
    expect(tree.applyCreated(created(9, 0, 1)).consistent).toBe(false);
  });

  it("does not move a channel under itself, and removes what a delete leaves behind", () => {
    const loop = start.applyMoved(moved(2, 6, 0));
    expect(loop.consistent).toBe(false);
    expect(loop.get(id(2))?.parentID).toBe(id(0));
    const orphans = start.applyDeleted(deleted(2));
    expect(orphans.consistent).toBe(false);
    expect(orphans.get(id(5))).toBeUndefined();
    expect(orphans.size).toBe(3);
    expect(start.applyCreated(created(2, 0, 4)).consistent).toBe(false);
  });

  it("reads events as the notifications carry them", () => {
    const read = (name: string, params: Record<string, string>) =>
      handleNotification({ name, params }, 0, new Map());
    const apply = (tree: ChannelTree, name: string, params: Record<string, string>) => {
      const result = read(name, params);
      if (result.kind === "channelCreated") return tree.applyCreated(result.event);
      if (result.kind === "channelEdited") return tree.applyEdited(result.event);
      if (result.kind === "channelMoved") return tree.applyMoved(result.event);
      if (result.kind === "channelDeleted") return tree.applyDeleted(result.event);
      throw new Error(result.kind);
    };
    let tree = apply(start, "notifychannelcreated", {
      cid: "9",
      cpid: "0",
      channel_order: "1",
      channel_name: "n",
    });
    tree = apply(tree, "notifychanneledited", {
      cid: "9",
      reasonid: "10",
      invokerid: "1",
      channel_order: "4",
    });
    tree = apply(tree, "notifychannelmoved", { cid: "9", cpid: "2", order: "0", reasonid: "1" });
    tree = apply(tree, "notifychanneldeleted", { cid: "3", invokerid: "1" });
    expect(shape(tree)).toEqual(["1<0:0", "2<0:1", "9<2:0", "5<2:9", "6<2:5", "7<2:6", "4<0:2"]);
    expect(tree.consistent).toBe(true);
  });
});

/**
 * The server's rules, kept the way the server keeps them: every channel stores
 * its parent and the sibling it comes after, and a change rewrites the stored
 * order of the sibling behind it.
 */
class Server {
  readonly nodes = new Map<number, { parent: number; order: number }>();

  childrenOf(parent: number): number[] {
    const kids = [...this.nodes].filter(([, n]) => n.parent === parent).map(([k]) => k);
    const out: number[] = [];
    let after = 0;
    for (;;) {
      const next = kids.find((k) => this.nodes.get(k)!.order === after && !out.includes(k));
      if (next === undefined) return out;
      out.push(next);
      after = next;
    }
  }

  listing(): string[] {
    const out: string[] = [];
    const walk = (parent: number): void => {
      for (const k of this.childrenOf(parent)) {
        const n = this.nodes.get(k)!;
        out.push(`${k}<${n.parent}:${n.order}`);
        walk(k);
      }
    };
    walk(0);
    return out;
  }

  rows(): Channel[] {
    return [...this.nodes].map(([k, n]) => row(k, n.parent, n.order));
  }

  insert(channel: number, parent: number, after: number): void {
    const behind = [...this.nodes].find(
      ([k, n]) => k !== channel && n.parent === parent && n.order === after,
    );
    if (behind !== undefined) behind[1].order = channel;
    this.nodes.set(channel, { parent, order: after });
  }

  remove(channel: number): void {
    const node = this.nodes.get(channel)!;
    const behind = [...this.nodes].find(([, n]) => n.parent === node.parent && n.order === channel);
    if (behind !== undefined) behind[1].order = node.order;
    this.nodes.delete(channel);
  }

  within(channel: number, ancestor: number): boolean {
    for (let at: number | undefined = channel; at !== undefined && at !== 0;) {
      if (at === ancestor) return true;
      at = this.nodes.get(at)?.parent;
    }
    return false;
  }
}

/** One random operation on the server, and the events it sends. */
function operate(
  server: Server,
  random: () => number,
  nextID: () => number,
): Array<(tree: ChannelTree) => ChannelTree> {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const ids = [...server.nodes.keys()];
  const kind =
    ids.length === 0 ? "create" : pick(["create", "create", "move", "order", "name", "delete"]);
  const place = (parent: number, except: number): number => {
    const siblings = server.childrenOf(parent).filter((k) => k !== except);
    return pick([0, ...siblings]);
  };
  switch (kind) {
    case "create": {
      const parent = pick([0, ...ids]);
      const channel = nextID();
      const siblings = server.childrenOf(parent);
      const after = pick([0, ...siblings, siblings.at(-1) ?? 0]);
      server.insert(channel, parent, after);
      return [(tree) => tree.applyCreated(created(channel, parent, after))];
    }
    case "move": {
      const channel = pick(ids);
      const parent = pick([0, ...ids.filter((k) => !server.within(k, channel))]);
      const after = place(parent, channel);
      server.remove(channel);
      server.insert(channel, parent, after);
      return [(tree) => tree.applyMoved(moved(channel, parent, after))];
    }
    case "order": {
      const channel = pick(ids);
      const parent = server.nodes.get(channel)!.parent;
      const after = place(parent, channel);
      server.remove(channel);
      server.insert(channel, parent, after);
      return [(tree) => tree.applyEdited(edited(channel, { order: id(after) }))];
    }
    case "name": {
      const channel = pick(ids);
      return [(tree) => tree.applyEdited(edited(channel, { name: "renamed" }))];
    }
    default: {
      const channel = pick(ids);
      const events: Array<(tree: ChannelTree) => ChannelTree> = [];
      const down = (c: number): void => {
        for (const k of server.childrenOf(c)) down(k);
        server.remove(c);
        events.push((tree) => tree.applyDeleted(deleted(c)));
      };
      down(channel);
      return events;
    }
  }
}

describe("ChannelTree.applyCreated, defaults", () => {
  it("gives a channel made with only a name the server's defaults", () => {
    const result = handleNotification(
      {
        name: "notifychannelcreated",
        params: {
          cid: "8",
          cpid: "0",
          channel_name: "Gamma",
          channel_order: "4",
          channel_flag_permanent: "1",
          invokerid: "35",
          invokername: "admin",
          invokeruid: "serveradmin",
        },
      },
      1,
      new Map(),
    );
    if (result.kind !== "channelCreated") throw new Error(result.kind);
    const channel = ChannelTree.from([]).applyCreated(result.event).get(id(8))!;
    expect(channel).toMatchObject({
      name: "Gamma",
      isPermanent: true,
      isSemiPermanent: false,
      isDefault: false,
      hasPassword: false,
      topic: "",
      description: "",
      codec: 4,
      codecQuality: 5,
      maxClients: -1,
      maxFamilyClients: -1,
      neededTalkPower: 0,
      codecLatencyFactor: 1,
      isMaxClientsUnlimited: true,
      isMaxFamilyClientsUnlimited: true,
      isMaxFamilyClientsInherited: false,
      isForcedSilence: false,
      deleteDelayMs: 0,
      namePhonetic: "",
      bannerURL: "",
      bannerMode: 0,
    });
    // No icon is how the welcome reads icon 0; the rest are not known from a notification, so not claimed.
    expect(channel.iconID).toBeUndefined();
    expect(channel.isUnencrypted).toBeUndefined();
    expect(channel.storageQuota).toBeUndefined();
  });

  it("lets what the notification carries override a default", () => {
    const event = created(8, 0, 0);
    const channel = ChannelTree.from([])
      .applyCreated({
        ...event,
        changes: { ...event.changes, codec: 5, maxClients: 3, topic: "hi", hasPassword: true },
      })
      .get(id(8))!;
    expect(channel).toMatchObject({
      codec: 5,
      codecQuality: 5,
      maxClients: 3,
      maxFamilyClients: -1,
      topic: "hi",
      hasPassword: true,
    });
  });
});

describe("ChannelTree against the server's rules", () => {
  it("equals the server's listing after every step of random operations", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const random = prng(seed);
      const server = new Server();
      let counter = 0;
      let tree = ChannelTree.from([]);
      for (let step = 0; step < 40; step++) {
        for (const event of operate(server, random, () => ++counter)) tree = event(tree);
        expect(shape(tree), `seed ${seed} step ${step}`).toEqual(server.listing());
        expect(tree.consistent).toBe(true);
        expect(tree.size).toBe(server.nodes.size);
        // And from the listing, in any order, it is the same tree.
        const rows = server.rows().sort(() => random() - 0.5);
        expect(shape(ChannelTree.from(rows))).toEqual(server.listing());
      }
    }
  });
});

describe("ChannelTree fuzz", () => {
  const channelNumber = fc.integer({ min: 0, max: 12 });
  const event = fc.oneof(
    fc.record({
      kind: fc.constant("created" as const),
      c: channelNumber,
      p: channelNumber,
      o: fc.option(channelNumber),
    }),
    fc.record({
      kind: fc.constant("moved" as const),
      c: channelNumber,
      p: channelNumber,
      o: channelNumber,
    }),
    fc.record({ kind: fc.constant("order" as const), c: channelNumber, o: channelNumber }),
    fc.record({ kind: fc.constant("deleted" as const), c: channelNumber }),
  );

  it("never throws and never leaves a channel without its parent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(channelNumber, channelNumber, channelNumber), { maxLength: 12 }),
        fc.array(event, { maxLength: 40 }),
        (initial, events) => {
          let tree = ChannelTree.from(initial.map(([c, p, o]) => row(c, p, o)));
          const check = (): void => {
            const seen: ChannelID[] = [];
            const walk = (parent: ChannelID): void => {
              for (const channel of tree.children(parent)) {
                expect(channel.parentID).toBe(parent);
                seen.push(channel.id);
                walk(channel.id);
              }
            };
            walk(id(0));
            expect(seen.length).toBe(tree.size);
            expect(new Set(seen).size).toBe(tree.size);
          };
          check();
          for (const e of events) {
            tree =
              e.kind === "created"
                ? tree.applyCreated(created(e.c, e.p, e.o ?? undefined))
                : e.kind === "moved"
                  ? tree.applyMoved(moved(e.c, e.p, e.o))
                  : e.kind === "order"
                    ? tree.applyEdited(edited(e.c, { order: id(e.o) }))
                    : tree.applyDeleted(deleted(e.c));
            check();
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
