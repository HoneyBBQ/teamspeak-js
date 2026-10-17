/**
 * A live connect while the server asks for a high puzzle level.
 *
 * Opt-in twice: it runs only when TEAMSPEAK_ADDR and TEAMSPEAK_EXPECT_PUZZLE_LEVEL
 * are set. The level is the server's protection level at work, which a server
 * raises under a burst of connections from several addresses, so this test never
 * raises it itself: whoever runs it holds the server at that level (a minute and
 * a half after the last burst it falls back), and then:
 *
 *   TEAMSPEAK_ADDR=127.0.0.1:9988 TEAMSPEAK_EXPECT_PUZZLE_LEVEL=1000000 \
 *     pnpm vitest run src/client/puzzle.integration.test.ts --reporter=verbose
 */

import { describe, expect, it } from "vitest";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import type { HandshakeDoneInfo } from "./trace.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const EXPECTED = Number(process.env["TEAMSPEAK_EXPECT_PUZZLE_LEVEL"] ?? "0");

describe.skipIf(ADDR === undefined || !(EXPECTED > 0))("Integration: a high puzzle level", () => {
  it("connects when the server asks for the level it is held at", async () => {
    let done: HandshakeDoneInfo | undefined;
    const client = new Client(generateIdentitySync(8), ADDR!, "PuzzleBot", {
      trace: {
        handshakeDone: (info) => {
          done = info;
        },
      },
    });
    try {
      await client.connect({ signal: AbortSignal.timeout(30_000) });
      expect(done?.puzzleLevel).toBe(EXPECTED);
      expect(client.status).toBe("connected");
    } finally {
      await client.disconnect({ signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
  }, 40_000);
});
