/**
 * Live tests of `banDurationMs` on `ClientLeaveEvent`, `KickedEvent`, and
 * `RemovedError`, plus the ServerQuery observer and reconnect refusal (3329)
 * while the ban stands.
 *
 * Opt-in like the rest of the integration suite: runs when TEAMSPEAK_ADDR and
 * a query endpoint are set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorCode,
  NotificationName,
  Reason,
  ServerError,
  banClient,
  deleteBan,
  kickClient,
  listBans,
} from "@honeybbq/teamspeak";
import type {
  BanID,
  ClientID,
  ClientLeaveEvent,
  DisconnectedEvent,
  KickedEvent,
  NotificationEvent,
} from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { RemovedError } from "./errors.js";
import { generateIdentitySync } from "./crypto/identity.js";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_CHANNEL,
  KINDS,
  LiveSession,
  SERVER_PASSWORD,
  SKIP,
  VOICE_ADDR,
  pauseAfterSshTests,
  sleep,
  stamp,
  withTimeout,
} from "../query/testing/live.js";
import type { QueryClient } from "../query/client.js";

const EVENT_KIND = KINDS.find((k) => k === "tcp" || k === "ssh");

pauseAfterSshTests();

function waitForLeave(
  source: {
    on(event: "clientLeave", listener: (e: ClientLeaveEvent) => void): () => void;
  },
  clientID: number,
): Promise<ClientLeaveEvent> {
  return withTimeout(
    new Promise<ClientLeaveEvent>((resolve) => {
      const off = source.on("clientLeave", (event) => {
        if (event.clientID === clientID) {
          off();
          resolve(event);
        }
      });
    }),
  );
}

describe.skipIf(SKIP || VOICE_ADDR === undefined)("ban duration — live", () => {
  const session = new LiveSession();
  let admin: QueryClient;
  let queryObserver: QueryClient | undefined;
  let observer: Client;
  let lastVoiceConnectAt = 0;

  async function connectVoice(nickname: string): Promise<{
    client: Client;
    identity: ReturnType<typeof generateIdentitySync>;
  }> {
    const waitMs = 2_200 - (Date.now() - lastVoiceConnectAt);
    if (waitMs > 0) await sleep(waitMs);
    const identity = generateIdentitySync(8);
    const client = new Client(identity, VOICE_ADDR!, nickname, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    lastVoiceConnectAt = Date.now();
    await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    return { client, identity };
  }

  async function waitUntilObserved(clientID: ClientID): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (observer.view.clients.has(clientID)) return;
      await sleep(100);
    }
    throw new Error(`observer never saw client ${clientID} enter view`);
  }

  function watchVictim(victim: Client) {
    const order: string[] = [];
    const kicked = withTimeout(
      new Promise<KickedEvent>((resolve) => {
        victim.once("kicked", (e) => {
          order.push("kicked");
          resolve(e);
        });
      }),
    );
    const disconnected = withTimeout(
      new Promise<DisconnectedEvent>((resolve) => {
        victim.once("disconnected", (e) => {
          order.push("disconnected");
          resolve(e);
        });
      }),
    );
    const notification = withTimeout(
      new Promise<NotificationEvent>((resolve) => {
        const off = victim.on("notification", (n) => {
          if (
            n.name === NotificationName.ClientLeftView &&
            Number(n.params["clid"]) === victim.clientID
          ) {
            order.push("notification");
            off();
            resolve(n);
          }
        });
      }),
    );
    return { order, kicked, disconnected, notification };
  }

  beforeAll(async () => {
    await session.open();
    admin = session.first();
    queryObserver = EVENT_KIND !== undefined ? session.clients.get(EVENT_KIND) : undefined;
    observer = await session.voice(stamp("ts-js-bd-obs"));
    lastVoiceConnectAt = Date.now();
  }, 60_000);

  afterAll(async () => {
    await session.close();
  }, 30_000);

  it("leaves banDurationMs undefined on a server kick and orders victim events", async () => {
    const { client: victim } = await connectVoice(stamp("ts-js-bd-kick"));
    try {
      await waitUntilObserved(victim.clientID);
      const watched = watchVictim(victim);
      const observerLeave = waitForLeave(observer, victim.clientID);
      const queryLeave =
        queryObserver !== undefined ? waitForLeave(queryObserver, victim.clientID) : undefined;

      await kickClient(admin, victim.clientID, Reason.KickServer, { reasonMessage: "behave" });

      const [kicked, disconnected, , obsEvent, queryEvent] = await Promise.all([
        watched.kicked,
        watched.disconnected,
        watched.notification,
        observerLeave,
        queryLeave,
      ]);

      expect(watched.order).toEqual(["kicked", "disconnected", "notification"]);
      expect(kicked.reason).toBe(Reason.KickServer);
      expect(kicked.banDurationMs).toBeUndefined();
      expect(disconnected.error).toBeInstanceOf(RemovedError);
      expect((disconnected.error as RemovedError).banDurationMs).toBeUndefined();
      expect(obsEvent.reason).toBe(Reason.KickServer);
      expect(obsEvent.banDurationMs).toBeUndefined();
      if (queryEvent !== undefined) {
        expect(queryEvent.reason).toBe(Reason.KickServer);
        expect(queryEvent.banDurationMs).toBeUndefined();
      }
    } finally {
      await victim.disconnect().catch(() => {});
    }
  }, 30_000);

  it("reports banDurationMs in milliseconds for a temporary ban and rejects reconnects with 3329", async () => {
    const { client: victim, identity } = await connectVoice(stamp("ts-js-bd-temp"));
    const before = new Set((await listBans(admin).catch(() => [])).map((b) => b.id));
    let created: BanID[] = [];

    try {
      await waitUntilObserved(victim.clientID);
      const watched = watchVictim(victim);
      const observerLeave = waitForLeave(observer, victim.clientID);
      const queryLeave =
        queryObserver !== undefined ? waitForLeave(queryObserver, victim.clientID) : undefined;

      created = await banClient(admin, victim.clientID, {
        durationMs: 5_000,
        reason: "temp ban",
      });

      const [kicked, disconnected, , obsEvent, queryEvent] = await Promise.all([
        watched.kicked,
        watched.disconnected,
        watched.notification,
        observerLeave,
        queryLeave,
      ]);

      expect(watched.order).toEqual(["kicked", "disconnected", "notification"]);
      expect(kicked.reason).toBe(Reason.KickServerBan);
      expect(kicked.banDurationMs).toBe(5_000);
      expect(disconnected.error).toBeInstanceOf(RemovedError);
      expect((disconnected.error as RemovedError).banDurationMs).toBe(5_000);
      expect(obsEvent.reason).toBe(Reason.KickServerBan);
      expect(obsEvent.banDurationMs).toBe(5_000);
      if (queryEvent !== undefined) {
        expect(queryEvent.reason).toBe(Reason.KickServerBan);
        expect(queryEvent.banDurationMs).toBe(5_000);
      }

      const waitMs = 2_200 - (Date.now() - lastVoiceConnectAt);
      if (waitMs > 0) await sleep(waitMs);
      const retry = new Client(identity, VOICE_ADDR!, stamp("ts-js-bd-retry"), {
        serverPassword: SERVER_PASSWORD,
        defaultChannel: DEFAULT_CHANNEL,
      });
      lastVoiceConnectAt = Date.now();
      let connectErr: unknown;
      try {
        await retry.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      } catch (error) {
        connectErr = error;
      } finally {
        await retry.disconnect().catch(() => {});
      }
      expect(connectErr).toBeInstanceOf(ServerError);
      const serverErr = connectErr as ServerError;
      expect(serverErr.code).toBe(ErrorCode.ConnectFailedBanned);
      expect(serverErr.extraMessage).toMatch(/^You are banned temporarily/);
    } finally {
      await victim.disconnect().catch(() => {});
      const toDelete = new Set<BanID>(created);
      for (const ban of await listBans(admin).catch(() => [])) {
        if (!before.has(ban.id)) toDelete.add(ban.id);
      }
      for (const id of toDelete) await deleteBan(admin, id).catch(() => {});
    }
  }, 45_000);

  it("reports banDurationMs as 0 for a permanent ban and rejects reconnects with 3329", async () => {
    const { client: victim, identity } = await connectVoice(stamp("ts-js-bd-perm"));
    const before = new Set((await listBans(admin).catch(() => [])).map((b) => b.id));
    let created: BanID[] = [];

    try {
      await waitUntilObserved(victim.clientID);
      const watched = watchVictim(victim);
      const observerLeave = waitForLeave(observer, victim.clientID);
      const queryLeave =
        queryObserver !== undefined ? waitForLeave(queryObserver, victim.clientID) : undefined;

      created = await banClient(admin, victim.clientID, { reason: "perm ban" });

      const [kicked, disconnected, , obsEvent, queryEvent] = await Promise.all([
        watched.kicked,
        watched.disconnected,
        watched.notification,
        observerLeave,
        queryLeave,
      ]);

      expect(kicked.reason).toBe(Reason.KickServerBan);
      expect(kicked.banDurationMs).toBe(0);
      expect(disconnected.error).toBeInstanceOf(RemovedError);
      expect((disconnected.error as RemovedError).banDurationMs).toBe(0);
      expect(obsEvent.reason).toBe(Reason.KickServerBan);
      expect(obsEvent.banDurationMs).toBe(0);
      if (queryEvent !== undefined) {
        expect(queryEvent.reason).toBe(Reason.KickServerBan);
        expect(queryEvent.banDurationMs).toBe(0);
      }

      const waitMs = 2_200 - (Date.now() - lastVoiceConnectAt);
      if (waitMs > 0) await sleep(waitMs);
      const retry = new Client(identity, VOICE_ADDR!, stamp("ts-js-bd-retry2"), {
        serverPassword: SERVER_PASSWORD,
        defaultChannel: DEFAULT_CHANNEL,
      });
      lastVoiceConnectAt = Date.now();
      let connectErr: unknown;
      try {
        await retry.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      } catch (error) {
        connectErr = error;
      } finally {
        await retry.disconnect().catch(() => {});
      }
      expect(connectErr).toBeInstanceOf(ServerError);
      const serverErr = connectErr as ServerError;
      expect(serverErr.code).toBe(ErrorCode.ConnectFailedBanned);
      expect(serverErr.extraMessage).toMatch(/^You are banned permanently/);
    } finally {
      await victim.disconnect().catch(() => {});
      const toDelete = new Set<BanID>(created);
      for (const ban of await listBans(admin).catch(() => [])) {
        if (!before.has(ban.id)) toDelete.add(ban.id);
      }
      for (const id of toDelete) await deleteBan(admin, id).catch(() => {});
    }
  }, 45_000);
});
