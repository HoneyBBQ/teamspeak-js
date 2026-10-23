/**
 * Live tests of the server view: that what a connected client holds of the
 * channel tree and the clients equals what the server lists.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set, and need the fixture's query endpoint, which makes
 * the changes and lists the channels, or they skip. Each test puts back what
 * it created.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/client/view.integration.test.ts --reporter=verbose
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClientType,
  GroupType,
  addServerGroupPermission,
  asChannelID,
  asServerGroupID,
  copyChannelGroup,
  copyServerGroup,
  createChannel,
  createChannelGroup,
  createServerGroup,
  deleteChannel,
  deleteChannelGroup,
  deleteServerGroup,
  editChannel,
  editServer,
  getServerInfo,
  listChannelGroups,
  listChannels,
  listClients,
  listServerGroups,
  moveChannel,
  permissionByName,
  renameChannelGroup,
  renameServerGroup,
} from "@honeybbq/teamspeak";
import type {
  Channel,
  ChannelGroupID,
  ChannelID,
  Logger,
  ServerGroupID,
} from "@honeybbq/teamspeak";
import { getServerVariables } from "./api/voice.js";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import type { EventMap } from "./types.js";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";
const SKIP = !ADDR || !HAS_ADMIN;
const EVENT_MS = 8_000;
const RUN = Date.now().toString(36).slice(-5);

function adminOptions(): QueryClientOptions {
  if (QUERY_KIND === "web") {
    return {
      transport: {
        kind: "web",
        url: process.env["TEAMSPEAK_QUERY_URL"] ?? "",
        apiKey: process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "",
      },
      server: { id: 1 },
    };
  }
  return {
    transport: {
      kind: "tcp",
      host: process.env["TEAMSPEAK_QUERY_HOST"] ?? "127.0.0.1",
      port: Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011"),
      login: {
        name: process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "",
        password: process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "",
      },
    },
    server: { id: 1 },
    nickname: `ts-js-view-admin-${RUN}`,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Connect a client, spaced out from the last: the server's anti-flood tolerates a few. */
async function connectClient(
  nickname: string,
  defaultChannel = DEFAULT_CHANNEL,
  logger?: Logger,
): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel,
    ...(logger === undefined ? {} : { logger }),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2_000);
    }
  }
  await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  return client;
}

