/**
 * Live measurement of the ServerQuery idle timeout, which `docs/flood-control.md`
 * quotes: a raw TCP or SSH session that sends no command for 300 seconds is
 * closed, however many notifications it receives, while one that sends a
 * command every 200 seconds stays open. The client keeps no session alive
 * itself, so this is what a caller has to know.
 *
 * The transports run together, so the file takes about six minutes. Per transport, A is idle with
 * events registered while C, an administrator query session, says something to the server
 * every 60 seconds; B sends `version` every 200 seconds.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/query/idle.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendServerMessage } from "@honeybbq/teamspeak";
import { KINDS, LiveSession, SKIP, sleep, stamp } from "./testing/live.js";

const IDLE_KINDS = KINDS.filter((kind) => kind !== "web");

describe.skipIf(SKIP || IDLE_KINDS.length === 0)("ServerQuery idle timeout — live", () => {
  const session = new LiveSession();

  beforeAll(async () => {
    await session.open(IDLE_KINDS);
  }, 60_000);

  afterAll(async () => {
    await session.close();
  });

  /** One transport's three sessions, all at once with the other transports'. */
  async function measure(kind: (typeof IDLE_KINDS)[number]): Promise<void> {
    const idle = await session.connectNew(kind, stamp("ts-js-idle-a"));
    const busy = await session.connectNew(kind, stamp("ts-js-idle-b"));
    // An administrator session: on TeamSpeak 6 a fresh guest's text message is refused (2568).
    const talker = await session.connectNew(kind, stamp("ts-js-idle-c"));
    let heard = 0;
    let sendFailure: Error | undefined;
    idle.on("textMessage", () => heard++);

    let closedAt: number | undefined;
    const started = performance.now();
    idle.on("disconnected", () => {
      closedAt ??= (performance.now() - started) / 1000;
    });
    const timers = [
      setInterval(() => {
        sendServerMessage(talker, "idle test").catch((error: unknown) => {
          sendFailure ??= error instanceof Error ? error : new Error(JSON.stringify(error));
        });
      }, 60_000),
      setInterval(() => {
        busy.exec("version").catch(() => {});
      }, 200_000),
    ];
    try {
      // B, at 320 seconds: it last sent a command at 200.
      await sleep(320_000 - (performance.now() - started));
      expect(busy.status, `${kind}: the busy session`).toBe("connected");
      expect((await busy.exec("version"))[0]?.["version"]).toBeDefined();

      // A, by 340 seconds at the latest.
      const isClosed = (): boolean => closedAt !== undefined;
      while (!isClosed() && performance.now() - started < 340_000) await sleep(1_000);
      expect(closedAt, `${kind}: the idle session was never closed`).toBeDefined();
      expect(closedAt!).toBeGreaterThanOrEqual(290);
      expect(closedAt!).toBeLessThanOrEqual(330);
      // Notifications arrived all along and did not count as activity.
      if (heard === 0 && sendFailure !== undefined) {
        throw sendFailure;
      }
      expect(heard, `${kind}: notifications received`).toBeGreaterThan(0);
      expect(idle.status).toBe("disconnected");
    } finally {
      for (const timer of timers) clearInterval(timer);
      await busy.disconnect().catch(() => {});
      await idle.disconnect().catch(() => {});
      await talker.disconnect().catch(() => {});
    }
  }

  it("closes an idle session between 290 and 330 seconds, and keeps one that sends a command every 200, on every transport at once", async () => {
    await Promise.all(IDLE_KINDS.map(measure));
  }, 420_000);
});
