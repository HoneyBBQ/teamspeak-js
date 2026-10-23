/**
 * Live test that a reconnect loop gives up at a refused `use`, with the server's
 * own error, instead of looping.
 *
 * Opt-in like the rest of the integration suite: it runs when the fixture has
 * provisioned a raw TCP query endpoint.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/query/reconnect.integration.test.ts
 */

import { createConnection, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { ErrorCode, ServerError } from "@honeybbq/teamspeak";
import { QueryClient } from "./client.js";

const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HOST = process.env["TEAMSPEAK_QUERY_HOST"] ?? "127.0.0.1";
const PORT = Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011");
const NAME = process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "";
const PASSWORD = process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "";

describe.skipIf(QUERY_KIND !== "tcp")("reconnect — live", () => {
  // TeamSpeak 3 3.13.8 answers `use` of a virtual server that is not running
  // with 1033, "server is not running". The reconnect attempt's `use` is
  // rewritten to name one, after the first connection has dropped: before the
  // loop gave up at a refused `use`, 1033 was retried until the attempts ran out,
  // each try a login and a use that count towards the server's flood ban.
  it("gives up at the server's refusal of `use` instead of looping", async () => {
    let dials = 0;
    let first: Socket | undefined;
    const attempts: string[] = [];
    const client = new QueryClient({
      transport: {
        kind: "tcp",
        host: HOST,
        port: PORT,
        login: { name: NAME, password: PASSWORD },
        connect: (host, port) => {
          const socket = createConnection({ host, port });
          const attempt = ++dials;
          if (attempt === 1) first = socket;
          const write = socket.write.bind(socket) as (chunk: string, ...rest: unknown[]) => boolean;
          (socket as { write: unknown }).write = (chunk: string, ...rest: unknown[]) => {
            const text = chunk;
            if (attempt > 1 && text.startsWith("use ")) {
              attempts.push(text.trim());
              return write("use sid=999\n", ...rest);
            }
            return write(chunk, ...rest);
          };
          return socket;
        },
      },
      server: { id: 1 },
      events: false,
      reconnect: { backoff: { initialDelayMs: 200, maxDelayMs: 300, jitter: 0, maxAttempts: 6 } },
    });
    const verdicts: Array<{ error: Error | undefined; willReconnect: boolean }> = [];
    client.on("disconnected", (event) => verdicts.push(event));
    try {
      await client.connect({ signal: AbortSignal.timeout(15_000) });
      first!.destroy(new Error("dropped for the test"));
      await expect
        .poll(() => verdicts.some((v) => !v.willReconnect), { timeout: 20_000 })
        .toBe(true);
      await new Promise((r) => setTimeout(r, 1_000));

      expect(dials, "the first connection and one reconnect attempt").toBe(2);
      expect(attempts).toHaveLength(1);
      const last = verdicts.at(-1)!;
      expect(last.error).toBeInstanceOf(ServerError);
      expect((last.error as ServerError).code).toBe(ErrorCode.ServerIsNotRunning);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }, 40_000);
});
