/**
 * Live checks of the commands that take several clients or permissions at once:
 * kick, move and ban for several clients, group membership, and permission
 * batches on every kind of holder, over every transport the run has and over
 * the voice protocol with a Server Admin client.
 *
 * What each failing item leaves behind is what the functions' doc comments say
 * and what was measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1: the
 * checks here read the server back rather than trust the answer. Everything the
 * tests make is removed afterwards, bans included, even when a test fails.
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GroupAutoUpdateType,
  GroupType,
  Reason,
  addChannelClientPermissions,
  addChannelGroupPermissions,
  addChannelPermissions,
  addClientPermissions,
  addClientsToServerGroup,
  addServerGroupPermission,
  addServerGroupPermissions,
  addServerGroupPermissionsByType,
  asClientDBID,
  asClientID,
  banClients,
  createChannel,
  createChannelGroup,
  createServerGroup,
  deleteBan,
  deleteChannelClientPermissions,
  deleteChannelGroup,
  deleteChannelGroupPermissions,
  deleteChannelPermissions,
  deleteClientDatabase,
  deleteClientPermissions,
  deleteServerGroup,
  deleteServerGroupPermissions,
  deleteServerGroupPermissionsByType,
  kickClients,
  listBans,
  listChannelClientPermissions,
  listChannelGroupPermissions,
  listChannelPermissions,
  listClientPermissions,
  listClients,
  listServerGroupClients,
  listPermissions,
  listServerGroupPermissions,
  moveClients,
  permissionByName,
  removeClientsFromServerGroup,
  type ChannelGroupID,
  type ChannelID,
  type ClientDBID,
  type ClientID,
  type CommandExecutor,
  type Permission,
  type PermissionEntry,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
import type { Client } from "../client/client.js";
import { KINDS, LiveSession, SKIP, pauseAfterSshTests, sleep, stamp } from "./testing/live.js";

pauseAfterSshTests();

/** An id no client has: well inside what a clid holds. */
const NO_CLIENT = asClientID(65000);
/** A database id no client has. */
const NO_DATABASE_ID = asClientDBID(99_999_999n);

type Via = (typeof KINDS)[number] | "voice";

