/**
 * Live tests of the voice client's own features: whispers to channels and
 * groups, the privilege key and meta data given when connecting, a parting
 * message, the connection info exchange and the password checks.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set, and the ones that rearrange the server (channels,
 * groups, keys) also need the fixture's query endpoint, or they skip. Each
 * test puts back what it changed.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/client/voice-features.integration.test.ts --reporter=verbose
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Codec,
  GroupType,
  addClientToServerGroup,
  addPrivilegeKey,
  asChannelID,
  asClientID,
  createChannel,
  createChannelGroup,
  createServerGroup,
  deleteChannel,
  deleteChannelGroup,
  deletePrivilegeKey,
  deleteServerGroup,
  getClientConnectionInfo,
  getClientDBIDByUID,
  getServerGroupsByClient,
  listChannels,
  listServerGroups,
  NoDataError,
  listPrivilegeKeys,
  moveClient,
  removeClientFromServerGroup,
  setClientChannelGroup,
  updateClient,
} from "@honeybbq/teamspeak";
import type {
  ChannelID,
  ChannelGroupID,
  ClientDBID,
  ClientID,
  CommandExecutor,
  ServerGroupID,
} from "@honeybbq/teamspeak";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { GroupWhisperScope, GroupWhisperType } from "./types.js";
import type { EventMap } from "./types.js";
import {
  muteClients,
  unmuteClients,
  verifyChannelPassword,
  verifyServerPassword,
} from "./api/voice.js";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";
const SKIP = !ADDR;
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
    nickname: `ts-js-vf-admin-${RUN}`,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Connect a client to the shared channel. TeamSpeak's antiflood tolerates only
 * a few rapid connects from one address, so callers space them out.
 */
async function connectClient(
  nickname: string,
  extra: Partial<ConstructorParameters<typeof Client>[3]> = {},
): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    ...extra,
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
  await sleep(2_200);
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

/** Count the voice frames a client hears from now on. */
function hear(client: Client): { count: () => number; reset: () => void; stop: () => void } {
  let n = 0;
  const stop = client.on("voiceData", () => n++);
  return { count: () => n, reset: () => (n = 0), stop };
}

/**
 * Create a server group. TeamSpeak 6's WebQuery has answered a successful
 * `servergroupadd` with no data once in a while, as it does for `channelcreate`;
 * the group exists then, so it is looked up by name.
 */
async function makeServerGroup(q: CommandExecutor, name: string): Promise<ServerGroupID> {
  try {
    return await createServerGroup(q, name, GroupType.Regular);
  } catch (error) {
    if (!(error instanceof NoDataError)) throw error;
    const found = (await listServerGroups(q)).find((g) => g.name === name);
    if (found === undefined) throw error;
    return found.id;
  }
}

const FRAME = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

async function sendFrames(send: () => void, frames = 8): Promise<void> {
  for (let i = 0; i < frames; i++) {
    send();
    await sleep(20);
  }
  await sleep(1_200);
}

