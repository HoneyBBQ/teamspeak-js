/**
 * Live test that a command made by a create is the one that gets the row it
 * made, however the server orders it against the `error` line, and that the
 * command sent right after never gets it.
 *
 * Opt-in like the rest of the integration suite: they run when the fixture has
 * provisioned a query endpoint.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/query/late-rows.integration.test.ts --reporter=verbose
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { QueryClient } from "./client.js";
import type { QueryClientOptions } from "./options.js";
import { connectSsh } from "./ssh.js";

const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const QUERY_HOST = process.env["TEAMSPEAK_QUERY_HOST"] ?? "127.0.0.1";
const QUERY_PORT = Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011");
const QUERY_URL = process.env["TEAMSPEAK_QUERY_URL"] ?? "";
const QUERY_API_KEY = process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "";
const SSH_PORT = Number(process.env["TEAMSPEAK_QUERY_SSH_PORT"] ?? "0");
const SSH_HOST = process.env["TEAMSPEAK_QUERY_SSH_HOST"] ?? QUERY_HOST;
const SSH_USER = process.env["TEAMSPEAK_QUERY_SSH_USER"] ?? "";
const SSH_PASSWORD = process.env["TEAMSPEAK_QUERY_SSH_PASSWORD"] ?? "";

type Kind = "tcp" | "web" | "ssh";
const KINDS: readonly Kind[] = [
  ...(QUERY_KIND === "tcp" ? (["tcp"] as const) : []),
  ...(QUERY_URL !== "" && QUERY_API_KEY !== "" ? (["web"] as const) : []),
  ...(SSH_PORT > 0 ? (["ssh"] as const) : []),
];

const scratch = mkdtempSync(join(tmpdir(), "query-late-rows-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function optionsFor(kind: Kind): Promise<QueryClientOptions> {
  if (kind === "tcp") {
    return {
      transport: {
        kind: "tcp",
        host: QUERY_HOST,
        port: QUERY_PORT,
        login: {
          name: process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "",
          password: process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "",
        },
      },
      server: { id: 1 },
    };
  }
  if (kind === "web") {
    return {
      transport: { kind: "web", url: QUERY_URL, apiKey: QUERY_API_KEY },
      server: { id: 1 },
    };
  }
  let presented: { keyType: string; key: Uint8Array } | undefined;
  await connectSsh({
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    password: SSH_PASSWORD,
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
      username: SSH_USER,
      password: SSH_PASSWORD,
      knownHosts,
    },
    server: { id: 1 },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!KINDS.some((kind) => kind !== "web"))(
  "rows that follow an error line — live",
  () => {
    // TeamSpeak 6 over SSH writes a create's row after its `error` line when
    // other sessions are busy: with two others creating and deleting channels,
    // about a quarter of the creates below lost their id, and about as many
    // handed a stray row to the command after them, before this was handled.
    // Idle, it is rare, so the load is part of the test. Whatever the ordering,
    // every create has its own id and no other command is given a stray row.
    // WebQuery answers each command whole, so there is no ordering to test.
    it.each(KINDS.filter((kind) => kind !== "web"))(
      "%s: every channelcreate has its id and the command after it its own rows",
      async (kind) => {
        const options = await optionsFor(kind);
        const client = new QueryClient(options);
        const others = [new QueryClient(options), new QueryClient(options)];
        await client.connect({ signal: AbortSignal.timeout(15_000) });
        for (const other of others) await other.connect({ signal: AbortSignal.timeout(15_000) });
        const tag = Date.now() % 1_000_000;
        const state = { stop: false };
        const churn = async (other: QueryClient, k: number): Promise<void> => {
          while (!state.stop) {
            const made = await other
              .exec(`channelcreate channel_name=churn-${tag}-${k}-${Date.now()}`)
              .catch(() => []);
            const cid = made[0]?.["cid"];
            if (cid !== undefined)
              await other.exec(`channeldelete cid=${cid} force=1`).catch(() => {});
            await sleep(30);
          }
        };
        const loads = others.map((other, k) => churn(other, k));
        let missing = 0;
        const strays: unknown[] = [];
        try {
          for (let i = 0; i < 150; i++) {
            const made = await client.exec(`channelcreate channel_name=late-${tag}-${i}`);
            const next = await client.exec("whoami");
            const cid = made[0]?.["cid"];
            if (cid === undefined) missing++;
            if (next.length !== 1 || next[0]?.["cid"] !== undefined) strays.push(next);
            if (cid !== undefined) await client.exec(`channeldelete cid=${cid} force=1`);
            await sleep(60);
          }
        } finally {
          state.stop = true;
          await Promise.all(loads);
          for (const c of [client, ...others]) await c.disconnect().catch(() => {});
        }
        expect(strays, "rows handed to the command after a create").toEqual([]);
        expect(missing, "creates answered without their id").toBe(0);
      },
      180_000,
    );
  },
);
