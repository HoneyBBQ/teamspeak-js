/**
 * Keeping a raw TCP or SSH ServerQuery session open. The server closes a session
 * that sent no command for 300 seconds, however many notifications it received,
 * and the client sends nothing of its own. This line middleware sends `version`
 * when no command went out for a while. WebQuery has no session to keep.
 * See docs/flood-control.md.
 *
 * Run:
 *   QUERY_PASSWORD=... pnpm tsx examples/query-keepalive.ts
 */

import { pathToFileURL } from "node:url";
import type { LineMiddleware } from "@honeybbq/teamspeak";
import { QueryClient } from "@honeybbq/teamspeak/query";

/**
 * `version` once no command has gone out for `idleMs`. A session that sent one
 * every 200 seconds stayed open; 120 seconds leaves room. The timer is
 * unref'd, so it does not keep the process alive, and it goes on until the
 * process ends: call `stop()` when the client is done.
 */
export function keepAlive(
  client: () => QueryClient,
  idleMs = 120_000,
): { middleware: LineMiddleware; stop(): void } {
  let lastSent = Date.now();
  const timer = setInterval(
    () => {
      if (Date.now() - lastSent < idleMs || client().status !== "connected") return;
      // Goes through this middleware as well, which records it as a command.
      client()
        .exec("version")
        .catch(() => {});
    },
    Math.max(idleMs / 4, 1_000),
  );
  timer.unref();
  return {
    middleware: (next) => (line, options) => {
      lastSent = Date.now();
      return next(line, options);
    },
    stop: () => clearInterval(timer),
  };
}

async function main(): Promise<void> {
  const held: { query?: QueryClient } = {};
  const idle = keepAlive(() => held.query!);
  const query = new QueryClient({
    transport: {
      kind: "tcp",
      host: process.env["QUERY_HOST"] ?? "127.0.0.1",
      login: { name: "serveradmin", password: process.env["QUERY_PASSWORD"] ?? "" },
    },
    server: { id: 1 },
    lineMiddleware: [idle.middleware],
  });
  held.query = query;
  await query.connect();
  console.log("connected; leaving it idle for ten minutes");
  await new Promise((resolve) => setTimeout(resolve, 600_000));
  idle.stop();
  await query.disconnect();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
