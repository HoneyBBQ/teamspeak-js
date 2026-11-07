/**
 * ServerQuery events are opt-in: a client that names no `events` registers for
 * nothing and fetches no roster. Name the categories you want. See
 * docs/serverquery.md.
 *
 * Run:
 *   QUERY_PASSWORD=... pnpm tsx examples/query-events.ts
 */

import { QueryClient } from "@honeybbq/teamspeak/query";

const query = new QueryClient({
  transport: {
    kind: "tcp",
    host: process.env["QUERY_HOST"] ?? "127.0.0.1",
    login: { name: "serveradmin", password: process.env["QUERY_PASSWORD"] ?? "" },
  },
  server: { id: 1 },
  // Raw TCP on TeamSpeak 3 and SSH on TeamSpeak 6 accept these five. `bans` is
  // TeamSpeak 6 only; WebQuery accepts none, and refuses `events` at all.
  events: { categories: ["server", "channel", "textserver", "textchannel", "textprivate"] },
});

query.on("textMessage", (message) => console.log(message.invokerName, message.message));
await query.connect();
console.log("listening for ten minutes");
await new Promise((resolve) => setTimeout(resolve, 600_000));
await query.disconnect();
