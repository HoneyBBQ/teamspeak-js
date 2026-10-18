/**
 * Live tests of the instance commands that cannot be undone: stopping and
 * deleting virtual servers, restoring a snapshot over one, editing the
 * instance, resetting every permission, and stopping the process. They run
 * against a server that is thrown away afterwards, so each is off until the
 * environment says it may be:
 *
 *   TEAMSPEAK_QUERY_DESTRUCTIVE=1       the lifecycle, the snapshot round trip,
 *                                       the instance edit and the permission reset
 *   TEAMSPEAK_QUERY_STOP_INSTANCE=1     `stopInstance`, which ends the server
 *                                       process
 *
 * Run this file on its own, after every other suite: the permission reset
 * removes what the fixture granted, and the stop ends the server. The CI
 * workflow runs it as the last step of the job (`pnpm test:integration:instance`).
 * The tests in it run in the order they are written.
 *
 * A server's license limits how many virtual servers run at once, and the free
 * one allows a single one, so the lifecycle stops the server the fixture
 * provisioned to make room for a second, and starts it again at the end.
 */

import { describe, expect, it } from "vitest";
import {
  ClientStatus,
  GroupType,
  PropertyName,
  addServerGroupPermission,
  createChannel,
  createServer,
  createServerGroup,
  createServerSnapshot,
  deleteChannel,
  deleteServer,
  deployServerSnapshot,
  editInstance,
  getInstanceInfo,
  listChannels,
  listServerGroups,
  listServers,
  permissionByName,
  resetPermissions,
  startServer,
  stopInstance,
  stopServer,
  type CommandExecutor,
  type ServerID,
} from "@honeybbq/teamspeak";
import type { QueryClient } from "./client.js";
import {
  DESTRUCTIVE,
  KINDS,
  LiveSession,
  SKIP,
  SERVER_FAMILY,
  STOP_INSTANCE,
  pauseAfterSshTests,
  sleep,
  stamp,
  type Kind,
} from "./testing/live.js";

pauseAfterSshTests();

/** The status of one server on the instance's list. */
async function statusOf(client: CommandExecutor, id: ServerID): Promise<string> {
  const servers = await listServers(client, { short: true }).catch(() => []);
  return servers.find((s) => s.id === id)?.status ?? "absent";
}

/** The code a refusal carries, or undefined when the call worked. */
async function codeOf(run: () => Promise<unknown>): Promise<number | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

/** The ids of the channels the server has, by name. */
async function channelNames(client: CommandExecutor): Promise<Set<string>> {
  return new Set((await listChannels(client)).map((c) => c.name));
}

