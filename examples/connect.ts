/**
 * Minimal example: connect to chenkr.cn and print server info.
 *
 * Run:
 *   pnpm tsx examples/connect.ts
 *
 * Or with a custom address:
 *   TEAMSPEAK_ADDR=chenkr.cn:9987 pnpm tsx examples/connect.ts
 */

import { generateIdentity } from "../src/crypto/identity.js";
import { Client } from "../src/client.js";
import { listChannels, listClients } from "../src/api.js";

const ADDR = process.env["TEAMSPEAK_ADDR"] ?? "chenkr.cn";

async function main(): Promise<void> {
  console.log(`[example] generating identity (level 8)…`);
  const identity = generateIdentity(8);
  console.log(`[example] identity UID: ${identity.publicKeyBase64().slice(0, 24)}…`);

  const client = new Client(identity, ADDR, "ts-js-example", {
    logger: {
      debug: () => {},
      info: (msg, ...a) => console.log("[INFO]", msg, ...a),
      warn: (msg, ...a) => console.warn("[WARN]", msg, ...a),
      error: (msg, ...a) => console.error("[ERROR]", msg, ...a),
    },
  });

  // Register event handlers before connecting
  client.on("connected", () => {
    console.log(`[example] connected! self clid=${client.clientID()}`);
  });

  client.on("disconnected", (err) => {
    if (err) console.error("[example] disconnected with error:", err.message);
    else console.log("[example] disconnected cleanly");
  });

  client.on("clientEnter", (info) => {
    console.log(`[event] clientEnter  clid=${info.id} nick="${info.nickname}"`);
  });

  client.on("clientLeave", (evt) => {
    console.log(`[event] clientLeave  clid=${evt.id} reasonID=${evt.reasonID}`);
  });

  client.on("textMessage", (msg) => {
    console.log(
      `[event] textMessage  from="${msg.invokerName}" (${msg.invokerUID}): ${msg.message}`,
    );
  });

  console.log(`[example] connecting to ${ADDR}…`);
  await client.connect();

  // Wait up to 30s for the handshake to complete
  await client.waitConnected(AbortSignal.timeout(30_000));
  console.log(`[example] handshake complete, clid=${client.clientID()}`);

  // List channels
  try {
    const channels = await listChannels(client);
    console.log(`\n[example] ${channels.length} channel(s):`);
    for (const ch of channels) {
      const indent = ch.parentID === 0n ? "  " : "    ";
      console.log(`${indent}[cid=${ch.id}] ${ch.name}`);
    }
  } catch (err) {
    console.warn("[example] channellist error (permission?):", (err as Error).message);
  }

  // List clients
  try {
    const clients = await listClients(client);
    console.log(`\n[example] ${clients.length} client(s) online:`);
    for (const cl of clients) {
      const marker = cl.id === client.clientID() ? " ← (me)" : "";
      console.log(`  [clid=${cl.id}] ${cl.nickname}${marker}`);
    }
  } catch (err) {
    console.warn("[example] clientlist error (permission?):", (err as Error).message);
  }

  // Stay connected for 10s to observe events, then disconnect
  console.log("\n[example] listening for events for 10s…");
  await new Promise<void>((resolve) => setTimeout(resolve, 10_000));

  console.log("[example] disconnecting…");
  await client.disconnect();
  console.log("[example] done.");
}

main().catch((err) => {
  console.error("[example] fatal:", err);
  process.exit(1);
});
