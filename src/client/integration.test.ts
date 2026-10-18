import { clientInternals } from "./client.js";
/**
 * Integration tests against a live TeamSpeak 3 server.
 *
 * Opt-in: these tests only run when TEAMSPEAK_ADDR is set:
 *
 *   docker run -d --name ts3 -e TS3SERVER_LICENSE=accept -p 9987:9987/udp teamspeak:latest
 *   TEAMSPEAK_ADDR=127.0.0.1:9987 pnpm test --reporter=verbose src/integration.test.ts
 *
 * A single shared client is reused across all tests to avoid the TS3
 * anti-flood protection that bans IPs reconnecting too quickly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import { generateIdentitySync } from "./crypto/identity.js";
import { Client } from "./client.js";
import type { ClientTrace } from "./trace.js";
import { Readable, Writable } from "node:stream";
import {
  ClientStatus,
  listChannels,
  getChannelInfo,
  createChannel,
  editChannel,
  moveChannel,
  deleteChannel,
  editServer,
  sendChatComposing,
  closePrivateChat,
  sendPluginCommand,
  Reason,
  PropertyName,
} from "@honeybbq/teamspeak";
import type { ChannelID, ServerEventMap } from "@honeybbq/teamspeak";
import { getChannelDescription, subscribeChannel, unsubscribeChannel } from "./api/voice.js";
import {
  listClients,
  getClientProperties,
  moveClient,
  getClientUIDByID,
  getClientDBIDByUID,
  getClientNameByUID,
  getClientNameByDBID,
  getClientIDs,
} from "@honeybbq/teamspeak";
import {
  deleteFile,
  getFileInfo,
  initFileDownload,
  initFileUpload,
  listFiles,
} from "@honeybbq/teamspeak";
import {
  deleteMessage,
  getMessage,
  getOwnPermission,
  listMessages,
  permissionByName,
  sendOfflineMessage,
  sendPrivateMessage,
  whoAmI,
} from "@honeybbq/teamspeak";
import { ErrorCode, getServerInfo, listServerGroups } from "@honeybbq/teamspeak";
import { asChannelID, asClientDBID, asClientID, asUID } from "@honeybbq/teamspeak";
import type { ClientEnterEvent } from "@honeybbq/teamspeak";
import {
  addClientToServerGroup,
  createServerGroup,
  deleteServerGroup,
  listChannelGroups,
  removeClientFromServerGroup,
  setClientChannelGroup,
  updateClient,
  GroupType,
} from "@honeybbq/teamspeak";
import type { ClientID, ServerGroupID } from "@honeybbq/teamspeak";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";
import type { EventMap } from "./types.js";
import { Windows_3_6_3_1701166057 } from "../versions/index.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const DEFAULT_CHANNEL_PASSWORD = process.env["TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const SERVER_HAS_PASSWORD = process.env["TEAMSPEAK_SERVER_HAS_PASSWORD"] === "1";
const SKIP = !ADDR;
const USES_CONNECT_AUTH =
  SERVER_PASSWORD !== "" || DEFAULT_CHANNEL !== "" || DEFAULT_CHANNEL_PASSWORD !== "";

const CONNECT_ATTEMPTS = 3;
const CONNECT_ATTEMPT_MS = 10_000;
const CONNECT_RETRY_DELAY_MS = 2_000;

/**
 * Connect `client`, trying again on the same client when an attempt fails. A
 * datagram can be dropped, or the server too busy to answer one, and the suite
 * should not fail on that. The SDK resends its own handshake packets, so this is
 * a safety net for the suite, not what makes connecting work.
 */