/** Resolve with the first event of `name` that `match` accepts; reject when none arrives. */
function nextEvent<K extends keyof EventMap>(
  client: Client,
  name: K,
  match: (payload: EventMap[K]) => boolean,
): Promise<EventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${name} event arrived`));
    }, EVENT_MS);
    const off = (client.on as (n: K, l: (p: EventMap[K]) => void) => () => void)(
      name,
      (payload) => {
        if (!match(payload)) return;
        clearTimeout(timer);
        off();
        resolve(payload);
      },
    );
  });
}

/** What `channellist` says of each channel, in the order it lists them. */
function describeListing(channels: readonly Channel[]): string[] {
  return channels.map((c) => `${c.id} parent=${c.parentID} order=${c.order} ${c.name}`);
}

describe.skipIf(SKIP)("Server view — live", () => {
  let admin: QueryClient;
  let watcher: Client;
  const created: ChannelID[] = [];
  /** What the watcher's client logged at debug level, where a channel event it could not place shows. */
  const debug: string[] = [];

  beforeAll(async () => {
    admin = new QueryClient(adminOptions());
    await admin.connect({ signal: AbortSignal.timeout(15_000) });
    watcher = await connectClient(`ts-js-view-${RUN}`, DEFAULT_CHANNEL, {
      debug: (message) => debug.push(message),
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  }, 60_000);

  afterAll(async () => {
    await watcher?.disconnect().catch(() => {});
    for (const id of created) await deleteChannel(admin, id, { force: true }).catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 30_000);

  it("holds the tree the server lists, in its order, after every kind of change", async () => {
    const view = watcher.view;
    const name = (suffix: string): string => `vw-${suffix}-${RUN}`;
    const ids = new Map<string, ChannelID>();

    /** Run `change`, wait for the event that reports its last effect, and compare. */
    async function step<
      K extends "channelCreated" | "channelMoved" | "channelEdited" | "channelDeleted",
    >(
      label: string,
      event: K,
      match: (payload: EventMap[K]) => boolean,
      change: () => Promise<void>,
    ): Promise<void> {
      const arrived = nextEvent(watcher, event, match);
      await change();
      await arrived;
      const listing = await listChannels(admin);
      expect(describeListing([...view.channels.values()]), `after ${label}`).toEqual(
        describeListing(listing),
      );
    }

    const make = async (
      key: string,
      options: { parent?: string; order?: ChannelID | string } = {},
    ) => {
      const parentID = options.parent === undefined ? undefined : ids.get(options.parent);
      const order = typeof options.order === "string" ? ids.get(options.order)! : options.order;
      const channel = await createChannel(admin, {
        name: name(key),
        isPermanent: true,
        parentID,
        order,
      });
      created.push(channel);
      ids.set(key, channel);
      return channel;
    };
    const lastOf = (key: string) => (e: { channelID: ChannelID }) => e.channelID === ids.get(key);

    // The tree as it is, before anything changes.
    expect(describeListing([...view.channels.values()])).toEqual(
      describeListing(await listChannels(admin)),
    );
    expect(view.status).toBe("live");

    await step(
      "create without an order",
      "channelCreated",
      (e) => e.changes.name === name("p1"),
      async () => {
        await make("p1");
      },
    );
    await step(
      "create after a sibling",
      "channelCreated",
      (e) => e.changes.name === name("p2"),
      async () => {
        await make("p2", { order: "p1" });
      },
    );
    await step(
      "create first",
      "channelCreated",
      (e) => e.changes.name === name("p3"),
      async () => {
        await make("p3", { order: asChannelID(0n) });
      },
    );
    await step(
      "create between two siblings",
      "channelCreated",
      (e) => e.changes.name === name("p4"),
      async () => {
        await make("p4", { order: "p1" });
      },
    );
    await step(
      "create under a parent",
      "channelCreated",
      (e) => e.changes.name === name("c1"),
      async () => {
        await make("c1", { parent: "p1" });
      },
    );
    await step(
      "create first under a parent",
      "channelCreated",
      (e) => e.changes.name === name("c2"),
      async () => {
        await make("c2", { parent: "p1", order: asChannelID(0n) });
      },
    );
    await step("move to the top level after a sibling", "channelMoved", lastOf("c1"), async () => {
      await moveChannel(admin, ids.get("c1")!, asChannelID(0n), { order: ids.get("p3")! });
    });
    await step("move under another parent", "channelMoved", lastOf("p4"), async () => {
      await moveChannel(admin, ids.get("p4")!, ids.get("p2")!, { order: asChannelID(0n) });
    });
    await step("move a channel with children", "channelMoved", lastOf("p1"), async () => {
      await moveChannel(admin, ids.get("p1")!, ids.get("p3")!, { order: asChannelID(0n) });
    });
    await step(
      "change the order inside the top level",
      "channelEdited",
      (e) => e.channelID === ids.get("c1") && e.changes.order !== undefined,
      async () => {
        await editChannel(admin, ids.get("c1")!, { order: asChannelID(0n) });
      },
    );
    await step(
      "rename",
      "channelEdited",
      (e) => e.channelID === ids.get("p2") && e.changes.name !== undefined,
      async () => {
        await editChannel(admin, ids.get("p2")!, { name: name("p2-renamed") });
      },
    );
    await step("delete a middle sibling", "channelDeleted", lastOf("c1"), async () => {
      await deleteChannel(admin, ids.get("c1")!, { force: true });
    });
    await step("delete a channel with children", "channelDeleted", lastOf("p3"), async () => {
      await deleteChannel(admin, ids.get("p3")!, { force: true });
    });
    await step("delete the rest", "channelDeleted", lastOf("p2"), async () => {
      await deleteChannel(admin, ids.get("p2")!, { force: true });
    });
    for (const key of ids.keys()) expect(view.channel(ids.get(key)!)).toBeUndefined();
    expect(describeListing([...view.channels.values()])).toEqual(
      describeListing(await listChannels(admin)),
    );
    // No event had to be guessed at.
    expect(debug.filter((message) => message.includes("could not be placed"))).toEqual([]);
  }, 90_000);

  it("holds at the welcome what the server lists: the tree and the clients of its own channel", async () => {
    const q = admin;
    const root = await createChannel(q, { name: `vw-w1-${RUN}`, isPermanent: true });
    created.push(root);
    const mid = await createChannel(q, { name: `vw-w2-${RUN}`, isPermanent: true, parentID: root });
    created.push(mid);
    const leaf = await createChannel(q, { name: `vw-w3-${RUN}`, isPermanent: true, parentID: mid });
    created.push(leaf);
    const sibling = await createChannel(q, {
      name: `vw-w4-${RUN}`,
      isPermanent: true,
      parentID: mid,
      order: asChannelID(0n),
    });
    created.push(sibling);

    const first = await connectClient(`ts-js-vw1-${RUN}`, `vw-w1-${RUN}/vw-w2-${RUN}/vw-w3-${RUN}`);
    let second: Client | undefined;
    try {
      // A second client arrives in the same channel, so there is more than the client itself.
      await sleep(2_200);
      second = await connectClient(`ts-js-vw2-${RUN}`, `vw-w1-${RUN}/vw-w2-${RUN}/vw-w3-${RUN}`);
      const view = second.view;
      expect(view.status).toBe("live");

      expect(describeListing([...view.channels.values()])).toEqual(
        describeListing(await listChannels(q)),
      );
      expect(view.path(leaf).map((c) => c.id)).toEqual([root, mid, leaf]);
      expect(view.children(mid).map((c) => c.id)).toEqual([sibling, leaf]);
      expect(view.self?.id).toBe(second.clientID);
      expect(view.self?.channelID).toBe(leaf);

      const listed = (await listClients(q)).filter(
        (c) => c.type === ClientType.Voice && c.channelID === leaf,
      );
      const known = view.clientsIn(leaf).filter((c) => c.type === ClientType.Voice);
      expect(known.map((c) => [c.id, c.nickname])).toEqual(
        listed.sort((a, b) => a.id - b.id).map((c) => [c.id, c.nickname]),
      );
      expect(known.map((c) => c.id)).toContain(first.clientID);
    } finally {
      await second?.disconnect().catch(() => {});
      await first.disconnect().catch(() => {});
      for (const channel of [root]) {
        await deleteChannel(q, channel, { force: true }).catch(() => {});
      }
    }
  }, 60_000);

  it("holds a channel created while connected as a client that joins later holds it", async () => {
    const id = await createChannel(admin, { name: `vw-d1-${RUN}`, isPermanent: true });
    created.push(id);
    await eventually("the channel in the first view", () => watcher.view.channel(id) !== undefined);

    await sleep(2_200);
    const later = await connectClient(`ts-js-vwd-${RUN}`);
    try {
      const seen = watcher.view.channel(id);
      const listed = later.view.channel(id);
      expect(seen).toBeDefined();
      expect(listed).toBeDefined();
      // Derived or unknowable to the first view: the order is the server's to
      // settle, the counts and the empty time come only with a listing, the
      // codec encryption follows a server setting, the quota is TS6 only and
      // the unique identifier only comes with a notification on TS6.
      const drop = (c: Channel): Record<string, unknown> => {
        const {
          order: _order,
          totalClients: _total,
          totalFamilyClients: _family,
          neededSubscribePower: _subscribe,
          emptyForMs: _empty,
          isUnencrypted: _unencrypted,
          storageQuota: _quota,
          uid: _uid,
          filePath: _path,
          ...rest
        } = c;
        return rest;
      };
      expect(drop(seen!)).toEqual(drop(listed!));
      expect(seen!.codec).toBe(4);
      expect(seen!.maxClients).toBe(-1);
      if (seen!.uid !== "") expect(seen!.uid).toBe(listed!.uid);
    } finally {
      await later.disconnect().catch(() => {});
      await deleteChannel(admin, id, { force: true }).catch(() => {});
    }
  }, 60_000);
});

/** Poll until `condition` holds, for as long as an event may take. */
async function eventually(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + EVENT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not come true`);
    await sleep(25);
  }
}