describe.skipIf(SKIP || !DESTRUCTIVE)("Integration — instance (throwaway server only)", () => {
  const session = new LiveSession();

  /** A connection of its own, so that a server going away takes no shared one with it. */
  async function own(kind: Kind, selectServer: boolean = true): Promise<QueryClient> {
    const client = await session.connectNew(kind, stamp("ts-js-inst"), selectServer);
    // A server a connection has selected reports as "online virtual" once it is
    // stopped, whatever the list says for the others, so the lifecycle puts the
    // connection on no server first: a refused `use` leaves it there. WebQuery
    // selects per request, and is made without a server instead.
    if (!selectServer && kind !== "web") await client.use({ id: 9999 }).catch(() => {});
    return client;
  }

  it("probes the transports", async () => {
    await session.open();
    expect(session.clients.size).toBe(KINDS.length);
    // These are only here to find the host key; each test uses its own.
    for (const client of session.clients.values()) await client.disconnect();
    session.clients.clear();
  }, 90_000);

  describe.each(KINDS)("over %s", (kind: Kind) => {
    // A second virtual server is created, stopped, started and deleted, beside
    // the one the fixture provisioned.
    // Measured on TS3 over WebQuery: its api key is bound to server 1, which then
    // counts as selected, and a selected server that is stopped reads "online
    // virtual" in the list and is stopped again without the 1033 a stopped
    // server gives. Over raw TCP and SSH on TS3, and over every transport of
    // TS6, the connection is put on no server and the list says "offline".
    it.skipIf(kind === "web" && SERVER_FAMILY === "ts3")(
      "creates, stops, starts and deletes a second virtual server",
      async () => {
        const client = await own(kind, false);
        try {
          const [base] = await listServers(client, { short: true });
          expect(base, "the fixture's server").toBeDefined();
          let created: ServerID | undefined;
          try {
            // Room first: a license of one server counts the running ones.
            await stopServer(client, base!.id, { reason: "making room for the lifecycle test" });
            expect(await statusOf(client, base!.id)).toBe("offline");
            expect(await codeOf(() => stopServer(client, base!.id))).toBe(1033);

            const made = await createServer(client, "ts-js lifecycle test", {
              virtualserver_port: String(base!.port + 1),
              virtualserver_maxclients: "4",
            });
            created = made.id;
            expect(made.id).not.toBe(base!.id);
            expect(made.port).toBe(base!.port + 1);
            expect(made.token).not.toBe("");
            expect(await statusOf(client, made.id)).toBe("online");

            // A running server is not deleted; a stopped one is.
            expect(await codeOf(() => deleteServer(client, made.id))).toBe(1035);
            await stopServer(client, made.id);
            const offline = await listServers(client, { onlyOffline: true, short: true });
            expect(offline.some((s) => s.id === made.id)).toBe(true);

            await startServer(client, base!.id);
            expect(await statusOf(client, base!.id)).toBe("online");

            await deleteServer(client, made.id, { noEvent: true });
            created = undefined;
            expect(await statusOf(client, made.id)).toBe("absent");
            expect(await codeOf(() => deleteServer(client, made.id))).toBe(1024);
          } finally {
            if (created !== undefined && (await statusOf(client, created)) !== "absent") {
              await stopServer(client, created).catch(() => {});
              await deleteServer(client, created).catch(() => {});
            }
            if ((await statusOf(client, base!.id)) !== "online") {
              await startServer(client, base!.id).catch(() => {});
            }
          }
        } finally {
          await client.disconnect().catch(() => {});
        }
        // The first server is serving again before the next transport starts.
        await sleep(1_000);
      },
      120_000,
    );

    // A snapshot of the server is restored over it: a channel made after the
    // snapshot is gone again, one deleted after it is back, and the mapping says
    // which channel each one became.
    it("restores a snapshot over the server", async () => {
      const client = await own(kind);
      const kept = stamp("ts-js-snap-kept");
      const extra = stamp("ts-js-snap-extra");
      try {
        const keptID = await createChannel(client, { name: kept, isPermanent: true });
        const snapshot = await createServerSnapshot(client, { password: "ts-js-it" });
        expect(snapshot.salt).not.toBe("");
        await createChannel(client, { name: extra, isPermanent: true });
        await deleteChannel(client, keptID, { force: true });

        // The wrong password is refused and changes nothing.
        expect(
          await codeOf(() => deployServerSnapshot(client, snapshot, { password: "wrong" })),
        ).toBe(1538);
        const before = await channelNames(client);
        expect(before.has(extra)).toBe(true);
        expect(before.has(kept)).toBe(false);

        const mapping = await deployServerSnapshot(client, snapshot, {
          password: "ts-js-it",
          mapping: true,
          keepFiles: true,
        });
        expect(mapping.length, "-mapping asked for the channel mapping").toBeGreaterThan(0);
        for (const m of mapping) {
          expect(m.oldID).not.toBe(0n);
          expect(m.newID).not.toBe(0n);
        }
        // The deploy ends this connection's selection of the server where the
        // connection has a session to hold one; WebQuery has none.
        if (kind !== "web") {
          expect(await codeOf(() => listChannels(client))).toBe(1024);
        }
        await client.use({ id: 1 });
        const after = await channelNames(client);
        expect(after.has(kept)).toBe(true);
        expect(after.has(extra)).toBe(false);
      } finally {
        for (const name of [kept, extra]) {
          const id = (await listChannels(client).catch(() => [])).find((c) => c.name === name)?.id;
          if (id !== undefined) await deleteChannel(client, id, { force: true }).catch(() => {});
        }
        await client.disconnect().catch(() => {});
      }
      await sleep(1_000);
    }, 120_000);
  });

  // The instance's own settings, changed and put back.
  it("edits the instance settings and restores them", async () => {
    const client = await own(KINDS[0]!);
    const key = PropertyName.ServerInstancePendingConnectionsPerIP;
    try {
      const before = (await getInstanceInfo(client))[key];
      expect(before, "the setting is on the instance").toBeDefined();
      const changed = String(Number(before) + 1);
      try {
        await editInstance(client, { [key]: changed });
        expect((await getInstanceInfo(client))[key]).toBe(changed);
      } finally {
        await editInstance(client, { [key]: before! });
      }
      expect((await getInstanceInfo(client))[key]).toBe(before);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }, 60_000);

  // Every permission goes back to the defaults, and every group the test made
  // goes with it. The fixture's grants go too, which is why this file runs last.
  it("resets every permission to the defaults", async () => {
    const client = await own(KINDS[0]!);
    try {
      const name = stamp("ts-js-reset");
      const sgid = await createServerGroup(client, name, GroupType.Regular);
      await addServerGroupPermission(client, sgid, permissionByName("i_client_talk_power"), 17);
      expect((await listServerGroups(client)).some((g) => g.id === sgid)).toBe(true);

      await resetPermissions(client);
      // The reset restarts the virtual server on TS3, which ends this
      // connection's selection of it, as a snapshot deploy does.
      await sleep(1_000);
      if (KINDS[0] !== "web") await client.use({ id: 1 }).catch(() => {});
      const groups = await listServerGroups(client).catch((error: unknown) => {
        console.log(`listServerGroups after the reset: ${String(error)}`);
        return undefined;
      });
      expect(groups, "the group list after a reset").toBeDefined();
      expect(groups!.some((g) => g.id === sgid || g.name === name)).toBe(false);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }, 60_000);

  // The process stops, and the connection that asked for it finds out. Last in
  // the file because nothing answers afterwards.
  it.skipIf(!STOP_INSTANCE)(
    "stops the process",
    async () => {
      const kind = KINDS[0]!;
      const client = await own(kind);
      let answer = "answered";
      try {
        await stopInstance(client, { reason: "ts-js integration test" });
      } catch (error) {
        answer = String(error);
      }
      console.log(`stopInstance over ${kind} ${answer}`);

      // The process is going: a connection with a session ends.
      if (kind !== "web") {
        const deadline = Date.now() + 20_000;
        while (client.status === ClientStatus.Connected && Date.now() < deadline) await sleep(200);
        expect(client.status).not.toBe(ClientStatus.Connected);
      }
      await sleep(2_000);

      // And a new connection is refused.
      const again = await session.connectNew(kind, stamp("ts-js-after")).then(
        (c) => c,
        () => undefined,
      );
      expect(again, "a connection after stopInstance").toBeUndefined();
      await client.disconnect().catch(() => {});
    },
    90_000,
  );
});