async function connectWithRetries(client: Client): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(CONNECT_ATTEMPT_MS) });
      return;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      console.warn(`connect attempt ${attempt} of ${CONNECT_ATTEMPTS} failed: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

// Shared connection — established once for the entire suite
let sharedClient: Client;
let selfClientEnter: Promise<ClientEnterEvent>;

beforeAll(async () => {
  if (SKIP) return;

  const identity = generateIdentitySync(8);
  const client = new Client(identity, ADDR, "ts-js-integ", {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
    logger: {
      debug: () => {},
      info: (msg, ...args) => console.log("[INFO]", msg, ...args),
      warn: (msg, ...args) => console.warn("[WARN]", msg, ...args),
      error: (msg, ...args) => console.error("[ERROR]", msg, ...args),
    },
  });
  selfClientEnter = new Promise((resolve) => {
    client.on("clientEnter", (info) => {
      if (info.id === client.clientID) resolve(info);
    });
  });

  await connectWithRetries(client);
  // The channel is known once the server has shown us entering it.
  await selfClientEnter;

  sharedClient = client;
}, 50_000);

afterAll(async () => {
  for (const peer of peers.values()) await peer.disconnect().catch(() => {});
  if (!sharedClient) return;
  await sharedClient.disconnect();
}, 20_000);

// Extra connections opened by individual tests. With default settings TS3's
// antiflood only tolerates about three rapid connects from one IP before it
// silently drops new handshakes, so tests share these instead of each opening
// their own. Together with the shared client this keeps the suite at three.
const peers = new Map<string, Client>();

async function connectPeer(nickname: string, setup?: (client: Client) => void): Promise<Client> {
  const peer = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
  });
  setup?.(peer);
  peers.set(nickname, peer);
  await connectWithRetries(peer);
  return peer;
}

describe.skipIf(SKIP)("Integration — live TeamSpeak server", () => {
  it("connects with optional handshake auth configuration", () => {
    if (USES_CONNECT_AUTH) {
      console.log(
        `connect auth enabled: serverPassword=${SERVER_PASSWORD !== ""} defaultChannel=${DEFAULT_CHANNEL !== ""} defaultChannelPassword=${DEFAULT_CHANNEL_PASSWORD !== ""}`,
      );
    }
    expect(sharedClient.clientID).toBeGreaterThan(0);
  });

  // Opt-in: needs a server that actually has a password set, which the fixture
  // provisions. The rejected handshake still counts toward TS3's antiflood
  // budget (about three rapid connects per IP), so with it enabled the suite
  // needs four: the fixture raises virtualserver_antiflood_points_needed_ip_block,
  // without which later tests are banned with id=3329.
  it.skipIf(!SERVER_HAS_PASSWORD)(
    "reports the handshake failure and disconnects when the password is rejected",
    async () => {
      const rejected = new Client(generateIdentitySync(8), ADDR!, "ts-js-bad-password", {
        serverPassword: "definitely-not-the-password",
      });
      const disconnected = new Promise<Error | undefined>((resolve) =>
        rejected.on("disconnected", (e) => resolve(e.error)),
      );

      // The cause must be the server's rejection, not the caller's own timeout.
      await expect(rejected.connect({ signal: AbortSignal.timeout(8_000) })).rejects.toMatchObject({
        code: ErrorCode.ServerInvalidPassword,
      });
      expect(rejected.status).toBe(ClientStatus.Disconnected);
      await expect(disconnected).resolves.toBeInstanceOf(Error);
    },
    20_000,
  );

  // The server acknowledges clientek under the public dummy key although
  // clientek completes crypto init, so that one acknowledgement must still be
  // accepted after it. Dropped, clientek is resent under the session key until
  // the server acknowledges it again.
  it("accepts the dummy-keyed acknowledgement of clientek, so nothing is resent", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(clientInternals(sharedClient).handler.resends).toBe(0);
  });

  it("receives a non-zero server-assigned client ID", () => {
    const clid = sharedClient.clientID;
    console.log(`connected: clid=${clid}`);
    expect(clid).toBeGreaterThan(0);
  });

  it("clientEnter reports the server-assigned channel ID", async () => {
    const info = await Promise.race([
      selfClientEnter,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("clientEnter timeout")), 8_000),
      ),
    ]);

    console.log(`clientEnter: clid=${info.id} cid=${info.channelID}`);
    expect(info.channelID).toBeGreaterThan(0n);
  }, 10_000);

  it("reports the server's version and uid hash", async () => {
    // Capabilities come from initserver, so they are available as soon as the
    // handshake completes and need no extra round trip.
    const caps = sharedClient.serverCapabilities;
    console.log(
      `capabilities: version="${caps.version}" family=${caps.family} uid=${caps.uidAlgorithm}`,
    );
    expect(caps.version).not.toBe("");
    expect(["ts3", "ts6"]).toContain(caps.family);
    expect(caps.uidAlgorithm).toBe(caps.family === "ts6" ? "sha256" : "sha1");

    // The reported hash must be the one the server applies, not just a claim:
    // uid hashes with it, and the server agrees with the result.
    const mine = sharedClient.uid;
    const clients = await listClients(sharedClient);
    const self = clients.find((c) => c.id === sharedClient.clientID);
    expect(self?.uid).toBe(mine);
  }, 15_000);

  it("uid matches what the server reports for us", async () => {
    // TS3 hashes the public key with SHA-1 and TS6 with SHA-256. Hard-coding
    // either one silently never matches on the other server, which is exactly
    // how a UID-based self-identification passed on TS3 and failed on TS6.
    const mine = sharedClient.uid;
    // The algorithm comes from the server's version, so it must be stable
    // within one connection.
    expect(sharedClient.uid).toBe(mine);

    const clients = await listClients(sharedClient);

    const self = clients.find((c) => c.id === sharedClient.clientID);
    console.log(`uid: ours=${mine} server=${self?.uid}`);
    expect(self?.uid).toBe(mine);
  }, 15_000);

  it("listClients — finds ourselves in the list", async () => {
    const clients = await listClients(sharedClient);

    expect(clients.length).toBeGreaterThan(0);

    const ownID = sharedClient.clientID;
    const self = clients.find((c) => c.id === ownID);
    console.log(`self: clid=${ownID} nick="${self?.nickname}" cid=${self?.channelID}`);
    expect(self).toBeDefined();
  }, 15_000);

  it("a command issued immediately after connecting is not contaminated", async () => {
    // The server pushes its own channellist as part of the welcome sequence,
    // unprompted. Asking for channellist before that sequence ends used to fold
    // the server's own rows into the response: duplicate cids plus a phantom
    // cid=0, every time, while the same call a second later was correct.
    const identity = generateIdentitySync(8);
    const fresh = new Client(identity, ADDR!, "ts-js-welcome", {
      serverPassword: SERVER_PASSWORD,
    });
    await connectWithRetries(fresh);

    const immediate = await listChannels(fresh);
    const ids = immediate.map((c) => c.id);
    console.log(`immediate listChannels: ${immediate.length} rows cids=${ids.join(",")}`);

    expect(ids).not.toContain(0n);
    expect(new Set(ids.map(String)).size).toBe(ids.length);

    await fresh.disconnect();
  }, 45_000);

  it("a command honours its signal and leaves the connection usable", async () => {
    const reason = new Error("caller gave up");
    await expect(listChannels(sharedClient, { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect((await listChannels(sharedClient, { timeoutMs: 10_000 })).length).toBeGreaterThan(0);
  }, 15_000);

  it("whoAmI — names this connection", async () => {
    const [raw] = await sharedClient.exec("whoami");
    console.log(
      `whoami fields: ${Object.keys(raw ?? {})
        .sort()
        .join(", ")}`,
    );
    const me = await whoAmI(sharedClient);
    console.log(`whoami: clid=${me.clientID} cid=${me.channelID} uid=${me.uid}`);
    expect(me.clientID).toBe(sharedClient.clientID);
    expect(me.channelID).toBe(sharedClient.channelID);
  }, 15_000);

  it("listClients — reports idle time in milliseconds", async () => {
    const clients = await listClients(sharedClient, { times: true });
    const self = clients.find((c) => c.id === sharedClient.clientID);
    console.log(`times: idle=${self?.idleTimeMs}ms created=${self?.createdAt?.toISOString()}`);
    expect(self?.idleTimeMs).toBeGreaterThanOrEqual(0);
    expect(self?.idleTimeMs).toBeLessThan(10 * 60_000);
  }, 15_000);

  it("listChannels — at least one channel exists", async () => {
    const channels = await listChannels(sharedClient);

    expect(channels.length).toBeGreaterThan(0);
    console.log(`channels: ${channels.length} found, first="${channels[0]?.name}"`);
  }, 15_000);

  it("listChannels — fills the flags, limits and client counts", async () => {
    const [channels, clients] = await Promise.all([
      listChannels(sharedClient),
      listClients(sharedClient),
    ]);
    const self = clients.find((c) => c.id === sharedClient.clientID);
    const here = channels.find((c) => c.id === self?.channelID);

    expect(channels.some((c) => c.isPermanent)).toBe(true);
    expect(channels.some((c) => c.isDefault)).toBe(true);
    expect(here?.totalClients).toBeGreaterThanOrEqual(1);
    expect(here?.totalFamilyClients).toBeGreaterThanOrEqual(here?.totalClients ?? 1);
  }, 15_000);

  it.skipIf(DEFAULT_CHANNEL === "")(
    "joins the configured default channel",
    async () => {
      const [channels, clients] = await Promise.all([
        listChannels(sharedClient),
        listClients(sharedClient),
      ]);

      const self = clients.find((client) => client.id === sharedClient.clientID);
      const currentChannel = channels.find((channel) => channel.id === self?.channelID);

      expect(self).toBeDefined();
      expect(currentChannel?.name).toBe(DEFAULT_CHANNEL);
    },
    15_000,
  );

  it("getChannelInfo returns the channel that was asked for", async () => {
    // channelinfo answers with pid and the settings but no cid — the channel is
    // whatever was asked for. Reading cid from the row gave 0, so a caller
    // could not tell one channel's info from another's.
    const channels = await listChannels(sharedClient);
    const first = channels[0]!;
    const info = await getChannelInfo(sharedClient, asChannelID(first.id));

    console.log(`channelinfo: id=${info.id} name="${info.name}" parent=${info.parentID}`);
    expect(info.id).toBe(first.id);
    expect(info.name).toBe(first.name);
    // channellist reports cpid and channelinfo reports pid; both must land in
    // parentID or one of the two paths silently reads 0.
    expect(info.parentID).toBe(first.parentID);
  }, 15_000);

  it("listChannels — exposes channel_order", async () => {
    const channels = await listChannels(sharedClient);

    // Every row must carry an order, and a server with more than one channel
    // must not report the same order for all of them — that was the symptom
    // when channel_order was parsed and discarded.
    expect(channels.every((c) => typeof c.order === "bigint")).toBe(true);
    if (channels.length > 1) {
      expect(new Set(channels.map((c) => String(c.order))).size).toBeGreaterThan(1);
    }
  }, 15_000);

  it("clientEnter — batched rows inherit fields omitted by the server", async () => {
    // TeamSpeak compresses pipe-separated notifycliententerview batches by
    // dropping fields that repeat the previous row, so a second client in the
    // same channel arrives with no ctid at all. The shared client plus one peer
    // in the same channel reliably produce that batch for a joining observer.
    const observed = new Map<string, bigint>();
    await connectPeer("ts-js-peer");
    await connectPeer("ts-js-observer", (observer) =>
      observer.on("clientEnter", (info) => observed.set(info.nickname, info.channelID)),
    );
    await new Promise((r) => setTimeout(r, 1_000));

    const shared = observed.get("ts-js-integ");
    const peer = observed.get("ts-js-peer");
    console.log(`batched enter: shared cid=${shared} peer cid=${peer}`);
    expect(shared).toBeDefined();
    expect(peer).toBeDefined();
    expect(shared).not.toBe(0n);
    expect(peer).toBe(shared);
  }, 70_000);

  // These answer with a notification rather than data rows. The SDK used to
  // collect only data rows, report an empty success for every one of them, and
  // pin that as server behaviour in this very test.
  it("client lookups answer with their data", async () => {
    const ownID = sharedClient.clientID;
    const me = await getClientProperties(sharedClient, ownID);
    const uid = asUID(me["client_unique_identifier"]!);
    const dbid = asClientDBID(BigInt(me["client_database_id"]!));
    const nickname = me["client_nickname"]!;

    expect(await getClientUIDByID(sharedClient, ownID)).toBe(uid);
    expect(await getClientDBIDByUID(sharedClient, uid)).toBe(dbid);
    expect(await getClientNameByUID(sharedClient, uid)).toEqual({
      databaseID: dbid,
      name: nickname,
    });
    expect(await getClientNameByDBID(sharedClient, dbid)).toEqual({
      databaseID: dbid,
      name: nickname,
    });
    expect(await getClientIDs(sharedClient, uid)).toContainEqual({ id: ownID, nickname });
  }, 20_000);

  // Offline messages are the one thing here that cannot be undone by the
  // sender, so the client writes to its own inbox and clears it again.
  it("sendOfflineMessage — leaves a message the recipient can read and delete", async () => {
    const subject = `ts-js-${Date.now()}`;
    await sendOfflineMessage(sharedClient, sharedClient.uid, subject, "hello there");
    const sent = (await listMessages(sharedClient)).find((m) => m.subject === subject);
    try {
      expect(sent).toBeDefined();
      expect(sent?.uid).toBe(sharedClient.uid);
      expect(sent?.isRead).toBe(false);
      expect((await getMessage(sharedClient, sent!.id)).message).toBe("hello there");
    } finally {
      if (sent !== undefined) await deleteMessage(sharedClient, sent.id);
    }
    expect((await listMessages(sharedClient)).some((m) => m.subject === subject)).toBe(false);
  }, 20_000);

  // The fixture grants the default group `b_client_permissionoverview_own`; a
  // server without it answers 2568, which is its own test below.
  it("getOwnPermission — reads a permission the connection holds", async () => {
    const permission = await getOwnPermission(
      sharedClient,
      permissionByName("b_client_permissionoverview_own"),
    );
    expect(permission).toMatchObject({ name: "b_client_permissionoverview_own", value: 1 });
    expect(permission.id).toBeGreaterThan(0);
  }, 20_000);

  // Their answers arrive as notifications, so before they were mapped a raw
  // exec returned no rows at all.
  it("exec — returns the rows of the commands that answer with a notification", async () => {
    const own = sharedClient.clientID;
    const variables = await sharedClient.exec("servergetvariables");
    expect(variables[0]?.["virtualserver_maxclients"]).toBeDefined();

    const mine = await sharedClient.exec(`clientgetvariables clid=${own}`);
    expect(mine[0]).toMatchObject({ clid: String(own) });
  }, 20_000);

  // `notifyclientupdated` is also sent whenever another client changes state,
  // and the client's own mute broadcast is one: neither answers a question
  // about someone else.
  it("exec — a variables answer is the client's that was asked about", async () => {
    const peer = await connectPeer("ts-js-echo-peer");
    const other = await connectPeer("ts-js-echo-other");
    const asked = peer.clientID;
    for (let i = 0; i < 11; i++) {
      const changing = other.exec(`clientupdate client_input_muted=${i % 2}`);
      const own = sharedClient.exec(`clientupdate client_output_muted=${i % 2}`);
      const rows = await sharedClient.exec(`clientgetvariables clid=${asked}`);
      await Promise.all([changing, own]);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row["clid"]).toBe(String(asked));
    }
  }, 30_000);

  it("listServerGroups — includes the server's default group", async () => {
    const [groups, server] = await Promise.all([
      listServerGroups(sharedClient),
      getServerInfo(sharedClient),
    ]);
    const defaultGroup = BigInt(server["virtualserver_default_server_group"]!);

    expect(groups.length).toBeGreaterThan(1);
    expect(groups.map((g) => g.id)).toContain(defaultGroup);
  }, 15_000);

  // The voice protocol answers channelcreate with notifychannelcreated, not a
  // cid row, so the id came back as 0.
  it("createChannel — returns the new channel's id", async () => {
    const before = sharedClient.channelID;
    const name = `ts-js-${Date.now().toString(36)}`;
    const cid = await createChannel(sharedClient, { name });
    try {
      expect(cid).not.toBe(0n);
      expect((await getChannelInfo(sharedClient, cid)).name).toBe(name);
    } finally {
      // Creating a channel over the voice protocol moves the creator into it,
      // and the server deletes a temporary channel once its last client
      // leaves — so moving back is the cleanup.
      await moveClient(sharedClient, sharedClient.clientID, asChannelID(before));
    }
  }, 20_000);

  // The key arrives in a notification after the command has already returned;
  // without it there is nothing to dial.
  it("file transfer — uploads and downloads the same bytes", async () => {
    const cid = sharedClient.channelID;
    const path = `/ts-js-${Date.now().toString(36)}.bin`;
    const payload = Buffer.from("hello over file transfer");
    const host = ADDR!.slice(0, ADDR!.lastIndexOf(":"));

    const upload = await initFileUpload(sharedClient, cid, path, BigInt(payload.length));
    expect(upload.fileTransferKey).not.toBe("");
    const uploadCalls: Array<[string, Record<string, unknown>]> = [];
    const traceInto =
      (calls: Array<[string, Record<string, unknown>]>) =>
      (name: string) =>
      (i: object): void => {
        calls.push([name, i as Record<string, unknown>]);
      };
    const forUpload = traceInto(uploadCalls);
    await sharedClient.uploadFileData(host, upload, Readable.from([payload]), {
      trace: {
        dialStart: forUpload("dialStart"),
        dialDone: forUpload("dialDone"),
        progress: forUpload("progress"),
        done: forUpload("done"),
        failed: forUpload("failed"),
      },
    });
    expect(uploadCalls.map(([name]) => name).filter((n) => n !== "progress")).toEqual([
      "dialStart",
      "dialDone",
      "done",
    ]);
    expect(uploadCalls.filter(([n]) => n === "progress").at(-1)![1]["bytes"]).toBe(payload.length);
    expect(uploadCalls.at(-1)![1]["bytes"]).toBe(payload.length);
    expect(JSON.stringify(uploadCalls)).not.toContain(upload.fileTransferKey);

    try {
      const files = await listFiles(sharedClient, cid, "/");
      expect(files.map((f) => `/${f.name}`)).toContain(path);

      // TS3 sends the times in seconds; TS6 sends a listing's in milliseconds
      // and a single file's in nanoseconds. All three must read as now, not as
      // 1970 or the far future.
      const listed = files.find((f) => `/${f.name}` === path)!;
      const info = await getFileInfo(sharedClient, cid, path);
      console.log(
        `file times: listed=${listed.modifiedAt?.toISOString()} info=${info.modifiedAt?.toISOString()}`,
      );
      for (const modifiedAt of [listed.modifiedAt, info.modifiedAt]) {
        expect(Math.abs(modifiedAt!.getTime() - Date.now())).toBeLessThan(86_400_000);
      }
      expect(listed.isDirectory).toBe(false);

      const download = await initFileDownload(sharedClient, cid, path);
      expect(download.size).toBe(BigInt(payload.length));
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      await sharedClient.downloadFileData(host, download, sink);
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    } finally {
      await deleteFile(sharedClient, cid, [path]);
    }
  }, 30_000);

  // Several names go as rows of one command (name=/a|name=/b); a single
  // name parameter holding "/a|/b" is one path that does not exist.
  it("deleteFile — deletes several files in one command", async () => {
    const cid = sharedClient.channelID;
    const stamp = Date.now().toString(36);
    const paths = [`/ts-js-a-${stamp}.bin`, `/ts-js-b-${stamp}.bin`];
    const host = ADDR!.slice(0, ADDR!.lastIndexOf(":"));
    for (const path of paths) {
      const upload = await initFileUpload(sharedClient, cid, path, 1n);
      await sharedClient.uploadFileData(host, upload, Readable.from([Buffer.from("x")]));
    }
    const names = async (): Promise<string[]> =>
      (await listFiles(sharedClient, cid, "/")).map((f) => `/${f.name}`);
    expect(await names()).toEqual(expect.arrayContaining(paths));

    await deleteFile(sharedClient, cid, paths);

    const left = await names();
    expect(left).not.toContain(paths[0]);
    expect(left).not.toContain(paths[1]);
  }, 30_000);

  it("getClientProperties — returns our own nickname", async () => {
    const info = await getClientProperties(sharedClient, sharedClient.clientID);

    expect(Object.keys(info).length).toBeGreaterThan(0);
    console.log("clientinfo keys:", Object.keys(info).sort().join(", "));
    expect(info["client_nickname"]).toBeDefined();
  }, 15_000);

  it("connects as a version from the table, and the server reports it", async () => {
    const peer = new Client(generateIdentitySync(8), ADDR!, "ts-js-version", {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
      version: Windows_3_6_3_1701166057,
    });
    peers.set("ts-js-version", peer);
    await connectWithRetries(peer);

    const info = await getClientProperties(peer, peer.clientID);

    expect(info["client_version"]).toBe(Windows_3_6_3_1701166057.version);
    expect(info["client_platform"]).toBe(Windows_3_6_3_1701166057.platform);
  }, 30_000);

  // Opt-in: needs a channel whose password the bot does not have permission
  // to bypass. Without the base64(sha1(pw)) encoding the server answers 781.
  it.skipIf(PASSWORD_CHANNEL === "" || PASSWORD_CHANNEL_PASSWORD === "")(
    "clientMove — joins a password-protected channel",
    async () => {
      const channels = await listChannels(sharedClient);

      const target = channels.find((c) => c.name === PASSWORD_CHANNEL);
      expect(target).toBeDefined();

      await moveClient(sharedClient, sharedClient.clientID, target!.id, {
        password: PASSWORD_CHANNEL_PASSWORD,
      });
    },
    20_000,
  );

  it("reconnects after a dropped connection", async () => {
    // The socket is dropped underneath the client, which is what a network
    // failure looks like. A bot that cannot recover is not usable unattended.
    //
    // Recovery is not immediate: the server still holds the old session and
    // refuses a reconnect from the same identity with 521 "too many clones
    // already connected" until it reaps the zombie, so the loop has to keep
    // trying rather than give up on the first refusal.
    let socket: Socket | undefined;
    const recovering = new Client(generateIdentitySync(8), ADDR!, "ts-js-reconnect", {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      reconnect: { backoff: { initialDelayMs: 500, maxDelayMs: 4_000 } },
      socketFactory: (family) => {
        socket = createSocket(family === 6 ? "udp6" : "udp4");
        return socket;
      },
    });

    await connectWithRetries(recovering);
    const firstID = recovering.clientID;
    expect(firstID).toBeGreaterThan(0);

    socket!.close();

    const recovered = await new Promise<boolean>((resolve) => {
      const poll = setInterval(() => {
        if (recovering.status === ClientStatus.Connected && recovering.clientID !== firstID) {
          clearInterval(poll);
          resolve(true);
        }
      }, 250);
      setTimeout(() => {
        clearInterval(poll);
        resolve(false);
      }, 60_000);
    });

    console.log(`reconnect: ${firstID} -> ${recovering.clientID}`);
    expect(recovered).toBe(true);

    // A reconnect is a fresh session, so it must be usable, not merely
    // connected.
    const channels = await listChannels(recovering);
    expect(channels.length).toBeGreaterThan(0);

    await recovering.disconnect();
  }, 110_000);

  it("does not reconnect after an explicit disconnect", async () => {
    // A deliberate disconnect means the caller is done. Retrying would keep a
    // process alive that asked to stop.
    const client = new Client(generateIdentitySync(8), ADDR!, "ts-js-noreconnect", {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      reconnect: { backoff: { initialDelayMs: 200 } },
    });

    await connectWithRetries(client);
    await client.disconnect();

    await new Promise((r) => setTimeout(r, 2_500));
    expect(client.status).toBe(ClientStatus.Disconnected);
  }, 45_000);

  it("sendWhisper — delivers a VoiceWhisper frame to the target", async () => {
    // Reuses the observer from the batch test to stay within the antiflood
    // budget. Needs i_client_whisper_power on the bot's server group.
    const listener = peers.get("ts-js-observer") ?? (await connectPeer("ts-js-observer"));

    const received = new Promise<boolean>((resolve) => {
      listener.on("voiceData", () => resolve(true));
      setTimeout(() => resolve(false), 5_000);
    });

    const frame = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < 12; i++) {
      sharedClient.sendWhisper(frame, { clients: [listener.clientID] }, 5);
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(await received).toBe(true);
  }, 45_000);

  it("onTextMessage — receives message sent to self", async () => {
    const received = new Promise<string>((resolve) => {
      sharedClient.on("textMessage", (msg) => {
        resolve(msg.message);
      });
    });

    const ownID = sharedClient.clientID;
    await sendPrivateMessage(sharedClient, asClientID(ownID), "hello from ts-js-integ");

    const msg = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("text message timeout")), 8_000),
      ),
    ]);

    expect(msg).toBe("hello from ts-js-integ");
  }, 15_000);

  it("trace — reports every milestone of a session, in order, with what the server said", async () => {
    const calls: Array<{ name: string; info: Record<string, unknown> }> = [];
    const record =
      (name: string) =>
      (info: object): void => {
        calls.push({ name, info: info as Record<string, unknown> });
      };
    const trace: ClientTrace = {
      resolveStart: record("resolveStart"),
      resolveDone: record("resolveDone"),
      connectStart: record("connectStart"),
      connectDone: record("connectDone"),
      handshakeDone: record("handshakeDone"),
      sessionStart: record("sessionStart"),
      welcomeDone: record("welcomeDone"),
      attemptFailed: record("attemptFailed"),
      disconnectStart: record("disconnectStart"),
      disconnectDone: record("disconnectDone"),
      sessionEnd: record("sessionEnd"),
      reconnectScheduled: record("reconnectScheduled"),
      reconnectStopped: record("reconnectStopped"),
    };
    const nickname = "ts-js-trace";
    const traced = new Client(generateIdentitySync(8), ADDR!, nickname, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
      trace,
    });
    const info = (name: string): Record<string, unknown> =>
      calls.find((c) => c.name === name)!.info;
    try {
      await traced.connect({ signal: AbortSignal.timeout(CONNECT_ATTEMPT_MS) });
      // The welcome sequence ends shortly after the session starts.
      for (let i = 0; i < 100 && !calls.some((c) => c.name === "welcomeDone"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(calls.map((c) => c.name)).toEqual([
        "resolveStart",
        "resolveDone",
        "connectStart",
        "connectDone",
        "handshakeDone",
        "sessionStart",
        "welcomeDone",
      ]);
      for (const name of [
        "resolveDone",
        "connectDone",
        "handshakeDone",
        "sessionStart",
        "welcomeDone",
      ]) {
        expect(info(name)["durationMs"]).toBeGreaterThanOrEqual(0);
      }
      expect(info("sessionStart")["clientID"]).toBe(traced.clientID);

      // What the server said, on TS3 and TS6 alike.
      expect(info("handshakeDone")["puzzleLevel"]).toBeGreaterThan(0);
      expect(info("handshakeDone")["puzzleDurationMs"]).toBeGreaterThanOrEqual(0);
      expect(info("handshakeDone")["resends"]).toBeGreaterThanOrEqual(0);
      expect(String(info("handshakeDone")["serverPublicKey"])).not.toBe("");
      expect(info("connectDone")["localAddr"]).not.toBe("");
      expect(info("sessionStart")["nickname"]).toBe(nickname);
      expect(
        (info("sessionStart")["capabilities"] as { serverID: bigint }).serverID,
      ).toBeGreaterThan(0n);
      const welcome = info("welcomeDone");
      expect(welcome["channelID"]).toBe(traced.channelID);
      expect(welcome["channelID"] as bigint).toBeGreaterThan(0n);
      // The fixture has Default Channel, Alpha and Secret.
      expect(welcome["channels"]).toBeGreaterThanOrEqual(3);
      expect(welcome["clients"]).toBeGreaterThanOrEqual(1);
    } finally {
      await traced.disconnect();
    }
    const tail = calls.slice(-3);
    expect(tail.map((c) => c.name)).toEqual(["disconnectStart", "disconnectDone", "sessionEnd"]);
    expect(tail[1]!.info).toMatchObject({ acknowledged: true });
    expect(tail[2]!.info["error"]).toBeUndefined();
    expect(tail[2]!.info["clientID"]).toBeDefined();
  }, 30_000);

  it("trace — reports a failed attempt to a closed port", async () => {
    // Bind a UDP socket to learn a free port, then close it: nothing listens.
    const probe = createSocket("udp4");
    await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const failures: Array<{ phase: string; error: unknown }> = [];
    const started: string[] = [];
    const closed = new Client(generateIdentitySync(8), `127.0.0.1:${port}`, "ts-js-closed", {
      trace: {
        resolveStart: () => started.push("resolveStart"),
        sessionStart: () => started.push("sessionStart"),
        attemptFailed: (info) => failures.push({ phase: info.phase, error: info.error }),
      },
    });
    const signal = AbortSignal.timeout(1_000);
    const outcome = await closed.connect({ signal }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeDefined();
    expect(started).toEqual(["resolveStart"]);
    expect(failures).toHaveLength(1);
    expect(["open", "handshake"]).toContain(failures[0]!.phase);
    // The attempt's error is the one connect() rejects with: the abort reason,
    // or the socket's own refusal when the loopback reports the closed port first.
    expect(failures[0]!.error).toBe(outcome);
    if (outcome !== signal.reason) {
      expect((outcome as { code?: string }).code).toBe("ECONNREFUSED");
    }
  }, 10_000);
});

// ---- Live state: events about other clients ------------------------------------
//
// The subject (a peer) changes; the bystander (the shared client) watches, as
// a second client would in a real channel. Group changes need an administrator,
// which a voice client of the default group is not, so a query connection acts;
// without a query endpoint those cases skip.

const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";
const EVENT_MS = 8_000;

/** The query connection that acts as the administrator, from the fixture's environment. */
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
    nickname: "ts-js-live-admin",
  };
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

describe.skipIf(SKIP)("Integration — events about other clients", () => {
  let admin: QueryClient | undefined;
  let subject: Client;
  let subjectID: ClientID;
  const bystander = () => sharedClient;

  beforeAll(async () => {
    subject = peers.get("ts-js-peer") ?? (await connectPeer("ts-js-peer"));
    subjectID = asClientID(subject.clientID);
    // The bystander must have seen the subject enter, which it does as it is
    // in the same channel; wait for the roster rather than assume it.
    for (let i = 0; i < 50 && !clientInternals(bystander()).clients.has(subjectID); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (HAS_ADMIN) {
      admin = new QueryClient(adminOptions());
      await admin.connect({ signal: AbortSignal.timeout(15_000) });
    }
  }, 60_000);

  afterAll(async () => {
    await admin?.disconnect().catch(() => {});
  });

  it("clientUpdated — an away and mute change carries exactly the changed keys", async () => {
    const changed = nextEvent(
      bystander(),
      "clientUpdated",
      (e) => e.clientID === subjectID && "isAway" in e.changes,
    );
    await updateClient(subject, { isAway: true, awayMessage: "brb", isInputMuted: true });
    const away = await changed;
    console.log("away update keys:", Object.keys(away.changes));
    expect(Object.keys(away.changes).sort()).toEqual(["awayMessage", "isAway", "isInputMuted"]);
    expect(away.changes.isAway).toBe(true);
    expect(away.changes.awayMessage).toBe("brb");
    expect(away.invokerID).toBe(0);
    expect(clientInternals(bystander()).clients.get(subjectID)?.isAway).toBe(true);

    const reverted = nextEvent(
      bystander(),
      "clientUpdated",
      (e) => e.clientID === subjectID && "isAway" in e.changes,
    );
    await updateClient(subject, { isAway: false, awayMessage: "", isInputMuted: false });
    const back = await reverted;
    console.log("revert update keys:", Object.keys(back.changes));
    expect(back.changes.isAway).toBe(false);
    expect("isAway" in back.changes).toBe(true);
    expect(clientInternals(bystander()).clients.get(subjectID)?.isAway).toBe(false);
  }, 30_000);

  it.skipIf(!HAS_ADMIN)(
    "server group change — both events arrive, and a later message carries the new groups (needs a query endpoint)",
    async () => {
      const a = admin!;
      const listed = await listClients(a);
      const row = listed.find((c) => c.id === subjectID);
      expect(row).toBeDefined();
      const dbid = await getClientDBIDByUID(a, row!.uid);
      const messageGroups = async (text: string): Promise<readonly ServerGroupID[] | undefined> => {
        const got = nextEvent(bystander(), "textMessage", (e) => e.message === text);
        await sendPrivateMessage(subject, asClientID(bystander().clientID), text);
        return (await got).invokerGroups;
      };

      const sgid = await createServerGroup(a, `ts-js-live-${Date.now()}`, GroupType.Regular);
      let added = false;
      try {
        const before = await messageGroups("groups before");
        expect(before).not.toContain(sgid);

        const groupAdded = nextEvent(
          bystander(),
          "clientServerGroupAdded",
          (e) => e.clientID === subjectID,
        );
        const updated = nextEvent(
          bystander(),
          "clientUpdated",
          (e) => e.clientID === subjectID && e.changes.serverGroups?.includes(sgid) === true,
        );
        const ownAdded = nextEvent(subject, "clientServerGroupAdded", (e) => e.groupID === sgid);
        await addClientToServerGroup(a, sgid, dbid);
        added = true;
        const [event, update] = await Promise.all([groupAdded, updated]);
        await ownAdded;
        console.log("added:", event, "update keys:", Object.keys(update.changes));
        expect(event.groupID).toBe(sgid);
        expect(event.uid).toBe(row!.uid);
        expect(event.nickname).toBe(row!.nickname);
        expect(update.changes.serverGroups).toContain(sgid);

        // The regression: this came back with the groups from when the client entered.
        expect(await messageGroups("groups after add")).toContain(sgid);

        const groupRemoved = nextEvent(
          bystander(),
          "clientServerGroupRemoved",
          (e) => e.clientID === subjectID,
        );
        const updatedAfter = nextEvent(
          bystander(),
          "clientUpdated",
          (e) => e.clientID === subjectID && e.changes.serverGroups?.includes(sgid) === false,
        );
        await removeClientFromServerGroup(a, sgid, dbid);
        added = false;
        expect((await groupRemoved).groupID).toBe(sgid);
        await updatedAfter;
        expect(await messageGroups("groups after remove")).not.toContain(sgid);
      } finally {
        if (added) await removeClientFromServerGroup(a, sgid, dbid).catch(() => {});
        await deleteServerGroup(a, sgid, { force: true }).catch(() => {});
      }
    },
    45_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "setClientChannelGroup — reports the change and refreshes the cached channel group (needs a query endpoint)",
    async () => {
      const a = admin!;
      const known = clientInternals(bystander()).clients.get(subjectID)!;
      const row = (await listClients(a)).find((c) => c.id === subjectID)!;
      const dbid = await getClientDBIDByUID(a, row.uid);
      const original = known.channelGroupID;
      const groups = await listChannelGroups(a);
      const other = groups.find((g) => g.type === GroupType.Regular && g.id !== original);
      expect(other).toBeDefined();

      const changed = nextEvent(
        bystander(),
        "clientChannelGroupChanged",
        (e) => e.clientID === subjectID && e.channelGroupID === other!.id,
      );
      await setClientChannelGroup(a, other!.id, known.channelID, dbid);
      try {
        const event = await changed;
        console.log("channel group changed:", event);
        expect(event.channelID).toBe(known.channelID);
        expect(clientInternals(bystander()).clients.get(subjectID)?.channelGroupID).toBe(other!.id);
      } finally {
        const restored = nextEvent(
          bystander(),
          "clientChannelGroupChanged",
          (e) => e.clientID === subjectID && e.channelGroupID === original,
        ).catch(() => undefined);
        await setClientChannelGroup(a, original, known.channelID, dbid).catch(() => {});
        await restored;
      }
      expect(clientInternals(bystander()).clients.get(subjectID)?.channelGroupID).toBe(original);
    },
    30_000,
  );
});

// ---- Live state: channel, server and plugin events -----------------------------
//
// Seen by a bystander voice client and, where the fixture has raw ServerQuery
// on TCP, by a query client with the default categories. An administrator
// (the query connection) acts; every test puts back what it changed.

/** What both kinds of client offer for the events they share. */
interface Watcher {
  on<K extends keyof ServerEventMap>(
    name: K,
    listener: (payload: ServerEventMap[K]) => void,
  ): () => void;
}

/** Resolve with the first event of `name` that `match` accepts; reject when none arrives. */
function seen<K extends keyof ServerEventMap>(
  watcher: Watcher,
  name: K,
  match: (payload: ServerEventMap[K]) => boolean = () => true,
  ms = EVENT_MS,
): Promise<ServerEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${name} event arrived`));
    }, ms);
    const off = watcher.on(name, (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

/**
 * Whether no event of `name` that `match` accepts arrives within `ms`; for the
 * events that must not. The filter keeps other suites' traffic, on the same
 * server, from counting.
 */
async function never<K extends keyof EventMap>(
  client: Client,
  name: K,
  match: (payload: EventMap[K]) => boolean,
  ms = 1_500,
): Promise<boolean> {
  let arrived = false;
  const off = client.on(name, ((payload: EventMap[K]) => {
    if (match(payload)) arrived = true;
  }) as never);
  await new Promise((resolve) => setTimeout(resolve, ms));
  off();
  return !arrived;
}

describe.skipIf(SKIP)("Integration — channel, server and plugin events", () => {
  let admin: QueryClient | undefined;
  let rawObserver: QueryClient | undefined;
  let subject: Client;
  let subjectID: ClientID;
  let alphaID: ChannelID;
  const made: ChannelID[] = [];
  const bystander = () => sharedClient;

  const tag = () => `ts-js-ev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  beforeAll(async () => {
    subject = peers.get("ts-js-peer") ?? (await connectPeer("ts-js-peer"));
    subjectID = asClientID(subject.clientID);
    for (let i = 0; i < 50 && !clientInternals(bystander()).clients.has(subjectID); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (HAS_ADMIN) {
      admin = new QueryClient(adminOptions());
      await admin.connect({ signal: AbortSignal.timeout(15_000) });
      const channels = await listChannels(admin);
      alphaID = channels.find((c) => c.name === DEFAULT_CHANNEL)?.id ?? channels[0]!.id;
    }
    if (QUERY_KIND === "tcp") {
      rawObserver = new QueryClient({ ...adminOptions(), nickname: "ts-js-live-observer" });
      await rawObserver.connect({ signal: AbortSignal.timeout(15_000) });
    }
  }, 60_000);

  afterAll(async () => {
    if (admin)
      for (const cid of made) await deleteChannel(admin, cid, { force: true }).catch(() => {});
    await rawObserver?.disconnect().catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 30_000);

  const watchers: ReadonlyArray<readonly [string, () => Watcher | undefined]> = [
    ["a bystander voice client", () => bystander() as unknown as Watcher],
    ["a TS3 raw ServerQuery client", () => rawObserver as unknown as Watcher | undefined],
  ];

  describe.each(watchers)("seen by %s", (who, getWatcher) => {
    const skipReason = (): string | undefined => {
      if (!HAS_ADMIN) return "no query endpoint provisioned";
      if (getWatcher() === undefined) return "TS3 raw query is not provisioned here";
      return undefined;
    };
    /** Skip with the reason, visibly. */
    const needs = (ctx: { skip: (reason?: string) => never }): Watcher => {
      const reason = skipReason();
      if (reason !== undefined) ctx.skip(`${who}: ${reason}`);
      return getWatcher()!;
    };

    it("a channel's life: created, edited, moved, deleted", async (ctx) => {
      const watcher = needs(ctx);
      const a = admin!;
      const name = tag();
      const created = seen(watcher, "channelCreated", (e) => e.changes.name === name);
      const cid = await createChannel(a, {
        name,
        topic: "t1",
        isPermanent: true,
        maxClients: 5,
      });
      made.push(cid);
      try {
        const c = await created;
        console.log(`${who}: created`, Object.keys(c.changes));
        expect(c.channelID).toBe(cid);
        expect(c.parentID).toBe(0n);
        expect(Object.keys(c.changes)).toEqual(
          expect.arrayContaining(["name", "topic", "isPermanent", "maxClients", "order"]),
        );
        expect("description" in c.changes).toBe(false);
        expect(c.changes).toMatchObject({ topic: "t1", isPermanent: true, maxClients: 5 });
        expect(c.invokerUID).toBe("serveradmin");

        const edited = seen(watcher, "channelEdited", (e) => e.channelID === cid);
        await editChannel(a, cid, { topic: "t2" });
        const e = await edited;
        expect(Object.keys(e.changes)).toEqual(["topic"]);
        expect(e.changes.topic).toBe("t2");
        expect(e.reason).toBe(Reason.ChannelEdit);
        expect(e.invokerUID).toBe("serveradmin");

        const moved = seen(watcher, "channelMoved", (m) => m.channelID === cid);
        await moveChannel(a, cid, alphaID, { order: 0n as ChannelID });
        const m = await moved;
        expect(m).toMatchObject({ channelID: cid, parentID: alphaID, order: 0n });
        expect(m.invokerUID).toBe("serveradmin");

        const deleted = seen(watcher, "channelDeleted", (d) => d.channelID === cid);
        await deleteChannel(a, cid, { force: true });
        made.splice(made.indexOf(cid), 1);
        const d = await deleted;
        expect(d.invokerUID).toBe("serveradmin");
        expect(d.invokerID).toBeGreaterThan(0);
      } finally {
        if (made.includes(cid)) {
          await deleteChannel(a, cid, { force: true }).catch(() => {});
          made.splice(made.indexOf(cid), 1);
        }
      }
    }, 30_000);

    it("a description and a password change: the signal, and the edit that goes with it", async (ctx) => {
      const watcher = needs(ctx);
      const a = admin!;
      const cid = await createChannel(a, { name: tag(), isPermanent: true });
      made.push(cid);
      try {
        const descriptionSignal = seen(
          watcher,
          "channelDescriptionChanged",
          (e) => e.channelID === cid,
        );
        const descriptionEdit = seen(watcher, "channelEdited", (e) => e.channelID === cid);
        await editChannel(a, cid, { description: "a description" });
        await descriptionSignal;
        expect(Object.keys((await descriptionEdit).changes)).toEqual([]);

        const set = seen(watcher, "channelEdited", (e) => e.channelID === cid);
        const setSignal = seen(watcher, "channelPasswordChanged", (e) => e.channelID === cid);
        await editChannel(a, cid, { password: "hunter3" });
        await setSignal;
        expect((await set).changes).toEqual({ hasPassword: true });

        const cleared = seen(watcher, "channelEdited", (e) => e.channelID === cid);
        const clearedSignal = seen(watcher, "channelPasswordChanged", (e) => e.channelID === cid);
        await editChannel(a, cid, { password: "" });
        await clearedSignal;
        expect((await cleared).changes).toEqual({ hasPassword: false });
      } finally {
        await deleteChannel(a, cid, { force: true }).catch(() => {});
        made.splice(made.indexOf(cid), 1);
      }
    }, 30_000);

    it("serverEdited: a changed name, and a welcome message with no property", async (ctx) => {
      const watcher = needs(ctx);
      const a = admin!;
      const info = await getServerInfo(a);
      const name = info[PropertyName.VirtualServerName] ?? "";
      const welcome = info[PropertyName.VirtualServerWelcomeMessage] ?? "";
      try {
        const renamed = seen(
          watcher,
          "serverEdited",
          (e) => PropertyName.VirtualServerName in e.changes,
        );
        await editServer(a, { [PropertyName.VirtualServerName]: `${name} (ev)` });
        const r = await renamed;
        expect(r.changes).toEqual({ [PropertyName.VirtualServerName]: `${name} (ev)` });
        expect(r.invokerUID).toBe("serveradmin");

        const welcomed = seen(
          watcher,
          "serverEdited",
          (e) => !(PropertyName.VirtualServerName in e.changes),
        );
        await editServer(a, { [PropertyName.VirtualServerWelcomeMessage]: `${welcome} (ev)` });
        expect((await welcomed).changes).toEqual({});
      } finally {
        await editServer(a, {
          [PropertyName.VirtualServerName]: name,
          [PropertyName.VirtualServerWelcomeMessage]: welcome,
        }).catch(() => {});
      }
    }, 30_000);

    it("a temporary channel the server deletes once it is empty", async (ctx) => {
      const watcher = needs(ctx);
      const a = admin!;
      const name = tag();
      const created = seen(watcher, "channelCreated", (e) => e.changes.name === name);
      // The creator is moved into a temporary channel; leaving empties it.
      const cid = await createChannel(subject, { name });
      made.push(cid);
      try {
        await created;
        const deleted = seen(watcher, "channelDeleted", (e) => e.channelID === cid, 15_000);
        const back = await listChannels(a).then((l) => l.find((c) => c.id === alphaID)!.id);
        await subject.send({
          command: "clientmove",
          params: [
            ["clid", subjectID],
            ["cid", back],
          ],
        });
        const d = await deleted;
        console.log(`${who}: server deleted`, d);
        expect(d).toMatchObject({ channelID: cid, invokerID: 0, invokerName: "Server" });
      } finally {
        await deleteChannel(a, cid, { force: true }).catch(() => {});
        made.splice(made.indexOf(cid), 1);
      }
    }, 40_000);
  });

  it("getChannelDescription: the answer is no channelEdited, and a real edit meanwhile is one", async (ctx) => {
    if (!HAS_ADMIN) ctx.skip("no query endpoint provisioned");
    const a = admin!;
    const cid = await createChannel(a, {
      name: tag(),
      isPermanent: true,
      description: "fetched text",
    });
    made.push(cid);
    try {
      const edits: Array<{ reason: number; keys: string[] }> = [];
      const names: string[] = [];
      const offEdit = subject.on("channelEdited", (e) =>
        edits.push({ reason: e.reason, keys: Object.keys(e.changes) }),
      );
      const offAll = subject.on("notification", (n) => {
        if (n.name === "notifychanneledited") names.push(n.params["reasonid"] ?? "");
      });
      const fetched = getChannelDescription(subject, cid);
      // A real edit while the fetch is in flight is not swallowed.
      await editChannel(a, cid, { topic: "meanwhile" });
      expect(await fetched).toBe("fetched text");
      await new Promise((r) => setTimeout(r, 1_000));
      offEdit();
      offAll();
      console.log("channelEdited events:", edits, "reasonids on the catch-all:", names);
      expect(names).toContain("9");
      expect(edits).toEqual([{ reason: Reason.ChannelEdit, keys: ["topic"] }]);
    } finally {
      await deleteChannel(a, cid, { force: true }).catch(() => {});
      made.splice(made.indexOf(cid), 1);
    }
  }, 30_000);

  it("channelSubscribed and channelUnsubscribed: one event each, with the channel", async (ctx) => {
    if (!HAS_ADMIN) ctx.skip("no query endpoint provisioned");
    const a = admin!;
    const cid = await createChannel(a, { name: tag(), isPermanent: true });
    made.push(cid);
    try {
      const subscribed = nextEvent(subject, "channelSubscribed", (e) => e.channelID === cid);
      await subscribeChannel(subject, cid);
      expect((await subscribed).channelID).toBe(cid);
      const unsubscribed = nextEvent(subject, "channelUnsubscribed", (e) => e.channelID === cid);
      await unsubscribeChannel(subject, cid);
      expect((await unsubscribed).channelID).toBe(cid);
    } finally {
      await deleteChannel(a, cid, { force: true }).catch(() => {});
      made.splice(made.indexOf(cid), 1);
    }
  }, 30_000);

  /**
   * Put both clients in the default channel, where the channel-wide commands
   * reach both; earlier tests may have left one elsewhere. Returns what puts
   * them back.
   */
  async function together(): Promise<() => Promise<void>> {
    const before = [subject, bystander()].map((client) => [client, client.channelID] as const);
    for (const [client] of before) {
      if (client.channelID !== alphaID) {
        await moveClient(client, asClientID(client.clientID), alphaID);
      }
    }
    return async () => {
      for (const [client, channelID] of before) {
        if (client.channelID !== channelID) {
          await moveClient(client, asClientID(client.clientID), channelID).catch(() => {});
        }
      }
    };
  }

  it("pluginCommand: who receives it for each target", async (ctx) => {
    if (!HAS_ADMIN) ctx.skip("no query endpoint provisioned, so the default channel is not known");
    const restore = await together();
    try {
      await pluginCommandTargets();
    } finally {
      await restore();
    }
  }, 30_000);

  async function pluginCommandTargets(): Promise<void> {
    const c = asClientID(bystander().clientID);
    const name = `ts-js-plug-${Date.now()}`;
    const got = (client: Client, data: string) =>
      nextEvent(client, "pluginCommand", (e) => e.name === name && e.data === data).catch(
        (error: unknown) => {
          throw new Error(
            `${client === subject ? "the sender" : "the other client"}, "${data}": ${String(error)}`,
          );
        },
      );

    // The channel: both clients are in it, and the sender receives its own.
    const [byC, bySubject] = [got(bystander(), "to channel"), got(subject, "to channel")];
    await sendPluginCommand(subject, name, "to channel", "channel");
    expect(await byC).toMatchObject({
      invokerID: subjectID,
      invokerName: "ts-js-peer",
      invokerUID: subject.uid,
    });
    await bySubject;

    // The server: every client, the sender among them.
    const [serverC, serverSubject] = [got(bystander(), "to server"), got(subject, "to server")];
    await sendPluginCommand(subject, name, "to server", "server");
    await Promise.all([serverC, serverSubject]);

    // One client: that client only; the sender hears nothing.
    const direct = got(bystander(), "to one");
    const senderHears = never(subject, "pluginCommand", (e) => e.name === name);
    await sendPluginCommand(subject, name, "to one", { clientID: c });
    expect((await direct).data).toBe("to one");
    expect(await senderHears).toBe(true);

    // An empty payload and one that needs escaping arrive as sent.
    const empty = got(bystander(), "");
    await sendPluginCommand(subject, name, "", "channel");
    await empty;
    const odd = got(bystander(), "a b|c/d\\e");
    await sendPluginCommand(subject, name, "a b|c/d\\e", "channel");
    await odd;
  }

  it("clientChatComposing: only the client it names is told", async () => {
    const typing = nextEvent(bystander(), "clientChatComposing", (e) => e.clientID === subjectID);
    const subjectHears = never(subject, "clientChatComposing", (e) => e.clientID === subjectID);
    await sendChatComposing(subject, asClientID(bystander().clientID));
    expect(await typing).toEqual({ clientID: subjectID, uid: subject.uid });
    expect(await subjectHears).toBe(true);
  }, 15_000);

  it("closePrivateChat: the client we wrote to is told", async () => {
    const closed = (client: Client) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no chat-closed notification")), EVENT_MS);
        const off = client.on("notification", (n) => {
          if (n.name !== "notifyclientchatclosed") return;
          clearTimeout(timer);
          off();
          resolve(n.params["clid"] ?? "");
        });
      });
    const c = asClientID(bystander().clientID);
    await sendPrivateMessage(subject, c, "a chat to close");
    const told = closed(bystander());
    await closePrivateChat(subject, c);
    expect(await told).toBe(String(subjectID));
  }, 15_000);

  // The five that TS3 raw ServerQuery was measured not to deliver: pinned here
  // so a server that starts to send one shows up.
  it.skipIf(QUERY_KIND !== "tcp")(
    "a TS3 raw ServerQuery client receives none of the voice-only notifications",
    async () => {
      const observer = rawObserver!;
      const names = new Set<string>();
      const off = observer.on("notification", (n) => names.add(n.name));
      try {
        await updateClient(subject, { isAway: true, awayMessage: "ev" });
        await updateClient(subject, { isAway: false, awayMessage: "" });
        await sendPluginCommand(subject, "ts-js-plug", "x", "server");
        await sendChatComposing(subject, asClientID(bystander().clientID));
        await new Promise((r) => setTimeout(r, 2_000));
      } finally {
        off();
        await updateClient(subject, { isAway: false, awayMessage: "" }).catch(() => {});
      }
      console.log("notifications the raw query client saw:", [...names]);
      for (const voiceOnly of [
        "notifyclientupdated",
        "notifyservergroupclientadded",
        "notifyservergroupclientdeleted",
        "notifyclientchannelgroupchanged",
        "notifyplugincmd",
        "notifyclientchatcomposing",
        "notifychannelsubscribed",
        "notifychannelunsubscribed",
      ]) {
        expect(names.has(voiceOnly), voiceOnly).toBe(false);
      }
    },
    20_000,
  );
});
