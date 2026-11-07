/**
 * Live test of a disconnect with commands waiting in a line middleware: they
 * reject with a NotConnectedError and never reach the server, and the goodbye
 * is not held, which is shown by an immediate reconnection with the same
 * identity succeeding.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/client/command-lifecycle.integration.test.ts
 */

import { describe, expect, it } from "vitest";
import { NotConnectedError, type LineMiddleware } from "@honeybbq/teamspeak";
import { Client, onSentLine } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const RUN = Date.now().toString(36).slice(-5);

describe.skipIf(!ADDR)("disconnect with commands waiting in a line middleware", () => {
  it("rejects them unsent, says goodbye at once, and the same identity reconnects", async () => {
    const identity = generateIdentitySync(8);
    // Holds every line until the connection ends, as a pacer that is paused would.
    const holding: LineMiddleware = (next) => async (line, options) => {
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return next(line, options);
    };
    const options = {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
      lineMiddleware: [holding],
    };
    const first = new Client(identity, ADDR!, `ts-js-lc-${RUN}`, options);
    await first.connect({ signal: AbortSignal.timeout(15_000) });
    const written: string[] = [];
    onSentLine((_client, line) => void written.push(line));
    try {
      const queued = Array.from({ length: 16 }, () =>
        first.exec("whoami").then(
          () => "answered",
          (error: unknown) => (error instanceof NotConnectedError ? "rejected" : String(error)),
        ),
      );
      const started = performance.now();
      await first.disconnect();
      expect(performance.now() - started).toBeLessThan(900);
      expect(await Promise.all(queued)).toEqual(Array.from({ length: 16 }, () => "rejected"));
      // Only the goodbye was written: the held lines never reached the server.
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^clientdisconnect /);
    } finally {
      onSentLine(undefined);
      await first.disconnect().catch(() => {});
    }

    // Immediately, with the same identity: a ghost session of the first would
    // refuse it (error 521).
    const second = new Client(identity, ADDR!, `ts-js-lc2-${RUN}`, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    try {
      await second.connect({ signal: AbortSignal.timeout(15_000) });
      expect(second.status).toBe("connected");
    } finally {
      await second.disconnect().catch(() => {});
    }
  }, 60_000);
});
