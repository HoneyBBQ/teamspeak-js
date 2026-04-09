/**
 * Integration test: connect to one or more TeamSpeak servers and verify
 * the full handshake completes successfully.
 *
 * Servers are specified via environment variables:
 *   TS3_ADDR  — address of a TS3 server (default: localhost:9987)
 *   TS6_ADDR  — address of a TS6 server (default: localhost:9988)
 *
 * Set either variable to an empty string to skip that server.
 *
 * Run locally (requires Docker):
 *   docker run -d --name ts3 --platform linux/amd64 -p 9987:9987/udp \
 *     -e TS3SERVER_LICENSE=accept teamspeak:latest
 *   docker run -d --name ts6 -p 9988:9987/udp \
 *     -e TSSERVER_LICENSE_ACCEPTED=accept teamspeaksystems/teamspeak6-server:latest
 *   pnpm tsx examples/test-servers.ts
 *   docker stop ts3 ts6 && docker rm ts3 ts6
 */

import { generateIdentity } from "../src/crypto/identity.js";
import { Client } from "../src/client.js";

const logger = {
  debug: () => {},
  info: (msg: string, ...a: unknown[]) => console.log("[INFO] ", msg, ...a),
  warn: (msg: string, ...a: unknown[]) => console.warn("[WARN] ", msg, ...a),
  error: (msg: string, ...a: unknown[]) => console.error("[ERROR]", msg, ...a),
};

async function testServer(name: string, addr: string): Promise<boolean> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[TEST] ${name} @ ${addr}`);
  console.log("=".repeat(60));

  const identity = generateIdentity(8);
  const client = new Client(identity, addr, "ts-js-test", { logger });

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      console.error(`[TEST] ${name} — TIMEOUT (30s)`);
      client.disconnect().catch(() => {});
      resolve(false);
    }, 30_000);

    client.on("connected", () => {
      clearTimeout(timeout);
      console.log(`[TEST] ${name} — ✅ CONNECTED! clid=${client.clientID()}`);
      client.disconnect().catch(() => {});
      resolve(true);
    });

    client.on("disconnected", (err) => {
      clearTimeout(timeout);
      if (err) {
        console.error(`[TEST] ${name} — ❌ DISCONNECTED with error: ${err.message}`);
        resolve(false);
      }
    });

    client.connect().catch((err: Error) => {
      clearTimeout(timeout);
      console.error(`[TEST] ${name} — ❌ CONNECT FAILED: ${err.message}`);
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  const servers: Array<{ name: string; addr: string }> = [];

  const ts3Addr = process.env["TS3_ADDR"] ?? "localhost:9987";
  const ts6Addr = process.env["TS6_ADDR"] ?? "localhost:9988";

  if (ts3Addr) servers.push({ name: "TS3", addr: ts3Addr });
  if (ts6Addr) servers.push({ name: "TS6", addr: ts6Addr });

  if (servers.length === 0) {
    console.error("[FATAL] No servers configured. Set TS3_ADDR or TS6_ADDR.");
    process.exit(1);
  }

  const results: Array<{ name: string; ok: boolean }> = [];
  for (const { name, addr } of servers) {
    results.push({ name, ok: await testServer(name, addr) });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[RESULTS]`);
  let allOk = true;
  for (const { name, ok } of results) {
    console.log(`  ${name}: ${ok ? "✅ OK" : "❌ FAILED"}`);
    if (!ok) allOk = false;
  }
  console.log("=".repeat(60));

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
