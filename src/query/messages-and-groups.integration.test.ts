/**
 * Live checks of what a second party sees and does: global and server text
 * messages, a poke, the view becoming ready, a privilege key used by a
 * connected client, server group membership lists, channel subscription, and a
 * query login made by hand with `QueryClient.login()`.
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorCode,
  GroupType,
  TextMessageTarget,
  addPrivilegeKey,
  addClientToServerGroup,
  createChannel,
  createServerGroup,
  deletePrivilegeKey,
  deleteServerGroup,
  getHostInfo,
  getServerGroupsByClient,
  listClients,
  listServerGroupClients,
  listServerGroups,
  moveClient,
  pokeClient,
  removeClientFromServerGroup,
  sendGlobalMessage,
  sendServerMessage,
  usePrivilegeKey,
  whoAmI,
  type ChannelID,
  type ClientDBID,
  type ServerGroupID,
  type TextMessageEvent,
} from "@honeybbq/teamspeak";
import { Client } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { subscribeAllChannels, unsubscribeAllChannels } from "../client/api/voice.js";
import type { QueryClient } from "./client.js";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_CHANNEL,
  KINDS,
  LOGIN_NAME,
  LOGIN_PASSWORD,
  LiveSession,
  SERVER_PASSWORD,
  SKIP,
  VOICE_ADDR,
  pauseAfterSshTests,
  stamp,
  withTimeout,
  type Kind,
} from "./testing/live.js";

pauseAfterSshTests();

describe.skipIf(SKIP)("Integration — messages, pokes, privilege keys and logins", () => {
  const session = new LiveSession();
  const channels: ChannelID[] = [];
  const groups: ServerGroupID[] = [];
  const records: ClientDBID[] = [];
  let listener: Client;
  let listenerDatabaseID: ClientDBID;

  beforeAll(async () => {
    await session.open();
    const nickname = stamp("ts-js-listen");
    listener = await session.voice(nickname);
    listenerDatabaseID = await session.databaseIDOf(nickname);
    records.push(listenerDatabaseID);
  }, 90_000);

  afterAll(async () => {
    const admin = session.first();
    for (const id of groups) await deleteServerGroup(admin, id, { force: true }).catch(() => {});
    await session.deleteChannels(channels);
    await session.close();
  }, 60_000);

  describe.each(KINDS)("over %s", (kind: Kind) => {
    const admin = (): QueryClient => session.clients.get(kind)!;

    function nextMessage(match: (event: TextMessageEvent) => boolean): Promise<TextMessageEvent> {
      return withTimeout(
        new Promise<TextMessageEvent>((resolve) => {
          const off = listener.on("textMessage", (event) => {
            if (!match(event)) return;
            off();
            resolve(event);
          });
        }),
      );
    }

    it("sends a server message and a global message that a connected client receives", async () => {
      const server = `server-${stamp("m")}`;
      const seenServer = nextMessage((e) => e.message === server);
      await sendServerMessage(admin(), server);
      expect(await seenServer).toMatchObject({
        message: server,
        targetMode: TextMessageTarget.Server,
      });

      const global = `global-${stamp("m")}`;
      const seenGlobal = nextMessage((e) => e.message === global);
      await sendGlobalMessage(admin(), global);
      expect(await seenGlobal).toMatchObject({ message: global });
    }, 60_000);

    it("pokes a connected client", async () => {
      const text = `poke-${stamp("p")}`;
      const poked = withTimeout(
        new Promise<{ message: string; invokerID: bigint | number }>((resolve) => {
          const off = listener.on("poked", (event) => {
            if (event.message !== text) return;
            off();
            resolve(event);
          });
        }),
      );
      await pokeClient(admin(), listener.clientID, text);
      expect(await poked).toMatchObject({ message: text });
    }, 60_000);

    it("lists the members of a server group, and gives a connected client one with a privilege key", async () => {
      const sgid = await createServerGroup(admin(), stamp("ts-js-key"), GroupType.Regular);
      groups.push(sgid);
      const token = await addPrivilegeKey(admin(), {
        serverGroupID: sgid,
        description: "ts-js live",
      });
      let used = false;
      try {
        await usePrivilegeKey(listener, token);
        used = true;
        const members = await listServerGroupClients(admin(), sgid, { names: true });
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ databaseID: listenerDatabaseID });
        expect(members[0]!.nickname).not.toBe("");
        expect(
          (await getServerGroupsByClient(admin(), listenerDatabaseID)).map((g) => g.id),
        ).toContain(sgid);
        expect((await listServerGroupClients(admin(), sgid)).map((m) => m.databaseID)).toEqual([
          listenerDatabaseID,
        ]);

        await removeClientFromServerGroup(admin(), sgid, listenerDatabaseID);
        expect(await listServerGroupClients(admin(), sgid).catch(emptyResult)).toEqual([]);
        await addClientToServerGroup(admin(), sgid, listenerDatabaseID);
        expect(await listServerGroupClients(admin(), sgid)).toHaveLength(1);
      } finally {
        // A key that was used is gone with its use, and the server answers a
        // second delete with 3 (see the notes on the voice protocol); either
        // way nothing is left of it.
        if (!used) await deletePrivilegeKey(admin(), token).catch(() => {});
        await deleteServerGroup(admin(), sgid, { force: true });
        groups.pop();
      }
      expect((await listServerGroups(admin())).some((g) => g.id === sgid)).toBe(false);
    }, 60_000);

    it("subscribes to every channel and unsubscribes again", async () => {
      const cid = await createChannel(admin(), { name: stamp("ts-js-sub"), isPermanent: true });
      channels.push(cid);
      await subscribeAllChannels(listener);
      await unsubscribeAllChannels(listener);
      // A client always sees the channel it is in, so a move keeps the roster whole.
      await moveClient(admin(), listener.clientID, cid);
      expect((await listClients(admin())).find((c) => c.id === listener.clientID)?.channelID).toBe(
        cid,
      );
      const alpha = await session.channelNamed(DEFAULT_CHANNEL);
      await moveClient(admin(), listener.clientID, alpha!);
    }, 60_000);
  });

  it("reports the view ready on connect", async () => {
    const client = new Client(generateIdentitySync(8), VOICE_ADDR!, stamp("ts-js-view"), {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    const ready = withTimeout(
      new Promise<{ revision: number }>((resolve) => client.on("viewReady", resolve)),
      20_000,
    );
    try {
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      const event = await ready;
      expect(event.revision).toBeGreaterThan(0);
      expect(client.view.status).toBe("live");
      expect(client.view.revision).toBeGreaterThanOrEqual(event.revision);
    } finally {
      await client.disconnect().catch(() => {});
    }
  }, 60_000);

  // Raw TCP only: SSH logs in as it connects and WebQuery with its key. A wrong
  // password is not tried: on TS3 it bans the address for ten minutes.
  it.skipIf(!KINDS.includes("tcp") || LOGIN_NAME === "")(
    "logs out and in again by hand on a raw connection",
    async () => {
      const own = await session.connectNew("tcp", stamp("ts-js-login"));
      try {
        await own.logout();
        await own.use({ id: 1 });
        const refused = await getHostInfo(own).catch((error: unknown) => error);
        expect((refused as { code?: number }).code, "a connection that is not logged in").toBe(
          ErrorCode.PermissionsClientInsufficient,
        );

        await own.login(LOGIN_NAME, LOGIN_PASSWORD);
        await own.use({ id: 1 });
        expect(Object.keys(await getHostInfo(own)).length).toBeGreaterThan(0);
        expect((await whoAmI(own)).serverID).toBe(1n);
      } finally {
        await own.disconnect().catch(() => {});
      }
    },
    60_000,
  );
});

/** A list the server reports as empty by refusing with this code, answered as []. */
function emptyResult(error: unknown): never[] {
  if ((error as { code?: number }).code === ErrorCode.DatabaseEmptyResult) return [];
  throw error;
}
