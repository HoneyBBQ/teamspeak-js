/**
 * Live test of a disconnect with commands queued in the flood throttle: the
 * goodbye must reach the server, which is shown by an immediate reconnection
 * with the same identity succeeding.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/client/command-lifecycle.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { NotConnectedError } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const RUN = Date.now().toString(36).slice(-5);

describe.skipIf(!ADDR)("disconnect with commands waiting in the throttle", () => {
  it("is heard by the server: the same identity reconnects at once", async () => {
    const identity = generateIdentitySync(8);
    const options = { serverPassword: SERVER_PASSWORD, defaultChannel: DEFAULT_CHANNEL };
    const first = new Client(identity, ADDR!, `ts-js-lc-${RUN}`, options);
    await first.connect({ signal: AbortSignal.timeout(15_000) });
    try {
      // Far more than the throttle's burst, so most of them are still waiting.
      const queued = Array.from({ length: 16 }, () =>
        first.exec("whoami").then(
          () => "answered",
          (error: unknown) => (error instanceof NotConnectedError ? "rejected" : String(error)),
        ),
      );
      const started = performance.now();
      await first.disconnect();
      expect(performance.now() - started).toBeLessThan(900);
      const outcomes = await Promise.all(queued);
      expect(outcomes).toContain("rejected");
      expect(outcomes.filter((o) => o !== "answered" && o !== "rejected")).toEqual([]);
    } finally {
      await first.disconnect().catch(() => {});
    }

    // Immediately, with the same identity: a ghost session of the first would
    // refuse it (error 521).
    const second = new Client(identity, ADDR!, `ts-js-lc2-${RUN}`, options);
    try {
      await second.connect({ signal: AbortSignal.timeout(15_000) });
      expect(second.status).toBe("connected");
    } finally {
      await second.disconnect().catch(() => {});
    }
  }, 60_000);
});