describe.skipIf(SKIP)("Integration — several clients and permissions at once", () => {
  const session = new LiveSession();
  const channels: ChannelID[] = [];
  const channelGroups: ChannelGroupID[] = [];
  const serverGroups: ServerGroupID[] = [];
  const records: ClientDBID[] = [];
  const banReasons: string[] = [];
  let voiceAdmin: Client;
  let adminNickname: string;
  let members: Array<{ client: Client; nickname: string; id: ClientID; databaseID: ClientDBID }>;
  let channelA: ChannelID;
  let channelB: ChannelID;

  const executor = (via: Via): CommandExecutor =>
    via === "voice" ? voiceAdmin : session.clients.get(via)!;

  /** The channel each of the members is in, by position. */
  async function channelsOfMembers(): Promise<Array<ChannelID | undefined>> {
    const list = await listClients(session.first());
    return members.map((m) => list.find((c) => c.nickname === m.nickname)?.channelID);
  }

  /** Put every member in this channel, through the first transport. */
  async function place(channel: ChannelID): Promise<void> {
    const where = await channelsOfMembers();
    const away = members.filter((_, i) => where[i] !== channel).map((m) => m.id);
    if (away.length > 0) await moveClients(session.first(), away, channel);
  }

  async function newMembers(count: number, prefix: string): Promise<typeof members> {
    const made: typeof members = [];
    for (let i = 0; i < count; i++) {
      const nickname = stamp(`${prefix}${i}`);
      const client = await session.voice(nickname);
      const databaseID = await session.databaseIDOf(nickname);
      records.push(databaseID);
      made.push({ client, nickname, id: client.clientID, databaseID });
    }
    return made;
  }

  beforeAll(async () => {
    await session.open();
    const admin = session.first();
    channelA = await createChannel(admin, { name: stamp("ts-js-b-a"), isPermanent: true });
    channelB = await createChannel(admin, { name: stamp("ts-js-b-b"), isPermanent: true });
    channels.push(channelA, channelB);
    adminNickname = stamp("ts-js-b-adm");
    voiceAdmin = await session.voice(adminNickname, {
      admin,
      groupName: /server admin/i,
    });
    records.push(await session.databaseIDOf(adminNickname));
    members = await newMembers(3, "ts-js-b-m");
  }, 120_000);

  afterAll(async () => {
    const admin = session.first();
    for (const reason of banReasons) await removeBansFor(reason).catch(() => {});
    for (const id of serverGroups)
      await deleteServerGroup(admin, id, { force: true }).catch(() => {});
    for (const id of channelGroups)
      await deleteChannelGroup(admin, id, { force: true }).catch(() => {});
    await session.deleteChannels(channels);
    for (const id of records) await deleteClientDatabase(admin, id).catch(() => {});
    await session.close();
  }, 60_000);

  /** Remove every ban rule with this reason, which is every rule a ban test made. */
  async function removeBansFor(reason: string): Promise<void> {
    const admin = session.first();
    for (const ban of await listBans(admin)) {
      if (ban.reason === reason) await deleteBan(admin, ban.id).catch(() => {});
    }
  }

  describe.each<Via>([...KINDS, "voice"])("over %s", (via) => {
    it("moves several clients at once, and what a failing id leaves", async () => {
      const exec = executor(via);
      const ids = members.map((m) => m.id);

      await place(channelB);
      await moveClients(exec, ids, channelA);
      expect(await channelsOfMembers()).toEqual([channelA, channelA, channelA]);

      // A client that is in the channel already cannot be moved there (770),
      // which refuses the call without the switch: the others stay where they are.
      await place(channelB);
      await moveClients(session.first(), [ids[1]!], channelA);
      await expect(moveClients(exec, ids, channelA)).rejects.toMatchObject({ code: 770 });
      expect(await channelsOfMembers()).toEqual([channelB, channelA, channelB]);
      await place(channelA);

      // Without the switch the server checks every client first: one that
      // cannot be moved refuses the call and nobody moves.
      await expect(
        moveClients(exec, [ids[0]!, NO_CLIENT, ids[2]!], channelB),
      ).rejects.toMatchObject({ code: 512 });
      expect(await channelsOfMembers()).toEqual([channelA, channelA, channelA]);

      // With it the failing one is skipped, the rest move, and the answer is success.
      await moveClients(exec, [ids[0]!, NO_CLIENT, ids[2]!], channelB, { continueOnError: true });
      expect(await channelsOfMembers()).toEqual([channelB, channelA, channelB]);

      await place(channelA);
    }, 60_000);

    it("kicks several clients from their channel, and what a failing id leaves", async () => {
      const exec = executor(via);
      const ids = members.map((m) => m.id);
      await place(channelA);

      // Without the switch the clients are kicked in order and the call stops
      // at the first failure: the one before it is out of the channel.
      await expect(
        kickClients(exec, [ids[0]!, NO_CLIENT, ids[2]!], Reason.KickChannel),
      ).rejects.toMatchObject({ code: 512 });
      const afterOne = await channelsOfMembers();
      const lobby = afterOne[0];
      expect(lobby).not.toBe(channelA);
      expect(afterOne).toEqual([lobby, channelA, channelA]);

      // With it, every client that can be kicked is, and the answer is success.
      await kickClients(exec, [NO_CLIENT, ids[1]!, ids[2]!], Reason.KickChannel, {
        continueOnError: true,
        reasonMessage: "ts-js batch",
      });
      expect(await channelsOfMembers()).toEqual([lobby, lobby, lobby]);
    }, 60_000);

    it("adds and removes several clients in a server group, and what a failing id leaves", async () => {
      const exec = executor(via);
      const admin = session.first();
      const sgid = await createServerGroup(admin, stamp("ts-js-b-sg"), GroupType.Regular);
      serverGroups.push(sgid);
      // Let a Server Admin client, whose powers are modest, manage the group.
      for (const name of [
        "i_group_needed_member_add_power",
        "i_group_needed_member_remove_power",
      ]) {
        await addServerGroupPermission(admin, sgid, permissionByName(name), 10);
      }
      const dbs = members.map((m) => m.databaseID);
      const inGroup = async (): Promise<ClientDBID[]> =>
        (await listServerGroupClients(admin, sgid))
          .flatMap((m) => (m.databaseID === undefined ? [] : [m.databaseID]))
          .sort(compareBig);

      await addClientsToServerGroup(exec, sgid, dbs);
      expect(await inGroup()).toEqual([...dbs].sort(compareBig));
      await removeClientsFromServerGroup(exec, sgid, dbs.slice(0, 2));
      expect(await inGroup()).toEqual([dbs[2]]);
      await removeClientsFromServerGroup(exec, sgid, [dbs[2]!]);

      // Without the switch the call stops at the failing id: the one before it
      // is in, the one after is not.
      await expect(
        addClientsToServerGroup(exec, sgid, [dbs[0]!, NO_DATABASE_ID, dbs[1]!]),
      ).rejects.toMatchObject({ code: 512 });
      expect(await inGroup()).toEqual([dbs[0]]);
      await removeClientsFromServerGroup(exec, sgid, [dbs[0]!]);

      // With it everything that can be added is, and the error is the last one.
      await expect(
        addClientsToServerGroup(exec, sgid, [dbs[0]!, NO_DATABASE_ID, dbs[1]!], {
          continueOnError: true,
        }),
      ).rejects.toMatchObject({ code: 512 });
      expect(await inGroup()).toEqual([dbs[0]!, dbs[1]!].sort(compareBig));
      // A client already in the group is the later failure here, so it is the one reported.
      await expect(
        addClientsToServerGroup(exec, sgid, [NO_DATABASE_ID, dbs[0]!, dbs[2]!], {
          continueOnError: true,
        }),
      ).rejects.toMatchObject({ code: 2561 });
      expect(await inGroup()).toEqual([...dbs].sort(compareBig));
      await removeClientsFromServerGroup(exec, sgid, dbs);
      expect(await inGroup()).toEqual([]);
    }, 60_000);

    it("sets and removes several permissions on every kind of holder at once", async () => {
      const exec = executor(via);
      const admin = session.first();
      const cgid = await createChannelGroup(admin, stamp("ts-js-b-cg"), GroupType.Regular);
      channelGroups.push(cgid);
      const sgid = await createServerGroup(admin, stamp("ts-js-b-pg"), GroupType.Regular);
      serverGroups.push(sgid);
      const dbid = members[0]!.databaseID;
      const unknown = permissionByName("i_no_such_permission");
      const ids = new Map((await listPermissions(admin)).map((p) => [p.name, p.id]));

      const cases: Array<{
        name: string;
        names: [string, string];
        add: (batch: Array<{ permission: Permission; value: number }>) => Promise<void>;
        remove: (permissions: Permission[]) => Promise<void>;
        list: () => Promise<PermissionEntry[]>;
      }> = [
        {
          name: "channel",
          names: ["i_channel_needed_modify_power", "i_channel_needed_delete_power"],
          add: (b) => addChannelPermissions(exec, channelA, b),
          remove: (p) => deleteChannelPermissions(exec, channelA, p),
          list: () => listChannelPermissions(admin, channelA),
        },
        {
          name: "channel group",
          names: ["i_channel_modify_power", "i_channel_join_power"],
          add: (b) => addChannelGroupPermissions(exec, cgid, b),
          remove: (p) => deleteChannelGroupPermissions(exec, cgid, p),
          list: () => listChannelGroupPermissions(admin, cgid),
        },
        {
          name: "channel client",
          names: ["i_client_talk_power", "i_client_private_textmessage_power"],
          add: (b) => addChannelClientPermissions(exec, channelA, dbid, b),
          remove: (p) => deleteChannelClientPermissions(exec, channelA, dbid, p),
          list: () => listChannelClientPermissions(admin, channelA, dbid),
        },
        {
          name: "client",
          names: ["i_client_talk_power", "i_client_private_textmessage_power"],
          add: (b) =>
            addClientPermissions(
              exec,
              dbid,
              b.map((e) => ({ ...e, skip: false })),
            ),
          remove: (p) => deleteClientPermissions(exec, dbid, p),
          list: () => listClientPermissions(admin, dbid),
        },
        {
          name: "server group",
          names: ["i_channel_modify_power", "i_channel_join_power"],
          add: (b) => addServerGroupPermissions(exec, sgid, b),
          remove: (p) => deleteServerGroupPermissions(exec, sgid, p),
          list: () => listServerGroupPermissions(admin, sgid),
        },
      ];

      for (const c of cases) {
        const label = `${via}: ${c.name}`;
        const [a, b] = c.names.map(permissionByName) as [Permission, Permission];
        // A list names a permission by id, as it was asked for none by name.
        const named = async (): Promise<Array<[string, number]>> =>
          (await c.list())
            .flatMap((e): Array<[string, number]> => {
              const found = c.names.find((n) =>
                "name" in e.permission ? e.permission.name === n : e.permission.id === ids.get(n),
              );
              return found === undefined ? [] : [[found, e.value]];
            })
            .sort(compareName);
        // What the holder has besides these two, which the test leaves as it finds it.
        const before = (await named()).filter(([n]) => !c.names.includes(n));

        await c.add([
          { permission: a, value: 11 },
          { permission: b, value: 22 },
        ]);
        const expected: Array<[string, number]> = [...before, [c.names[0], 11], [c.names[1], 22]];
        expect(await named(), `${label}: both set`).toEqual(expected.sort(compareName));

        // One permission the server does not know refuses the whole batch:
        // the others in it are not set either.
        await c.remove([a, b]);
        expect(await named(), `${label}: both removed`).toEqual(before);
        await expect(
          c.add([
            { permission: a, value: 11 },
            { permission: unknown, value: 1 },
            { permission: b, value: 22 },
          ]),
        ).rejects.toMatchObject({ code: 2562 });
        expect(await named(), `${label}: a refused batch sets nothing`).toEqual(before);

        // Removing what is not there succeeds, and so does a refused batch of removals.
        await c.remove([a, b]);
        await expect(c.remove([a, unknown])).rejects.toMatchObject({ code: 2562 });
      }
    }, 90_000);
  });

  it("sets and removes several permissions on a kind of group, over every virtual server", async () => {
    for (const via of KINDS) {
      const exec = executor(via);
      const sgid = await createServerGroup(exec, stamp("ts-js-b-auto"), GroupType.Regular);
      serverGroups.push(sgid);
      const before = await listServerGroupPermissions(exec, sgid);
      // The type is read from the group's own `i_group_auto_update_type`,
      // which a new group lacks, so the command reaches no group of this type:
      // the server accepts it, which is what is measured.
      const batch = [
        { permission: permissionByName("i_client_needed_poke_power"), value: 1 },
        { permission: permissionByName("i_client_needed_kick_from_channel_power"), value: 1 },
      ];
      await addServerGroupPermissionsByType(exec, GroupAutoUpdateType.QueryGuest, batch);
      await deleteServerGroupPermissionsByType(
        exec,
        GroupAutoUpdateType.QueryGuest,
        batch.map((e) => e.permission),
      );
      expect(await listServerGroupPermissions(exec, sgid)).toEqual(before);
      await expect(
        addServerGroupPermissionsByType(exec, GroupAutoUpdateType.QueryGuest, [
          ...batch,
          { permission: permissionByName("i_no_such_permission"), value: 1 },
        ]),
      ).rejects.toMatchObject({ code: 2562 });
      await deleteServerGroup(exec, sgid, { force: true });
      serverGroups.pop();
    }
  }, 60_000);

  describe.each<Via>([...KINDS, "voice"])("banning over %s", (via) => {
    it("bans several clients at once, and removes every rule it made", async () => {
      const exec = executor(via);
      const reason = stamp("ts-js-b-ban");
      banReasons.push(reason);
      const targets = await newMembers(2, "ts-js-b-t");
      const ids = targets.map((t) => t.id);
      try {
        // An id no client has refuses the call before anything is banned.
        await expect(
          banClients(exec, [NO_CLIENT, ...ids], { reason, durationMs: 60_000 }),
        ).rejects.toMatchObject({ code: 512 });
        expect((await listBans(session.first())).filter((b) => b.reason === reason)).toEqual([]);

        // With the switch the unknown id is skipped and both clients are banned.
        const made = await banClients(exec, [ids[0]!, NO_CLIENT, ids[1]!], {
          reason,
          durationMs: 60_000,
          continueOnError: true,
        });
        const rules = (await listBans(session.first())).filter((b) => b.reason === reason);
        // A uid rule for each client, and an address rule they share.
        expect(rules.length).toBeGreaterThanOrEqual(2);
        if (via === "voice") expect(made).toEqual([]);
        else
          expect(made.map(String).sort(compareText)).toEqual(
            rules.map((r) => String(r.id)).sort(compareText),
          );
        await sleep(500);
        const left = (await listClients(session.first())).map((c) => c.nickname);
        for (const t of targets) expect(left).not.toContain(t.nickname);
      } finally {
        await removeBansFor(reason);
        for (const t of targets) await t.client.disconnect().catch(() => {});
      }
      expect((await listBans(session.first())).filter((b) => b.reason === reason)).toEqual([]);
    }, 90_000);
  });
});

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareName = (a: [string, number], b: [string, number]): number => compareText(a[0], b[0]);
const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
