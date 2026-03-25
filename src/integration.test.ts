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

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SKIP = !ADDR;

// Shared connection — established once for the entire suite
let sharedClient: Client;

beforeAll(async () => {
  if (SKIP) return;

  const identity = generateIdentity(8);
  const client = new Client(identity, ADDR!, "ts-js-integ", {
    logger: {
      debug: () => {},
      info: (msg, ...args) => console.log("[INFO]", msg, ...args),
      warn: (msg, ...args) => console.warn("[WARN]", msg, ...args),
      error: (msg, ...args) => console.error("[ERROR]", msg, ...args),
    },
  });

  await client.connect();

  await client.waitConnected(AbortSignal.timeout(30_000));

  sharedClient = client;
}, 40_000);

afterAll(async () => {
  if (!sharedClient) return;
  await sharedClient.disconnect();
}, 10_000);

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

describe.skipIf(SKIP)("Integration — chenkr.cn", () => {
  it("receives a non-zero server-assigned client ID", () => {
    const clid = sharedClient.clientID();
    console.log(`connected: clid=${clid}`);
    expect(clid).toBeGreaterThan(0);
  });

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
