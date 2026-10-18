/**
 * Live tests of the fields and events the audit added: the channel a client
 * came from and went to, the closed-chat event, ban updates, the token-used
 * category, the talk request time, a channel's empty time, and the dropped
 * fields of the client database, lookups, `whoami`, `serverlist` and the
 * temporary password list.
 *
 * Opt-in like the rest of the integration suite: they run when TEAMSPEAK_ADDR
 * and a query endpoint are set. Events are read from a raw TCP connection
 * where the fixture has one (TS3) and from SSH otherwise (TS6).
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/query/audit-fields.integration.test.ts --reporter=verbose
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GroupType,
  addPrivilegeKey,
  addTempPassword,
  closePrivateChat,
  createChannel,
  deleteChannel,
  deleteTempPassword,
  createServerGroup,
  deleteServerGroup,
  findClientDatabase,
  getChannelInfo,
  getClientDatabaseInfo,
  getClientNameByDBID,
  getClientUIDInfoByID,
  listChannels,
  listClientDatabase,
  listServers,
  listServerGroups,
  listTempPasswords,
  moveClient,
  NoDataError,
  NotificationName,
  Reason,
  sendPrivateMessage,
  updateClient,
  whoAmI,
  addBan,
  deleteBan,
  listBans,
} from "@honeybbq/teamspeak";
import type {
  ClientEnterEvent,
  ChannelID,
  ClientChatClosedEvent,
  ClientLeaveEvent,
  ClientMovedEvent,
  CommandExecutor,
  ServerGroupID,
  NotificationEvent,
} from "@honeybbq/teamspeak";
import { Client } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { QueryClient } from "./client.js";
import type { QueryClientOptions } from "./options.js";
import { connectSsh } from "./ssh.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const FAMILY = process.env["TEAMSPEAK_QUERY_FAMILY"] ?? "";
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const SSH_PORT = Number(process.env["TEAMSPEAK_QUERY_SSH_PORT"] ?? "0");
const SSH_HOST = process.env["TEAMSPEAK_QUERY_SSH_HOST"] ?? "127.0.0.1";
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";
const HAS_EVENTS = QUERY_KIND === "tcp" || SSH_PORT > 0;
const SKIP = !ADDR || !HAS_ADMIN || !HAS_EVENTS;
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    nickname: `ts-js-af-admin-${RUN}`,
  };
}

/** A query client that receives events: raw TCP when the fixture has it, SSH against the key the server presents otherwise. */
async function eventOptions(
  scratch: string,
  categories: QueryClientOptions["events"],
): Promise<QueryClientOptions> {
  if (QUERY_KIND === "tcp") return { ...adminOptions(), events: categories };
  let presented: { keyType: string; key: Uint8Array } | undefined;
  await connectSsh({
    host: SSH_HOST,
    port: SSH_PORT,
    username: process.env["TEAMSPEAK_QUERY_SSH_USER"] ?? "",
    password: process.env["TEAMSPEAK_QUERY_SSH_PASSWORD"] ?? "",
    hostKey: (key) => {
      presented = key;
      throw new Error("recorded, and not trusted yet");
    },
  }).catch(() => {});
  if (presented === undefined) throw new Error("the SSH server sent no key");
  const knownHosts = join(scratch, "known_hosts");
  writeFileSync(
    knownHosts,
    `[${SSH_HOST}]:${SSH_PORT} ${presented.keyType} ${Buffer.from(presented.key).toString("base64")}\n`,
  );
  return {
    transport: {
      kind: "ssh",
      host: SSH_HOST,
      port: SSH_PORT,
      username: process.env["TEAMSPEAK_QUERY_SSH_USER"] ?? "",
      password: process.env["TEAMSPEAK_QUERY_SSH_PASSWORD"] ?? "",
      knownHosts,
    },
    server: { id: 1 },
    nickname: `ts-js-af-ev-${RUN}`,
    events: categories,
  };
}

async function makeChannel(
  q: CommandExecutor,
  name: string,
  extra: Partial<Parameters<typeof createChannel>[1]> = {},
): Promise<ChannelID> {
  try {
    return await createChannel(q, { name, isPermanent: true, ...extra });
  } catch (error) {
    if (!(error instanceof NoDataError)) throw error;
    const found = (await listChannels(q)).find((c) => c.name === name);
    if (found === undefined) throw error;
    return found.id;
  }
}

