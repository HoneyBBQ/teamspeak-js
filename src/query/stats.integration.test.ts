/**
 * Live tests of `QueryClient.stats` and of the version helpers against the
 * version a real server reports, over every transport the fixture provisioned.
 *
 * Opt-in like the rest of the integration suite: they run when the fixture has
 * provisioned a query endpoint.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/query/stats.integration.test.ts --reporter=verbose
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getVersion, serverFamilyForVersion, whoAmI } from "@honeybbq/teamspeak";
import { uidAlgorithmForVersion } from "../client/crypto/identity.js";
import { QueryClient } from "./client.js";
import type { QueryClientOptions } from "./options.js";
import { connectSsh } from "./ssh.js";

const FAMILY = process.env["TEAMSPEAK_QUERY_FAMILY"] ?? "";
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

const scratch = mkdtempSync(join(tmpdir(), "query-stats-"));
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

describe.skipIf(KINDS.length === 0)("QueryClient.stats and the version helpers — live", () => {
  it.each(KINDS)(
    "%s: the counters grow with each command, and the address leaks no secret",
    async (kind) => {
      const client = new QueryClient(await optionsFor(kind));
      expect(client.stats.transport).toBeUndefined();
      await client.connect({ signal: AbortSignal.timeout(15_000) });
      try {
        const before = client.stats;
        console.log(kind, "stats after connect:", before);
        expect(before.transport).toBe(kind);
        expect(before.connectedAt).toBeInstanceOf(Date);
        expect(before.bytesSent).toBeGreaterThan(0);
        expect(before.bytesReceived).toBeGreaterThan(0);
        expect(before.address).not.toContain(QUERY_API_KEY === "" ? "\0" : QUERY_API_KEY);
        expect(before.address).not.toContain(SSH_PASSWORD === "" ? "\0" : SSH_PASSWORD);
        await whoAmI(client);
        const after = client.stats;
        expect(after.bytesSent).toBeGreaterThan(before.bytesSent);
        expect(after.bytesReceived).toBeGreaterThan(before.bytesReceived);
        expect(after.connectedAt).toEqual(before.connectedAt);

        const { version } = await getVersion(client);
        expect(client.serverVersion).toBe(version);
        expect(client.serverFamily).toBe(serverFamilyForVersion(version));
        if (FAMILY !== "") expect(serverFamilyForVersion(version)).toBe(FAMILY);
        expect(uidAlgorithmForVersion(version)).toBe(FAMILY === "ts6" ? "sha256" : "sha1");
      } finally {
        await client.disconnect().catch(() => {});
      }
      expect(client.stats.transport).toBeUndefined();
    },
    40_000,
  );
});
