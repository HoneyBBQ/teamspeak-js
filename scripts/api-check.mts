/**
 * Fails when the public API of a published entry point differs from the report
 * committed in api/, and shows the difference.
 *
 * API Extractor does the comparing: run without --local, it refuses to update
 * the report. It says only that the report changed, though, so this prints
 * the diff of the committed report against the one it just made, for every
 * entry point rather than the first that fails. Run `pnpm build` first, or use
 * `pnpm api:check`, which does.
 */

import { spawnSync } from "node:child_process";

const reports = "api";
// One config and one report per public entry point: `.`, `./client`,
// `./query` and `./stream`.
const entries = [
  { specifier: "@honeybbq/teamspeak", name: "core", config: "api-extractor.core.json" },
  { specifier: "@honeybbq/teamspeak/client", name: "client", config: "api-extractor.client.jsonc" },
  { specifier: "@honeybbq/teamspeak/query", name: "query", config: "api-extractor.query.jsonc" },
  { specifier: "@honeybbq/teamspeak/stream", name: "stream", config: "api-extractor.stream.jsonc" },
];

let failed = false;
for (const { specifier, name, config } of entries) {
  const report = `${name}.api.md`;
  const run = spawnSync("api-extractor", ["run", "-c", config], {
    stdio: "inherit",
  });
  if (run.status === 0) continue;

  failed = true;
  console.error(`\n${specifier}: the public API differs from ${reports}/${report}`);
  spawnSync("diff", ["-u", `${reports}/${report}`, `node_modules/.cache/api-extractor/${report}`], {
    stdio: "inherit",
  });
}

if (failed) {
  console.error("\nIf the change is deliberate, run `pnpm api:report` and commit the reports.");
  process.exit(1);
}
