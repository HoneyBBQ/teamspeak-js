/**
 * Live round trip of the permission commands, on a scratch channel, channel
 * group, server group and client database entry, over every transport the run
 * has. Each permission is added, read back through every reader that can see
 * it, deleted, and read back again; the scratch objects go afterwards.
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GroupType,
  PermissionTarget,
  GroupAutoUpdateType,
  addChannelClientPermission,
  addChannelGroupPermission,
  addChannelPermission,
  addClientPermission,
  addClientToServerGroup,
  addServerGroupPermission,
  addServerGroupPermissionByType,
  createChannel,
  createChannelGroup,
  createServerGroup,
  deleteChannel,
  deleteChannelClientPermission,
  deleteChannelGroup,
  deleteChannelGroupPermission,
  deleteChannelPermission,
  deleteClientDatabase,
  deleteClientPermission,
  deleteServerGroup,
  deleteServerGroupPermission,
  deleteServerGroupPermissionByType,
  findPermission,
  getPermissionIDByName,
  getPermissionOverview,
  listChannelClientPermissions,
  listChannelGroupPermissions,
  listChannelPermissions,
  listClientPermissions,
  listPermissions,
  listServerGroupPermissions,
  permissionByName,
  setClientChannelGroup,
  type ChannelGroupID,
  type ChannelID,
  type ClientDBID,
  type CommandExecutor,
  type PermissionEntry,
  type PermissionID,
  type PermissionLocation,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
import type { Client } from "../client/client.js";
import type { QueryClient } from "./client.js";
import { KINDS, LiveSession, SKIP, pauseAfterSshTests, stamp, type Kind } from "./testing/live.js";

pauseAfterSshTests();

/** An `i_` permission each kind can hold; each takes any value, so the test picks distinct ones. */
const PERMISSION = "i_client_talk_power";

/** Whether an entry of a list is the permission, named by id or by name. */
function isPermission(
  entry: { permission: PermissionEntry["permission"] | PermissionID },
  id: bigint,
): boolean {
  const p = entry.permission;
  if (typeof p === "number") return BigInt(p) === id;
  return "name" in p ? p.name === PERMISSION : BigInt(p.id) === id;
}