describe.skipIf(SKIP)("Voice features — live", () => {
  let admin: QueryClient | undefined;
  let a: Client; // the sender, in the shared channel
  let b: Client;
  let c: Client;
  const clients: Client[] = [];
  let home: ChannelID;

  const adminExec = (): QueryClient => admin!;
  const idOf = (client: Client): ClientID => asClientID(client.clientID);
  const dbidOf = async (client: Client): Promise<ClientDBID> =>
    getClientDBIDByUID(adminExec(), client.uid);

  beforeAll(async () => {
    if (HAS_ADMIN) {
      admin = new QueryClient(adminOptions());
      await admin.connect({ signal: AbortSignal.timeout(15_000) });
    }
    a = await connectClient(`ts-js-vfa-${RUN}`);
    b = await connectClient(`ts-js-vfb-${RUN}`);
    c = await connectClient(`ts-js-vfc-${RUN}`);
    clients.push(a, b, c);
    home = a.channelID;
  }, 90_000);

  afterAll(async () => {
    for (const client of clients) await client.disconnect().catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 30_000);

  /**
   * Two permanent channels, b in the first and c in the second, with a left
   * in the shared channel; so nothing a whispers can reach them by ordinary
   * channel routing. Everything is put back afterwards.
   */
  async function withRooms(
    run: (rooms: { x: ChannelID; y: ChannelID }) => Promise<void>,
  ): Promise<void> {
    const q = adminExec();
    const x = await createChannel(q, { name: `vf-x-${RUN}`, isPermanent: true });
    const y = await createChannel(q, { name: `vf-y-${RUN}`, isPermanent: true });
    try {
      await moveClient(q, idOf(b), x);
      await moveClient(q, idOf(c), y);
      await sleep(800);
      await run({ x, y });
    } finally {
      await moveClient(q, idOf(b), home).catch(() => {});
      await moveClient(q, idOf(c), home).catch(() => {});
      await sleep(500);
      await deleteChannel(q, x, { force: true }).catch(() => {});
      await deleteChannel(q, y, { force: true }).catch(() => {});
    }
  }

  // voiceData does not say whether a frame was a whisper, so these tests read
  // the reception alone: the sender sits in a channel none of the listeners is
  // in, which rules ordinary channel voice out.

  it.skipIf(!HAS_ADMIN)(
    "sendWhisper to a channel — its member hears it, a client elsewhere does not (needs a query endpoint)",
    async () => {
      await withRooms(async ({ x }) => {
        const hb = hear(b);
        const hc = hear(c);
        await sendFrames(() => a.sendWhisper(FRAME, { channels: [x] }, Codec.OpusVoice));
        hb.stop();
        hc.stop();
        console.log("channel whisper: b", hb.count(), "c", hc.count());
        expect(hb.count()).toBeGreaterThan(0);
        expect(hc.count()).toBe(0);
      });
    },
    45_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "sendWhisper to channels and clients together reaches both (needs a query endpoint)",
    async () => {
      await withRooms(async ({ x }) => {
        const hb = hear(b);
        const hc = hear(c);
        await sendFrames(() =>
          a.sendWhisper(FRAME, { channels: [x], clients: [idOf(c)] }, Codec.OpusVoice),
        );
        hb.stop();
        hc.stop();
        console.log("channel + client whisper: b", hb.count(), "c", hc.count());
        expect(hb.count()).toBeGreaterThan(0);
        expect(hc.count()).toBeGreaterThan(0);
      });
    },
    45_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "sendGroupWhisper to a server group — a member hears it, a non-member does not (needs a query endpoint)",
    async () => {
      const q = adminExec();
      await withRooms(async () => {
        const group: ServerGroupID = await createServerGroup(q, `vf-sg-${RUN}`, GroupType.Regular);
        const bDB = await dbidOf(b);
        try {
          await addClientToServerGroup(q, group, bDB);
          const hb = hear(b);
          const hc = hear(c);
          await sendFrames(() =>
            a.sendGroupWhisper(
              FRAME,
              { type: GroupWhisperType.ServerGroup, scope: GroupWhisperScope.AllChannels, group },
              Codec.OpusVoice,
            ),
          );
          hb.stop();
          hc.stop();
          console.log("server group whisper: member", hb.count(), "non-member", hc.count());
          expect(hb.count()).toBeGreaterThan(0);
          expect(hc.count()).toBe(0);
        } finally {
          await removeClientFromServerGroup(q, group, bDB).catch(() => {});
          await deleteServerGroup(q, group, { force: true }).catch(() => {});
        }
      });
    },
    60_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "sendGroupWhisper to a channel group — a holder hears it, another client does not (needs a query endpoint)",
    async () => {
      const q = adminExec();
      await withRooms(async ({ x }) => {
        const group: ChannelGroupID = await createChannelGroup(
          q,
          `vf-cg-${RUN}`,
          GroupType.Regular,
        );
        const bDB = await dbidOf(b);
        try {
          await setClientChannelGroup(q, group, x, bDB);
          await sleep(500);
          const hb = hear(b);
          const hc = hear(c);
          await sendFrames(() =>
            a.sendGroupWhisper(
              FRAME,
              {
                type: GroupWhisperType.ChannelGroup,
                scope: GroupWhisperScope.AllChannels,
                group,
              },
              Codec.OpusVoice,
            ),
          );
          hb.stop();
          hc.stop();
          console.log("channel group whisper: holder", hb.count(), "other", hc.count());
          expect(hb.count()).toBeGreaterThan(0);
          expect(hc.count()).toBe(0);
        } finally {
          await deleteChannelGroup(q, group, { force: true }).catch(() => {});
        }
      });
    },
    60_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "sendGroupWhisper to every client — both hear it; scope CurrentChannel reaches only the sender's channel (needs a query endpoint)",
    async () => {
      await withRooms(async () => {
        const hb = hear(b);
        const hc = hear(c);
        await sendFrames(() =>
          a.sendGroupWhisper(
            FRAME,
            { type: GroupWhisperType.AllClients, scope: GroupWhisperScope.AllChannels },
            Codec.OpusVoice,
          ),
        );
        console.log("all clients, all channels: b", hb.count(), "c", hc.count());
        expect(hb.count()).toBeGreaterThan(0);
        expect(hc.count()).toBeGreaterThan(0);

        hb.reset();
        hc.reset();
        await sendFrames(() =>
          a.sendGroupWhisper(
            FRAME,
            { type: GroupWhisperType.AllClients, scope: GroupWhisperScope.CurrentChannel },
            Codec.OpusVoice,
          ),
        );
        hb.stop();
        hc.stop();
        console.log("all clients, current channel: b", hb.count(), "c", hc.count());
        expect(hb.count()).toBe(0);
        expect(hc.count()).toBe(0);
      });
    },
    60_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "privilegeKey — a fresh client joins with the key's group and the key is spent (needs a query endpoint)",
    async () => {
      const q = adminExec();
      const group = await makeServerGroup(q, `vf-key-${RUN}`);
      let token: string | undefined;
      let joiner: Client | undefined;
      try {
        token = await addPrivilegeKey(q, { serverGroupID: group, description: `vf-${RUN}` });
        expect((await listPrivilegeKeys(q)).some((k) => k.token === token)).toBe(true);
        joiner = await connectClient(`ts-js-vfk-${RUN}`, { privilegeKey: token });
        const dbid = await dbidOf(joiner);
        const groups = await getServerGroupsByClient(q, dbid);
        console.log(
          "joiner groups:",
          groups.map((g) => g.name),
        );
        expect(groups.map((g) => g.id)).toContain(group);
        expect((await listPrivilegeKeys(q)).some((k) => k.token === token)).toBe(false);
        token = undefined;
      } finally {
        await joiner?.disconnect().catch(() => {});
        if (token !== undefined) await deletePrivilegeKey(q, token).catch(() => {});
        await deleteServerGroup(q, group, { force: true }).catch(() => {});
      }
    },
    45_000,
  );

  describe("a client that joins with meta data and leaves with a message", () => {
    let e: Client | undefined;
    let eID: ClientID;

    beforeAll(async () => {
      const entered = nextEvent(a, "clientEnter", (ev) => ev.nickname.startsWith("ts-js-vfe-"));
      e = await connectClient(`ts-js-vfe-${RUN}`, { metaData: `joined-${RUN}` });
      eID = idOf(e);
      await entered.catch(() => undefined);
    }, 30_000);

    afterAll(async () => {
      await e?.disconnect().catch(() => {});
    });

    it("metaData — a bystander has what the client joined with", () => {
      const seen = clientInternals(a).clients.get(eID);
      console.log("metaData on enter:", seen?.metaData);
      expect(seen?.metaData).toBe(`joined-${RUN}`);
    });

    it("updateClient metaData — a bystander's clientUpdated carries it", async () => {
      const changed = nextEvent(
        a,
        "clientUpdated",
        (ev) => ev.clientID === eID && "metaData" in ev.changes,
      );
      await updateClient(e!, { metaData: `changed-${RUN}` });
      const event = await changed;
      expect(event.changes.metaData).toBe(`changed-${RUN}`);
      expect(clientInternals(a).clients.get(eID)?.metaData).toBe(`changed-${RUN}`);
    }, 20_000);

    it("disconnect reasonMessage — a bystander's clientLeave carries it", async () => {
      const left = nextEvent(a, "clientLeave", (ev) => ev.clientID === eID);
      await e!.disconnect({ reasonMessage: `back soon ${RUN}` });
      const event = await left;
      console.log("clientLeave:", event.reason, JSON.stringify(event.reasonMessage));
      expect(event.reasonMessage).toBe(`back soon ${RUN}`);
    }, 20_000);
  });

  it("connection info — a client answers the request with its own figures, and another reads them", async () => {
    // The keepalive round trip is measured once a pong has come back.
    for (let i = 0; i < 120 && clientInternals(b).handler.roundTrip === null; i++) await sleep(100);
    const own = clientInternals(b).handler.roundTrip;
    console.log("b's own round trip:", own);
    expect(own).not.toBeNull();

    // The first ask makes the server ask b; b answers; the second read sees it.
    await getClientConnectionInfo(a, idOf(b));
    await sleep(1_500);
    const info = await getClientConnectionInfo(a, idOf(b));
    console.log("b's info as read by a:", JSON.stringify(info));
    const traffic = clientInternals(b).handler.trafficSnapshot();
    expect(info.id).toBe(idOf(b));
    expect(info.pingMs).toBeGreaterThan(0);
    expect(info.pingMs).toBeLessThan(500);
    expect(info.sent.control.packets).toBeGreaterThan(0);
    expect(info.sent.control.packets).toBeLessThanOrEqual(traffic.sent.control.packets);
    expect(info.received.control.bytes).toBeGreaterThan(0);
    expect(info.received.control.bytes).toBeLessThanOrEqual(traffic.received.control.bytes);
    expect(info.sent.keepalive.packets).toBeGreaterThan(0);
    expect(info.connectedTimeMs).toBeGreaterThan(0);
    expect(info.ip).toBeTypeOf("string");
    expect(info.port).toBeGreaterThan(0);
  }, 45_000);

  it("muteClients — the server stops sending the muted client's voice to the muter alone, until unmuteClients", async () => {
    const heardByA = hear(a);
    const heardByC = hear(c);
    const sendFromB = (): Promise<void> =>
      sendFrames(() => b.sendVoice(FRAME, Codec.OpusVoice), 40);
    try {
      // Positive control: without it, a silent listener proves nothing.
      await sendFromB();
      console.log("before mute: a", heardByA.count(), "c", heardByC.count());
      expect(heardByA.count()).toBeGreaterThan(0);
      expect(heardByC.count()).toBeGreaterThan(0);

      await muteClients(a, [idOf(b)]);
      heardByA.reset();
      heardByC.reset();
      await sendFromB();
      console.log("muted: a", heardByA.count(), "c", heardByC.count());
      expect(heardByA.count()).toBe(0);
      expect(heardByC.count()).toBeGreaterThan(0);

      await unmuteClients(a, [idOf(b)]);
      heardByA.reset();
      await sendFromB();
      console.log("unmuted: a", heardByA.count());
      expect(heardByA.count()).toBeGreaterThan(0);

      // Several clients in one command.
      await muteClients(a, [idOf(b), idOf(c)]);
      heardByA.reset();
      await sendFromB();
      await sendFrames(() => c.sendVoice(FRAME, Codec.OpusVoice), 40);
      console.log("both muted: a", heardByA.count());
      expect(heardByA.count()).toBe(0);
    } finally {
      await unmuteClients(a, [idOf(b), idOf(c)]).catch(() => {});
      heardByA.stop();
      heardByC.stop();
    }
  }, 60_000);

  it.skipIf(SERVER_PASSWORD === "")(
    "verifyServerPassword — true for the password, false for another",
    async () => {
      expect(await verifyServerPassword(a, SERVER_PASSWORD)).toBe(true);
      expect(await verifyServerPassword(a, `${SERVER_PASSWORD}-wrong`)).toBe(false);
    },
  );

  it.skipIf(PASSWORD_CHANNEL === "" || PASSWORD_CHANNEL_PASSWORD === "")(
    "verifyChannelPassword — true for the password, false for another, an unknown channel throws",
    async () => {
      const secret = (await listChannels(a)).find((ch) => ch.name === PASSWORD_CHANNEL)!;
      expect(await verifyChannelPassword(a, secret.id, PASSWORD_CHANNEL_PASSWORD)).toBe(true);
      expect(await verifyChannelPassword(a, secret.id, "not-the-password")).toBe(false);
      await expect(verifyChannelPassword(a, asChannelID(999_999n), "x")).rejects.toMatchObject({
        code: 768,
      });
      // The check does not move the client.
      expect(a.channelID).toBe(home);
    },
  );

  it.skipIf(!HAS_ADMIN)(
    "createChannel — finds the channel by name and parent when the answer has no data (needs a query endpoint)",
    async () => {
      const q = adminExec();
      // The server really creates the channel; the answer is emptied on the way back.
      const forgetful: CommandExecutor = {
        send: async (request, options) => {
          const rows = await q.send(request, options);
          return request.command === "channelcreate" ? [] : rows;
        },
      };
      const name = `vf-lost-${RUN}`;
      const parent = await createChannel(q, { name: `vf-parent-${RUN}`, isPermanent: true });
      let found: ChannelID | undefined;
      try {
        found = await createChannel(forgetful, { name, parentID: parent, isPermanent: true });
        const listed = (await listChannels(q)).find((ch) => ch.name === name);
        console.log("recovered channel id:", found, "listed:", listed?.id);
        expect(found).toBe(listed?.id);
        expect(listed?.parentID).toBe(parent);
      } finally {
        if (found !== undefined) await deleteChannel(q, found, { force: true }).catch(() => {});
        await deleteChannel(q, parent, { force: true }).catch(() => {});
      }
    },
    30_000,
  );
});