function collect<T>(subscribe: (listener: (e: T) => void) => () => void): {
  items: T[];
  next: (match: (e: T) => boolean, ms?: number) => Promise<T>;
} {
  const items: T[] = [];
  subscribe((e) => items.push(e));
  return {
    items,
    async next(match, ms = 8_000) {
      const until = Date.now() + ms;
      for (;;) {
        const found = items.find(match);
        if (found !== undefined) return found;
        if (Date.now() > until) throw new Error("the event did not arrive");
        await sleep(20);
      }
    },
  };
}

describe.skipIf(SKIP)("Audit fields and events — live", () => {
  const scratch = mkdtempSync(join(tmpdir(), "audit-fields-"));
  let admin: QueryClient;
  let events: QueryClient;
  let privileged: Client;
  let plain: Client;
  const channels: ChannelID[] = [];

  async function connectVoice(nick: string, privilegeKey = ""): Promise<Client> {
    const c = new Client(generateIdentitySync(8), ADDR!, `${nick}-${RUN}`, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      privilegeKey,
    });
    await c.connect({ signal: AbortSignal.timeout(15_000) });
    await sleep(2_200);
    return c;
  }

  beforeAll(async () => {
    admin = new QueryClient(adminOptions());
    await admin.connect({ signal: AbortSignal.timeout(15_000) });
    events = new QueryClient(await eventOptions(scratch, true));
    await events.connect({ signal: AbortSignal.timeout(15_000) });
    const group = (await listServerGroups(admin)).find(
      (g) => g.name === "Server Admin" && g.type === GroupType.Regular,
    );
    if (group === undefined) throw new Error("the server has no Server Admin group");
    privileged = await connectVoice(
      "ts-js-afp",
      await addPrivilegeKey(admin, { serverGroupID: group.id }),
    );
    plain = await connectVoice("ts-js-afq");
  }, 90_000);

  afterAll(async () => {
    await plain?.disconnect().catch(() => {});
    await privileged?.disconnect().catch(() => {});
    for (const id of channels) await deleteChannel(admin, id, { force: true }).catch(() => {});
    await events?.disconnect().catch(() => {});
    await admin?.disconnect().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  it("a move names the channel it came from where the server sends it, and a leave names both", async () => {
    const target = await makeChannel(admin, `af-move-${RUN}`);
    channels.push(target);
    const moves = collect<ClientMovedEvent>((l) => events.on("clientMoved", l));
    const leaves = collect<ClientLeaveEvent>((l) => events.on("clientLeave", l));
    const homeID = plain.channelID;
    await moveClient(privileged, plain.clientID, target);
    const moved = await moves.next(
      (e) => e.clientID === plain.clientID && e.targetChannelID === target,
    );
    console.log("move fromChannelID:", moved.fromChannelID, "family:", FAMILY);
    if (FAMILY === "ts6") expect(moved.fromChannelID).toBe(BigInt(homeID));
    if (FAMILY === "ts3") expect(moved.fromChannelID).toBeUndefined();

    await plain.disconnect();
    const left = await leaves.next((e) => e.clientID === moved.clientID);
    console.log("leave from/target:", left.fromChannelID, left.targetChannelID);
    expect(left.fromChannelID).toBe(target);
    expect(left.targetChannelID).toBe(0n);
    plain = await connectVoice("ts-js-afq");
  }, 60_000);

  it("a closed private chat reaches the voice client as clientChatClosed", async () => {
    const closed = collect<ClientChatClosedEvent>((l) => privileged.on("clientChatClosed", l));
    await sendPrivateMessage(plain, privileged.clientID, "hi");
    await sleep(300);
    await closePrivateChat(plain, privileged.clientID);
    const event = await closed.next((e) => e.clientID === plain.clientID);
    expect(event.uid).toBe(plain.uid);
  }, 30_000);

  it("a talk request carries the time it was made", async () => {
    const id = await makeChannel(admin, `af-tp-${RUN}`, { neededTalkPower: 100 });
    channels.push(id);
    await moveClient(privileged, plain.clientID, id);
    await moveClient(privileged, privileged.clientID, id);
    await sleep(500);
    const updates = collect<{ clientID: number; changes: { talkRequestedAt?: Date | undefined } }>(
      (l) => privileged.on("clientUpdated", l),
    );
    const before = Date.now();
    await updateClient(plain, { isRequestingTalk: true, talkRequestMessage: "pls" });
    const asked = await updates.next(
      (e) => e.clientID === plain.clientID && e.changes.talkRequestedAt !== undefined,
    );
    const at = asked.changes.talkRequestedAt!.getTime();
    console.log("talkRequestedAt:", asked.changes.talkRequestedAt);
    expect(Math.abs(at - before)).toBeLessThan(10_000);
    await updateClient(plain, { isRequestingTalk: false, talkRequestMessage: "" });
  }, 30_000);

  it("a channel with a client has no empty time, an empty one has", async () => {
    const id = await makeChannel(admin, `af-empty-${RUN}`);
    channels.push(id);
    await sleep(1_200);
    const empty = await getChannelInfo(admin, id);
    console.log("emptyForMs of an empty channel:", empty.emptyForMs, "filePath:", empty.filePath);
    expect(empty.emptyForMs).toBeGreaterThanOrEqual(0);
    expect(empty.filePath).toContain("channel_");
    const all = await listChannels(admin);
    const occupied = all.find((c) => c.id === BigInt(privileged.channelID));
    console.log("emptyForMs of an occupied channel:", occupied?.emptyForMs);
    expect(occupied?.emptyForMs).toBeUndefined();
    if (FAMILY === "ts6") expect(empty.storageQuota).toBeGreaterThan(0);
  }, 30_000);

  it("the client database reports the avatar hash, traffic totals and login name", async () => {
    const found = await findClientDatabase(admin, `ts-js-afp-${RUN}`);
    const dbid = found[0]!;
    const info = await getClientDatabaseInfo(admin, dbid);
    console.log("dbinfo:", info.avatarHash, info.totalBytesUploaded, info.monthBytesDownloaded);
    expect(info.avatarHash).toBeDefined();
    expect(info.totalBytesUploaded).toBeGreaterThanOrEqual(0);
    expect(info.totalBytesDownloaded).toBeGreaterThanOrEqual(0);
    expect(info.monthBytesUploaded).toBeGreaterThanOrEqual(0);
    expect(info.monthBytesDownloaded).toBeGreaterThanOrEqual(0);
    const list = await listClientDatabase(admin, { limit: 5 });
    expect(list[0]?.loginName).toBeDefined();
    expect(list[0]?.avatarHash).toBeUndefined();
    const name = await getClientNameByDBID(admin, dbid);
    expect(name.uid).toBe(privileged.uid);
  }, 30_000);

  it("clientgetuidfromclid gives the nickname and myTeamSpeak id", async () => {
    const info = await getClientUIDInfoByID(admin, plain.clientID);
    expect(info.uid).toBe(plain.uid);
    expect(info.nickname).toBe(`ts-js-afq-${RUN}`);
    expect(info.mytsid).toBe("");
  });

  it("whoami and serverlist report the TS6-only fields there and not on TS3", async () => {
    const me = await whoAmI(admin);
    const servers = await listServers(admin, { uid: true });
    console.log("whoami uuid:", me.serverUUID, "origin:", me.originServerID, "server:", servers[0]);
    expect(me.originServerID).toBeGreaterThanOrEqual(0n);
    if (FAMILY === "ts6") {
      expect(me.serverUUID).toMatch(/^[0-9a-f-]{36}$/);
      expect(servers[0]?.uuid).toBe(me.serverUUID);
      expect(typeof servers[0]?.guestCanCreateChannels).toBe("boolean");
      expect(typeof servers[0]?.weblistEnabled).toBe("boolean");
    } else {
      expect(me.serverUUID).toBeUndefined();
      expect(servers[0]?.uuid).toBeUndefined();
    }
  });

  it("a temporary password lists its target channel password", async () => {
    const pw = `af-${RUN}`;
    await addTempPassword(admin, {
      password: pw,
      description: "audit",
      durationMs: 60_000,
      targetChannelID: channels[0]!,
      targetChannelPassword: "chanpw",
    });
    try {
      const listed = (await listTempPasswords(admin)).find((t) => t.password === pw);
      expect(listed?.targetChannelPassword).toBe("chanpw");
    } finally {
      await deleteTempPassword(admin, pw).catch(() => {});
    }
  });

  it("an enter event says where the client came from and why", async () => {
    // Someone is already in the channel the new client lands in.
    const landing = (await listChannels(admin)).find((c) => c.name === DEFAULT_CHANNEL)!;
    await moveClient(privileged, privileged.clientID, landing.id);
    await sleep(500);
    const entered: ClientEnterEvent[] = [];
    const seenByQuery = collect<ClientEnterEvent>((l) => events.on("clientEnter", l));
    const joiner = new Client(generateIdentitySync(8), ADDR!, `ts-js-afe-${RUN}`, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    joiner.on("clientEnter", (e) => entered.push(e));
    try {
      await joiner.connect({ signal: AbortSignal.timeout(15_000) });
      // Events are delivered after the connect settles.
      await sleep(1_000);
      const own = entered.find((e) => e.id === joiner.clientID);
      const others = entered.filter((e) => e.id !== joiner.clientID);
      console.log(
        "own enter:",
        own?.fromChannelID,
        own?.reason,
        "others:",
        others.map((e) => e.reason),
      );
      // Measured on both servers: the welcome lists every client in view,
      // this one included, as a subscription; only a client that joins while
      // another is watching comes in with reason 0.
      expect(own?.reason).toBe(Reason.Subscription);
      expect(own?.fromChannelID ?? 0n).toBe(0n);
      expect(others.length).toBeGreaterThan(0);
      for (const other of others) expect(other.reason).toBe(Reason.Subscription);
      const joined = await seenByQuery.next((e) => e.nickname === `ts-js-afe-${RUN}`);
      expect(joined.reason).toBe(Reason.None);
      expect(joined.fromChannelID ?? 0n).toBe(0n);
      // The records the client keeps carry neither.
      for (const record of joiner.view.clients.values()) {
        expect("reason" in record).toBe(false);
        expect("fromChannelID" in record).toBe(false);
      }
    } finally {
      await joiner.disconnect().catch(() => {});
    }
  }, 45_000);

  it.skipIf(FAMILY !== "ts6")(
    "a ban update reaches notification with its name when bans is registered",
    async () => {
      const bans = new QueryClient(await eventOptions(scratch, { categories: ["bans"] }));
      await bans.connect({ signal: AbortSignal.timeout(15_000) });
      try {
        const raw = collect<NotificationEvent>((l) => bans.on("notification", l));
        const name = `af-ban-${RUN}`;
        await addBan(admin, { name, reason: "audit" });
        const id = (await listBans(admin)).find((b) => b.name === name)!.id;
        const added = await raw.next((n) => n.name === NotificationName.BanUpdate);
        console.log("banupdate params:", added.params["op"], Object.keys(added.params).length);
        await deleteBan(admin, id);
        await raw.next((n) => n.name === NotificationName.BanUpdate && n.params["op"] === "del");
      } finally {
        await bans.disconnect().catch(() => {});
      }
    },
    45_000,
  );

  it("the tokenused category registers on both servers and delivers notifytokenused", async () => {
    const used = new QueryClient(await eventOptions(scratch, { categories: ["tokenused"] }));
    await used.connect({ signal: AbortSignal.timeout(15_000) });
    let joiner: Client | undefined;
    let group: ServerGroupID | undefined;
    try {
      const seen = collect<NotificationEvent>((l) => used.on("notification", l));
      group = await createServerGroup(admin, `af-tok-${RUN}`, GroupType.Regular);
      const token = await addPrivilegeKey(admin, { serverGroupID: group });
      joiner = await connectVoice("ts-js-aft", token);
      const note = await seen.next((n) => n.name === "notifytokenused");
      expect(Object.keys(note.params)).toEqual(
        expect.arrayContaining(["clid", "cldbid", "cluid", "token", "token1", "token2"]),
      );
    } finally {
      await joiner?.disconnect().catch(() => {});
      if (group !== undefined)
        await deleteServerGroup(admin, group, { force: true }).catch(() => {});
      await used.disconnect().catch(() => {});
    }
  }, 60_000);
});
