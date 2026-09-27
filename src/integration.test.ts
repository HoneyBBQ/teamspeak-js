/**
 * Integration tests against a live TeamSpeak 3 server.
 *
 * Opt-in: these tests only run when TEAMSPEAK_ADDR is set:
 *
 *   TEAMSPEAK_ADDR=chenkr.cn pnpm test --reporter=verbose src/integration.test.ts
 *
 * A single shared client is reused across all tests to avoid the TS3
 * anti-flood protection that bans IPs reconnecting too quickly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateIdentity } from "./crypto/identity.js";
import { Client } from "./client.js";
import { listChannels, listClients, getClientInfo } from "./api.js";
import type { ClientInfo } from "./types.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const DEFAULT_CHANNEL_PASSWORD = process.env["TEAMSPEAK_DEFAULT_CHANNEL_PASSWORD"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const SKIP = !ADDR;
const USES_CONNECT_AUTH =
  SERVER_PASSWORD !== "" || DEFAULT_CHANNEL !== "" || DEFAULT_CHANNEL_PASSWORD !== "";

// Shared connection — established once for the entire suite
let sharedClient: Client;
let selfClientEnter: Promise<ClientInfo>;

beforeAll(async () => {
  if (SKIP) return;

  const identity = generateIdentity(8);
  const client = new Client(identity, ADDR!, "ts-js-integ", {
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
      if (info.id === client.clientID()) resolve(info);
    });
  });

  await client.connect();

  await client.waitConnected(AbortSignal.timeout(30_000));

  sharedClient = client;
}, 40_000);

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
  const peer = new Client(generateIdentity(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    defaultChannelPassword: DEFAULT_CHANNEL_PASSWORD,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  setup?.(peer);
  peers.set(nickname, peer);
  await peer.connect();
  await peer.waitConnected(AbortSignal.timeout(30_000));
  return peer;
}

// Helper: skip a test if the server returns a permission error
function skipOnPermError(err: unknown): void {
  if (
    err instanceof Error &&
    (err.message.includes("insufficient") || err.message.includes("id=2568"))
  ) {
    // vitest doesn't have a native skip-inside-test API; log and return.
    console.log("SKIP — permission denied:", err.message);
    return;
  }
  throw err;
}

describe.skipIf(SKIP)("Integration — live TeamSpeak server", () => {
  it("connects with optional handshake auth configuration", () => {
    if (USES_CONNECT_AUTH) {
      console.log(
        `connect auth enabled: serverPassword=${SERVER_PASSWORD !== ""} defaultChannel=${DEFAULT_CHANNEL !== ""} defaultChannelPassword=${DEFAULT_CHANNEL_PASSWORD !== ""}`,
      );
    }
    expect(sharedClient.clientID()).toBeGreaterThan(0);
  });

  it("receives a non-zero server-assigned client ID", () => {
    const clid = sharedClient.clientID();
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

  it("listClients — finds ourselves in the list", async () => {
    let clients;
    try {
      clients = await listClients(sharedClient);
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    expect(clients.length).toBeGreaterThan(0);

    const ownID = sharedClient.clientID();
    const self = clients.find((c) => c.id === ownID);
    console.log(`self: clid=${ownID} nick="${self?.nickname}" cid=${self?.channelID}`);
    expect(self).toBeDefined();
  }, 15_000);

  it("listChannels — at least one channel exists", async () => {
    let channels;
    try {
      channels = await listChannels(sharedClient);
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    expect(channels.length).toBeGreaterThan(0);
    console.log(`channels: ${channels.length} found, first="${channels[0]?.name}"`);
  }, 15_000);

  it("joins the configured default channel when provided", async () => {
    if (DEFAULT_CHANNEL === "") return;

    let channels;
    let clients;
    try {
      [channels, clients] = await Promise.all([
        listChannels(sharedClient),
        listClients(sharedClient),
      ]);
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    const self = clients.find((client) => client.id === sharedClient.clientID());
    const currentChannel = channels.find((channel) => channel.id === self?.channelID);

    expect(self).toBeDefined();
    expect(currentChannel?.name).toBe(DEFAULT_CHANNEL);
  }, 15_000);

  it("listChannels — exposes channel_order", async () => {
    let channels;
    try {
      channels = await listChannels(sharedClient);
    } catch (err) {
      skipOnPermError(err);
      return;
    }

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

  it("getClientInfo — returns our own nickname", async () => {
    let info;
    try {
      info = await getClientInfo(sharedClient, sharedClient.clientID());
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    expect(Object.keys(info).length).toBeGreaterThan(0);
    console.log("clientinfo keys:", Object.keys(info).sort().join(", "));
    expect(info["client_nickname"]).toBeDefined();
  }, 15_000);

  it("clientMove — joins a password-protected channel", async () => {
    // Opt-in: needs a channel whose password the bot does not have permission
    // to bypass. Without the base64(sha1(pw)) encoding the server answers 781.
    if (PASSWORD_CHANNEL === "" || PASSWORD_CHANNEL_PASSWORD === "") return;

    let channels;
    try {
      channels = await listChannels(sharedClient);
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    const target = channels.find((c) => c.name === PASSWORD_CHANNEL);
    expect(target).toBeDefined();

    const { clientMove } = await import("./api.js");
    await clientMove(sharedClient, sharedClient.clientID(), target!.id, PASSWORD_CHANNEL_PASSWORD);
  }, 20_000);

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
      sharedClient.sendWhisper(frame, [listener.clientID()], 5);
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

    const ownID = sharedClient.clientID();
    // targetMode=1 = private message to client
    try {
      const { sendTextMessage } = await import("./api.js");
      await sendTextMessage(sharedClient, 1, BigInt(ownID), "hello from ts-js-integ");
    } catch (err) {
      skipOnPermError(err);
      return;
    }

    const msg = await Promise.race([
      received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("text message timeout")), 8_000),
      ),
    ]);

    expect(msg).toBe("hello from ts-js-integ");
  }, 15_000);
});