describe.skipIf(SKIP)("Server view, groups and server — live", () => {
  let admin: QueryClient;
  let watcher: Client;
  /** Every `viewChanged` the watcher was sent. */
  const changed: number[] = [];
  const serverGroups: ServerGroupID[] = [];
  const channelGroups: ChannelGroupID[] = [];
  const channels: ChannelID[] = [];
  let original: Readonly<Record<string, string>> = {};

  const listing = async () => ({
    server: (await listServerGroups(admin)).map((g) => [g.id, g.name, g.type] as const),
    channel: (await listChannelGroups(admin)).map((g) => [g.id, g.name, g.type] as const),
  });
  const viewed = (client: Client) => ({
    server: [...client.view.serverGroups.values()].map((g) => [g.id, g.name, g.type] as const),
    channel: [...client.view.channelGroups.values()].map((g) => [g.id, g.name, g.type] as const),
  });
  /** Wait for the view to hold what the server lists, then compare entry by entry. */
  async function matchesListing(client: Client, label: string): Promise<void> {
    const want = await listing();
    await eventually(`the groups ${label}`, () => {
      const have = viewed(client);
      return (
        JSON.stringify(have.server, (_, v) => (typeof v === "bigint" ? String(v) : v)) ===
          JSON.stringify(want.server, (_, v) => (typeof v === "bigint" ? String(v) : v)) &&
        JSON.stringify(have.channel, (_, v) => (typeof v === "bigint" ? String(v) : v)) ===
          JSON.stringify(want.channel, (_, v) => (typeof v === "bigint" ? String(v) : v))
      );
    });
    const have = viewed(client);
    expect(have.server, `server groups ${label}`).toEqual(want.server);
    expect(have.channel, `channel groups ${label}`).toEqual(want.channel);
  }

  beforeAll(async () => {
    admin = new QueryClient(adminOptions());
    await admin.connect({ signal: AbortSignal.timeout(15_000) });
    original = await getServerInfo(admin);
    await sleep(1_200);
    watcher = await connectClient(`ts-js-vg-${RUN}`);
    watcher.on("viewChanged", (event) => changed.push(event.revision));
  }, 60_000);

  afterAll(async () => {
    await watcher?.disconnect().catch(() => {});
    for (const id of serverGroups)
      await deleteServerGroup(admin, id, { force: true }).catch(() => {});
    for (const id of channelGroups)
      await deleteChannelGroup(admin, id, { force: true }).catch(() => {});
    for (const id of channels) await deleteChannel(admin, id, { force: true }).catch(() => {});
    const restore: Record<string, string> = {};
    for (const key of [
      "virtualserver_name",
      "virtualserver_welcomemessage",
      "virtualserver_maxclients",
      "virtualserver_icon_id",
      "virtualserver_hostbanner_gfx_url",
    ]) {
      if (original[key] !== undefined) restore[key] = original[key];
    }
    if (Object.keys(restore).length > 0) await editServer(admin, restore).catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 120_000);

  it("holds the group lists the server lists, through 62 of each, a rename, a copy and a delete", async () => {
    const view = watcher.view;
    const startChanges = changed.length;
    const startRevision = view.revision;
    await eventually("groups loaded", () => view.groupsLoaded);
    await matchesListing(watcher, "at the start");

    let operations = 0;
    for (let i = 0; i < 62; i++) {
      serverGroups.push(await createServerGroup(admin, `vg-s${i}-${RUN}`, GroupType.Regular));
      channelGroups.push(await createChannelGroup(admin, `vg-c${i}-${RUN}`, GroupType.Regular));
      operations += 2;
    }
    await matchesListing(watcher, "after 62 of each");
    expect(view.serverGroups.size).toBeGreaterThanOrEqual(62);
    expect(view.channelGroups.size).toBeGreaterThanOrEqual(62);
    const ids = [...view.serverGroups.keys()];
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : 1)));

    const kept = view.serverGroups;
    await renameServerGroup(admin, serverGroups[3]!, `vg-renamed-${RUN}`);
    await renameChannelGroup(admin, channelGroups[3]!, `vg-renamed-${RUN}`);
    await matchesListing(watcher, "after a rename");
    expect(view.serverGroups).not.toBe(kept);
    expect(kept.get(serverGroups[3]!)?.name).toBe(`vg-s3-${RUN}`);

    serverGroups.push(
      await copyServerGroup(
        admin,
        serverGroups[5]!,
        asServerGroupID(0n),
        `vg-copy-${RUN}`,
        GroupType.Regular,
      ),
    );
    channelGroups.push(
      await copyChannelGroup(
        admin,
        channelGroups[5]!,
        0n as ChannelGroupID,
        `vg-copy-${RUN}`,
        GroupType.Regular,
      ),
    );
    await matchesListing(watcher, "after a copy");

    const gone = serverGroups.splice(10, 1)[0]!;
    await deleteServerGroup(admin, gone, { force: true });
    const goneChannel = channelGroups.splice(10, 1)[0]!;
    await deleteChannelGroup(admin, goneChannel, { force: true });
    await matchesListing(watcher, "after a delete");
    expect(view.serverGroups.has(gone)).toBe(false);
    expect(view.channelGroups.has(goneChannel)).toBe(false);

    // A group's permissions are not announced, so nothing moves.
    await sleep(300);
    const revision = view.revision;
    const groups = view.serverGroups;
    await addServerGroupPermission(
      admin,
      serverGroups[0]!,
      permissionByName("i_client_talk_power"),
      5,
    );
    await sleep(500);
    expect(view.revision).toBe(revision);
    expect(view.serverGroups).toBe(groups);

    // viewChanged: at least one, at most one per change, and the last says where the view is.
    await sleep(300);
    const events = changed.length - startChanges;
    expect(events).toBeGreaterThanOrEqual(1);
    expect(events).toBeLessThanOrEqual(operations + 8);
    expect(changed.at(-1)).toBe(view.revision);
    expect(view.revision).toBeGreaterThan(startRevision);
    expect(new Set(changed).size).toBe(changed.length);
  }, 240_000);

  it("is complete at the first viewChanged for a client that joins 70 groups, and after a join during churn", async () => {
    const want = await listing();
    expect(want.server.length).toBeGreaterThan(62);
    await sleep(1_200);
    const client = new Client(generateIdentitySync(8), ADDR!, `ts-js-vg2-${RUN}`, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    const firstChange = new Promise<boolean>((resolve) => {
      client.on("viewChanged", () => resolve(client.view.groupsLoaded));
    });
    const churn: Promise<unknown> = (async () => {
      // Groups appear and go while the client is joining.
      for (let i = 0; i < 3; i++) {
        const id = await createServerGroup(admin, `vg-churn${i}-${RUN}`, GroupType.Regular);
        serverGroups.push(id);
      }
    })();
    try {
      await client.connect({ signal: AbortSignal.timeout(15_000) });
      await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
      await churn;
      await eventually("groups loaded", () => client.view.groupsLoaded);
      // The groups come right after the welcome; the first announcement at the latest carries them.
      expect(await Promise.race([firstChange, sleep(EVENT_MS).then(() => false)])).toBe(true);
      await matchesListing(client, "after a join during churn");
    } finally {
      await client.disconnect().catch(() => {});
    }
  }, 90_000);

  it("patches the announced server properties, and the rest after getServerVariables", async () => {
    const view = watcher.view;
    expect(view.server["virtualserver_name"]).toBe(original["virtualserver_name"]);
    expect(Object.keys(view.server).every((key) => key.startsWith("virtualserver_"))).toBe(true);

    const renamed = nextEvent(watcher, "serverEdited", () => true);
    await editServer(admin, { virtualserver_name: `vg-name-${RUN}` });
    await renamed;
    expect(view.server["virtualserver_name"]).toBe(`vg-name-${RUN}`);
    expect(view.serverName).toBe(`vg-name-${RUN}`);

    // The server does not say which of these changed: the edit arrives empty.
    const silent = nextEvent(watcher, "serverEdited", () => true);
    const oldWelcome = view.server["virtualserver_welcomemessage"];
    const oldMax = view.server["virtualserver_maxclients"];
    await editServer(admin, {
      virtualserver_welcomemessage: `vg-welcome-${RUN}`,
      virtualserver_maxclients: String(Number(original["virtualserver_maxclients"] ?? "32") - 1),
    });
    const event = await silent;
    expect(event.changes).toEqual({});
    expect(view.server["virtualserver_welcomemessage"]).toBe(oldWelcome);
    expect(view.server["virtualserver_maxclients"]).toBe(oldMax);

    const variables = await getServerVariables(watcher);
    expect(variables["virtualserver_welcomemessage"]).toBe(`vg-welcome-${RUN}`);
    expect(view.server["virtualserver_welcomemessage"]).toBe(`vg-welcome-${RUN}`);
    expect(view.server["virtualserver_maxclients"]).toBe(variables["virtualserver_maxclients"]);

    const info = await getServerInfo(admin);
    for (const [key, value] of Object.entries(view.server)) {
      expect(info[key], key).toBe(value);
    }

    // An icon and a banner: current once the edit is announced or
    // getServerVariables has run. The server refuses a signed icon id in an
    // edit (convert error), though it may send one.
    const decorated = nextEvent(watcher, "serverEdited", () => true);
    await editServer(admin, {
      virtualserver_icon_id: "2766950830",
      virtualserver_hostbanner_gfx_url: `https://example.com/vg-${RUN}.png`,
    });
    await decorated;
    await getServerVariables(watcher);
    console.log("icon as held:", view.server["virtualserver_icon_id"]);
    expect(view.serverIconID).toBe(2766950830);
    expect(view.serverBannerImageURL).toBe(`https://example.com/vg-${RUN}.png`);
    for (const counter of ["clientsonline", "channelsonline", "uptime", "client_connections"]) {
      expect(view.server).not.toHaveProperty(`virtualserver_${counter}`);
      expect(variables).toHaveProperty(`virtualserver_${counter}`);
    }
  }, 60_000);

  it("names what a deleted channel and a client that left were", async () => {
    const view = watcher.view;
    const made = nextEvent(watcher, "channelCreated", (e) => e.changes.name === `vg-prev-${RUN}`);
    const channel = await createChannel(admin, { name: `vg-prev-${RUN}`, isPermanent: true });
    channels.push(channel);
    await made;
    const held = view.channel(channel)!;
    const deleted = nextEvent(watcher, "channelDeleted", (e) => e.channelID === channel);
    await deleteChannel(admin, channel, { force: true });
    const event = await deleted;
    expect(event.previous).toEqual(held);
    expect(view.channel(channel)).toBeUndefined();

    await sleep(1_200);
    const bystander = await connectClient(`ts-js-vgb-${RUN}`);
    try {
      await eventually(
        "the bystander is known",
        () => view.client(bystander.clientID) !== undefined,
      );
      const known = view.client(bystander.clientID)!;
      const left = nextEvent(watcher, "clientLeave", (e) => e.clientID === bystander.clientID);
      await bystander.disconnect();
      const leave = await left;
      expect(leave.previous).toEqual(known);
      expect(view.client(bystander.clientID)).toBeUndefined();
    } finally {
      await bystander.disconnect().catch(() => {});
    }
  }, 60_000);

  it("reports a channel move with a viewChanged", async () => {
    const view = watcher.view;
    const a = await createChannel(admin, { name: `vg-mv1-${RUN}`, isPermanent: true });
    channels.push(a);
    const b = await createChannel(admin, { name: `vg-mv2-${RUN}`, isPermanent: true });
    channels.push(b);
    await eventually(
      "both channels",
      () => view.channel(a) !== undefined && view.channel(b) !== undefined,
    );
    await sleep(300);
    const before = changed.length;
    await moveChannel(admin, b, a, { order: asChannelID(0n) });
    await eventually("the move", () => view.channel(b)?.parentID === a);
    await eventually(
      "viewChanged",
      () => changed.length > before && changed.at(-1) === view.revision,
    );
    expect(changed.length - before).toBeLessThanOrEqual(2);
  }, 30_000);
});