describe.skipIf(SKIP)("Integration — permission round trip", () => {
  const session = new LiveSession();
  let voice: Client;
  const channels: ChannelID[] = [];
  const channelGroups: ChannelGroupID[] = [];
  const serverGroups: ServerGroupID[] = [];
  let databaseID: ClientDBID;

  beforeAll(async () => {
    await session.open();
    const nickname = stamp("ts-js-perm");
    voice = await session.voice(nickname);
    databaseID = await session.databaseIDOf(nickname);
  }, 90_000);

  afterAll(async () => {
    const admin = session.first();
    for (const id of channels) await deleteChannel(admin, id, { force: true }).catch(() => {});
    for (const id of channelGroups)
      await deleteChannelGroup(admin, id, { force: true }).catch(() => {});
    for (const id of serverGroups)
      await deleteServerGroup(admin, id, { force: true }).catch(() => {});
    await voice?.disconnect().catch(() => {});
    if (databaseID !== undefined) await deleteClientDatabase(admin, databaseID).catch(() => {});
    await session.close();
  }, 60_000);

  describe.each(KINDS)("over %s", (kind: Kind) => {
    it("adds, reads back and deletes a permission on every kind of holder", async () => {
      const admin: QueryClient = session.clients.get(kind)!;
      const permissionID = (await listPermissions(admin)).find((p) => p.name === PERMISSION)?.id;
      expect(permissionID, "listPermissions has the permission").toBeDefined();
      const id = BigInt(permissionID!);
      const permission = permissionByName(PERMISSION);

      // One id for the name, from the other direction. The command needs an
      // instance permission, which the query admin holds.
      expect(await getPermissionIDByName(admin, PERMISSION)).toBe(permissionID);
      // Measured on TS3 and TS6: a name the server does not know is refused
      // with 2562, not answered with no rows.
      await expect(getPermissionIDByName(admin, "i_no_such_permission")).rejects.toMatchObject({
        code: 2562,
      });

      const cid = await createChannel(admin, { name: stamp("ts-js-perm-ch"), isPermanent: true });
      channels.push(cid);
      const cgid = await createChannelGroup(admin, stamp("ts-js-perm-cg"), GroupType.Regular);
      channelGroups.push(cgid);
      const sgid = await createServerGroup(admin, stamp("ts-js-perm-sg"), GroupType.Regular);
      serverGroups.push(sgid);
      // The overview of a client in a channel names the group sources only
      // for the groups the client holds.
      await addClientToServerGroup(admin, sgid, databaseID);
      await setClientChannelGroup(admin, cgid, cid, databaseID);

      const overview = async (): Promise<PermissionLocation[]> =>
        (await getPermissionOverview(admin, cid, databaseID)).filter((e) => isPermission(e, id));
      const located = async (): Promise<PermissionLocation[]> =>
        await findPermission(admin, permission);

      const baseOverview = (await overview()).length;
      const baseLocations = (await located()).length;

      const cases: Array<{
        name: string;
        target: (typeof PermissionTarget)[keyof typeof PermissionTarget];
        value: number;
        add: (value: number) => Promise<void>;
        remove: () => Promise<void>;
        list: () => Promise<PermissionEntry[]>;
        here: (l: PermissionLocation) => boolean;
      }> = [
        {
          name: "channel",
          target: PermissionTarget.Channel,
          value: 11,
          add: (v) => addChannelPermission(admin, cid, permission, v),
          remove: () => deleteChannelPermission(admin, cid, permission),
          list: () => listChannelPermissions(admin, cid),
          here: (l) =>
            l.target === PermissionTarget.Channel && "channelID" in l && l.channelID === cid,
        },
        {
          name: "channel group",
          target: PermissionTarget.ChannelGroup,
          value: 22,
          add: (v) => addChannelGroupPermission(admin, cgid, permission, v),
          remove: () => deleteChannelGroupPermission(admin, cgid, permission),
          list: () => listChannelGroupPermissions(admin, cgid),
          here: (l) =>
            l.target === PermissionTarget.ChannelGroup &&
            "channelGroupID" in l &&
            l.channelGroupID === cgid,
        },
        {
          name: "channel client",
          target: PermissionTarget.ChannelClient,
          value: 33,
          add: (v) => addChannelClientPermission(admin, cid, databaseID, permission, v),
          remove: () => deleteChannelClientPermission(admin, cid, databaseID, permission),
          list: () => listChannelClientPermissions(admin, cid, databaseID),
          here: (l) =>
            l.target === PermissionTarget.ChannelClient &&
            "channelID" in l &&
            "databaseID" in l &&
            l.channelID === cid &&
            l.databaseID === databaseID,
        },
        {
          name: "client",
          target: PermissionTarget.Client,
          value: 44,
          add: (v) => addClientPermission(admin, databaseID, permission, v),
          remove: () => deleteClientPermission(admin, databaseID, permission),
          list: () => listClientPermissions(admin, databaseID),
          here: (l) =>
            l.target === PermissionTarget.Client &&
            "databaseID" in l &&
            l.databaseID === databaseID,
        },
        {
          name: "server group",
          target: PermissionTarget.ServerGroup,
          value: 55,
          add: (v) => addServerGroupPermission(admin, sgid, permission, v),
          remove: () => deleteServerGroupPermission(admin, sgid, permission),
          list: () => listServerGroupPermissions(admin, sgid),
          here: (l) =>
            l.target === PermissionTarget.ServerGroup &&
            "serverGroupID" in l &&
            l.serverGroupID === sgid,
        },
      ];

      for (const c of cases) {
        const label = `${kind}: ${c.name}`;
        expect(
          (await c.list()).some((e) => isPermission(e, id)),
          `${label} starts empty`,
        ).toBe(false);

        await c.add(c.value);
        const entry = (await c.list()).find((e) => isPermission(e, id));
        expect(entry, `${label}: the list has it`).toMatchObject({
          value: c.value,
          negated: false,
          skip: false,
        });
        const seen = (await overview()).find((l) => c.here(l));
        expect(seen, `${label}: the overview has it`).toMatchObject({ value: c.value });
        const found = (await located()).filter((l) => c.here(l));
        expect(found, `${label}: findPermission has it once`).toHaveLength(1);

        // A second add changes the value rather than adding an entry.
        await c.add(c.value + 1);
        const changed = (await c.list()).filter((e) => isPermission(e, id));
        expect(changed, `${label}: one entry after a second add`).toHaveLength(1);
        expect(changed[0]!.value, label).toBe(c.value + 1);

        await c.remove();
        expect(
          (await c.list()).some((e) => isPermission(e, id)),
          `${label}: gone from the list`,
        ).toBe(false);
        expect(
          (await overview()).some((l) => c.here(l)),
          `${label}: gone from the overview`,
        ).toBe(false);
        expect(
          (await located()).some((l) => c.here(l)),
          `${label}: gone from findPermission`,
        ).toBe(false);
      }

      // Everything is back where it started.
      expect((await overview()).length).toBe(baseOverview);
      expect((await located()).length).toBe(baseLocations);
    }, 120_000);

    it("sets and removes a permission on a kind of group, over every virtual server", async () => {
      const admin: CommandExecutor = session.clients.get(kind)!;
      // A guest-type group that nothing here holds, so the change reaches no one.
      const permission = permissionByName("i_client_needed_poke_power");
      const sgid = await createServerGroup(admin, stamp("ts-js-perm-auto"), GroupType.Regular);
      serverGroups.push(sgid);
      const before = await listServerGroupPermissions(admin, sgid);
      // The type is set by the group's own `i_group_auto_update_type`, which a
      // new group lacks, so the command reaches no group of this type: the
      // server accepts it, which is what is measured.
      await addServerGroupPermissionByType(admin, GroupAutoUpdateType.QueryGuest, permission, 1);
      await deleteServerGroupPermissionByType(admin, GroupAutoUpdateType.QueryGuest, permission);
      expect(await listServerGroupPermissions(admin, sgid)).toEqual(before);
      await deleteServerGroup(admin, sgid, { force: true });
      serverGroups.pop();
    }, 60_000);
  });
});
