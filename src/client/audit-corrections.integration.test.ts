/**
 * Live tests of the corrections to what the SDK sends and reads: `findBans` on
 * a voice client, `listClients` with `-icon`, a channel banner written on
 * create and edit, and the host message mode in the capabilities.
 *
 * Opt-in like the rest of the integration suite: they run when TEAMSPEAK_ADDR
 * and a query endpoint are set. A voice client given a Server Admin privilege
 * key does the voice-side calls, because a fresh client has no permissions.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/client/audit-corrections.integration.test.ts --reporter=verbose
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GroupType,
  HostMessageMode,
  addBan,
  addPrivilegeKey,
  createChannel,
  deleteBan,
  deleteChannel,
  editChannel,
  findBans,
  findClientDatabaseByUID,
  getChannelInfo,
  listBans,
  listChannels,
  listClients,
  listServerGroups,
  NoDataError,
} from "@honeybbq/teamspeak";
import type { BanID, ChannelID, CommandExecutor } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const FAMILY = process.env["TEAMSPEAK_QUERY_FAMILY"] ?? "";
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";
const SKIP = !ADDR || !HAS_ADMIN;
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
    nickname: `ts-js-ac-admin-${RUN}`,
  };
}

/** `channelcreate` has answered with no data on a success; the channel is then looked up by name. */
async function makeChannel(q: CommandExecutor, name: string): Promise<ChannelID> {
  try {
    return await createChannel(q, { name });
  } catch (error) {
    if (!(error instanceof NoDataError)) throw error;
    const found = (await listChannels(q)).find((c) => c.name === name);
    if (found === undefined) throw error;
    return found.id;
  }
}

describe.skipIf(SKIP)("Audit corrections — live", () => {
  let admin: QueryClient;
  let voice: Client;
  const channels: ChannelID[] = [];
  const bans: BanID[] = [];

  beforeAll(async () => {
    admin = new QueryClient(adminOptions());
    await admin.connect({ signal: AbortSignal.timeout(15_000) });
    const group = (await listServerGroups(admin)).find(
      (g) => g.name === "Server Admin" && g.type === GroupType.Regular,
    );
    if (group === undefined) throw new Error("the server has no Server Admin group");
    const token = await addPrivilegeKey(admin, { serverGroupID: group.id });
    voice = new Client(generateIdentitySync(8), ADDR!, `ts-js-ac-${RUN}`, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      privilegeKey: token,
    });
    await voice.connect({ signal: AbortSignal.timeout(15_000) });
  }, 60_000);

  afterAll(async () => {
    await voice?.disconnect().catch(() => {});
    for (const id of bans) await deleteBan(admin, id).catch(() => {});
    for (const id of channels) await deleteChannel(admin, id, { force: true }).catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 30_000);

  it("types the host message mode", () => {
    const mode = voice.serverCapabilities.hostMessageMode;
    console.log("hostMessageMode:", mode);
    expect(Object.values(HostMessageMode)).toContain(mode);
  });

  it.skipIf(FAMILY !== "ts6")(
    "findBans over the voice protocol returns the bans that match",
    async () => {
      const name = `ac-ban-${RUN}`;
      // The voice protocol's banadd answers without the new ban's id here.
      await addBan(voice, { name, reason: "audit" });
      const listed = await listBans(voice);
      const made = listed.find((b) => b.name === name);
      expect(made).toBeDefined();
      bans.push(made!.id);
      const found = await findBans(voice, { name });
      console.log("banfind rows:", found.length);
      expect(found.map((b) => b.id)).toEqual([made!.id]);
    },
    30_000,
  );

  it("finds a database record by uid over the voice protocol", async () => {
    const uid = voice.uid;
    const [found] = await findClientDatabaseByUID(voice, uid);
    expect(found).toBeDefined();
    expect(await findClientDatabaseByUID(voice, uid.toLowerCase())).toEqual([found]);
    expect(await findClientDatabaseByUID(voice, `${uid.slice(0, 8)}%`)).toContain(found);
    expect(await findClientDatabaseByUID(voice, uid.slice(0, 8))).toEqual([]);
  });

  it("lists clients with -icon", async () => {
    const entries = await listClients(voice, { icon: true });
    expect(entries.some((e) => e.id === voice.clientID)).toBe(true);
  });

  it("writes the channel banner on create and edit, and reads it back", async () => {
    const id = await makeChannel(admin, `ac-banner-${RUN}`);
    channels.push(id);
    await editChannel(voice, id, { bannerURL: "https://example.com/banner.png", bannerMode: 2 });
    const info = await getChannelInfo(voice, id);
    console.log("banner:", info.bannerURL, info.bannerMode);
    expect(info.bannerURL).toBe("https://example.com/banner.png");
    expect(info.bannerMode).toBe(2);

    const created = await createChannel(voice, {
      name: `ac-banner2-${RUN}`,
      bannerURL: "https://example.com/two.png",
      bannerMode: 1,
    });
    channels.push(created);
    const second = await getChannelInfo(voice, created);
    console.log("created banner:", second.bannerURL, second.bannerMode);
    expect(second.bannerURL).toBe("https://example.com/two.png");
    expect(second.bannerMode).toBe(1);
  }, 30_000);
});
