/**
 * Live tests of the avatar and icon helpers. Opt-in: they run when
 * TEAMSPEAK_ADDR is set. Uploading an icon needs b_icon_manage and setting one
 * needs the fixture's query endpoint, so those skip without it.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/client/avatars.integration.test.ts --reporter=verbose
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPrivilegeKey,
  createChannel,
  deleteChannel,
  deletePrivilegeKey,
  getChannelInfo,
  listFiles,
  listServerGroups,
  GroupType,
  asChannelID,
  avatarFileName,
  deleteFile,
  iconIDOf,
  setChannelIcon,
} from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import {
  downloadAvatar,
  downloadIcon,
  removeAvatar,
  uploadAvatar,
  uploadIcon,
} from "./api/avatars.js";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";
import type { EventMap } from "./types.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = KIND === "tcp" || KIND === "web";
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function adminOptions(): QueryClientOptions {
  if (KIND === "web") {
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
    nickname: `ts-js-av-admin-${RUN}`,
  };
}

async function connect(nickname: string, privilegeKey = ""): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "",
    defaultChannel: process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "",
    privilegeKey,
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

function nextEvent<K extends keyof EventMap>(
  client: Client,
  name: K,
  match: (payload: EventMap[K]) => boolean,
): Promise<EventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${name} event arrived`));
    }, 8_000);
    const off = (client.on as (n: K, l: (p: EventMap[K]) => void) => () => void)(name, (p) => {
      if (!match(p)) return;
      clearTimeout(timer);
      off();
      resolve(p);
    });
  });
}

describe.skipIf(!ADDR || !HAS_ADMIN)("Avatars and icons — live", () => {
  let admin: QueryClient;
  let owner: Client; // a Server Admin, so it may manage icons
  let bystander: Client;
  let token: string | undefined;

  beforeAll(async () => {
    admin = new QueryClient(adminOptions());
    await admin.connect({ signal: AbortSignal.timeout(15_000) });
    const group = (await listServerGroups(admin)).find(
      (g) => g.type === GroupType.Regular && /server admin/i.test(g.name),
    )!;
    token = await addPrivilegeKey(admin, { serverGroupID: group.id, description: `av-${RUN}` });
    owner = await connect(`ts-js-ava-${RUN}`, token);
    token = undefined;
    bystander = await connect(`ts-js-avb-${RUN}`);
  }, 60_000);

  afterAll(async () => {
    await removeAvatar(owner).catch(() => {});
    if (token !== undefined) await deletePrivilegeKey(admin, token).catch(() => {});
    await owner?.disconnect().catch(() => {});
    await bystander?.disconnect().catch(() => {});
    await admin?.disconnect().catch(() => {});
  });

  it("uploads an avatar that a bystander sees flagged and downloads byte for byte", async () => {
    const data = Buffer.from(`not really a picture ${RUN}`);
    const md5 = createHash("md5").update(data).digest("hex");
    const seen = nextEvent(
      bystander,
      "clientUpdated",
      (e) => e.clientID === owner.clientID && e.changes.avatar === md5,
    );
    expect(await uploadAvatar(owner, data)).toBe(md5);
    await seen;

    const stored = (await listFiles(owner, asChannelID(0n), "/")).map((f) => f.name);
    expect(stored).toContain(avatarFileName(owner.uid));

    const got = await downloadAvatar(bystander, owner.uid);
    expect(got && Buffer.from(got).equals(data)).toBe(true);

    expect(await removeAvatar(owner)).toBe(true);
    expect(await downloadAvatar(bystander, owner.uid)).toBeUndefined();
    expect(await removeAvatar(owner)).toBe(false);
  }, 40_000);

  it("refuses an avatar over the size limit without changing anything", async () => {
    await expect(uploadAvatar(owner, Buffer.alloc(200_001, 1))).rejects.toMatchObject({
      code: 2565,
    });
    expect(await downloadAvatar(bystander, owner.uid)).toBeUndefined();
  }, 20_000);

  it("uploads an icon, sets it on a channel and reads it back", async () => {
    const data = Buffer.from(`\x89PNG icon ${RUN}`);
    const id = await uploadIcon(owner, data);
    expect(id).toBe(iconIDOf(data));
    const cid = await createChannel(admin, { name: `ts-js-icon-${RUN}` });
    try {
      await setChannelIcon(admin, cid, id);
      expect((await getChannelInfo(admin, cid)).iconID).toBe(id);
      const got = await downloadIcon(bystander, id);
      expect(got && Buffer.from(got).equals(data)).toBe(true);
      await setChannelIcon(admin, cid, undefined);
      expect((await getChannelInfo(admin, cid)).iconID).toBeUndefined();
    } finally {
      await deleteChannel(admin, cid, { force: true }).catch(() => {});
      await deleteFile(owner, asChannelID(0n), `/icons/icon_${id}`).catch(() => {});
      await owner.exec(`ftdeletefile cid=0 cpw= name=\\/icon_${id}`).catch(() => {});
    }
  }, 40_000);

  it("refuses an icon over the size limit", async () => {
    await expect(uploadIcon(owner, Buffer.alloc(8193, 1))).rejects.toMatchObject({ code: 2565 });
  }, 20_000);
});
