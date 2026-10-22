/**
 * WebQuery over HTTPS, against a live server.
 *
 * The rest of the live suite reaches WebQuery over plain HTTP; this one proves
 * the TLS path against a real server's own handshake, with a certificate from
 * a CA made for the run. Opt-in: it runs when all three are set.
 *
 *   TEAMSPEAK_QUERY_HTTPS_URL      the https:// base URL, such as https://127.0.0.1:10443
 *   TEAMSPEAK_QUERY_HTTPS_CA       the path of the PEM file of the CA that signed its certificate
 *   TEAMSPEAK_QUERY_HTTPS_API_KEY  an api key of that server (TEAMSPEAK_QUERY_API_KEY when unset)
 *
 * `scripts/webquery-tls.sh` makes the certificates, and the CI job shows how a
 * TeamSpeak 6 server serves them itself and how a TeamSpeak 3 server, which
 * has no HTTPS of its own, is fronted by a TLS terminator. Nothing here needs
 * the fixture's channels or groups, so a bare server will do.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ServerError,
  getChannelInfo,
  getVersion,
  listChannels,
  whoAmI,
  asChannelID,
} from "@honeybbq/teamspeak";
import { QueryClient } from "./client.js";
import { fetchTrusting } from "./testing/trusting-fetch.js";

const URL_ = process.env["TEAMSPEAK_QUERY_HTTPS_URL"] ?? "";
const CA_FILE = process.env["TEAMSPEAK_QUERY_HTTPS_CA"] ?? "";
const API_KEY =
  process.env["TEAMSPEAK_QUERY_HTTPS_API_KEY"] ?? process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "";
const SKIP = URL_ === "" || CA_FILE === "" || API_KEY === "";

/** A client that trusts the run's CA through a `fetch`, the public way to trust a private CA. */
function trusting(apiKey: string = API_KEY): QueryClient {
  return new QueryClient({
    transport: { kind: "web", url: URL_, apiKey, fetch: fetchTrusting(readFileSync(CA_FILE)) },
    server: { id: 1 },
  });
}

describe.skipIf(SKIP)("Integration — WebQuery over HTTPS", () => {
  it("connects, reads the version and the identity, and lists", async () => {
    const client = trusting();
    await client.connect({ signal: AbortSignal.timeout(15_000) });
    try {
      expect(client.serverFamily).not.toBe("unknown");
      expect((await getVersion(client)).version).toBe(client.serverVersion);
      expect((await whoAmI(client)).nickname).not.toBe("");
      expect((await listChannels(client)).length).toBeGreaterThan(0);
      expect(client.stats.address).toBe(URL_.replace(/\/+$/, ""));
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it("maps a refusal from the server to its code", async () => {
    const client = trusting();
    await client.connect({ signal: AbortSignal.timeout(15_000) });
    try {
      await expect(getChannelInfo(client, asChannelID(999_999n))).rejects.toMatchObject({
        code: ErrorCode.ChannelInvalidID,
      });
    } finally {
      await client.disconnect();
    }
  }, 30_000);

  it("maps a wrong api key to the server's code", async () => {
    const client = trusting("not-an-api-key");
    const failure = await client.connect({ signal: AbortSignal.timeout(15_000) }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ServerError);
    expect((failure as ServerError).code).toBe(ErrorCode.APIKeyInvalid);
  }, 30_000);

  it("refuses the server's certificate when nothing trusts its CA", async () => {
    // The default fetch verifies against Node's own trust store, which does not
    // hold the run's CA; the connection must fail and never fall back to
    // skipping the check.
    const client = new QueryClient({
      transport: { kind: "web", url: URL_, apiKey: API_KEY },
      server: { id: 1 },
    });
    const failure = await client.connect({ signal: AbortSignal.timeout(15_000) }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    const text = `${failure?.message} ${(failure?.cause as Error | undefined)?.message ?? ""}`;
    expect(text).toMatch(/certificate|issuer/i);
  }, 30_000);

  it("refuses it when the CA given is not the one that signed it", async () => {
    const other = readFileSync(new URL("../../test/fixtures/tls/ca.pem", import.meta.url));
    const client = new QueryClient({
      transport: { kind: "web", url: URL_, apiKey: API_KEY, fetch: fetchTrusting(other) },
      server: { id: 1 },
    });
    await expect(client.connect({ signal: AbortSignal.timeout(15_000) })).rejects.toThrow();
  }, 30_000);
});
