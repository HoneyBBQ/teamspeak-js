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
  asChannelID,
  createChannel,
  deleteChannel,
  editChannel,
  listChannels,
  listClients,
  moveChannel,
} from "@honeybbq/teamspeak";
import type { Channel, ChannelID, Logger } from "@honeybbq/teamspeak";
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
    },
    login: {
      name: process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "",
      password: process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "",
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
});
