import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCommand } from "../command/parser.js";
import { splitCommandRows } from "../helpers.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientID,
  asMessageID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import type { CommandExecutor } from "../command/request.js";
import { GroupType } from "../enums.js";
import { TeamspeakError } from "../errors.js";
import { permissionByName } from "../permission.js";
import {
  createChannel,
  findChannels,
  getChannelInfo,
  listChannelClientPermissions,
  listChannelPermissions,
  listChannels,
} from "./channels.js";
import {
  addAPIKey,
  addQueryLogin,
  listAPIKeys,
  listQueryLogins,
  setQueryLogin,
} from "./credentials.js";
import { createServer, createServerSnapshot, listServers } from "./instance.js";
import {
  findClientDatabase,
  findClientDatabaseByUID,
  findCustomProperty,
  listCustomProperties,
  findClients,
  getClientDBIDByUID,
  getClientDatabaseInfo,
  getClientIDs,
  getClientProperties,
  getClientNameByDBID,
  getClientNameByUID,
  getClientUIDByID,
  listClientDatabase,
  listClientPermissions,
  listClients,
} from "./clients.js";
import {
  getFileInfo,
  initFileDownload,
  initFileUpload,
  listActiveTransfers,
  listFiles,
} from "./files.js";
import {
  addPrivilegeKey,
  copyChannelGroup,
  createChannelGroup,
  findPermission,
  getOwnPermission,
  getPermissionOverview,
  listChannelGroupClients,
  listChannelGroupPermissions,
  listChannelGroups,
  listPermissions,
  listPrivilegeKeys,
} from "./groups.js";
import {
  addBan,
  findBans,
  getMessage,
  listBans,
  listComplaints,
  listMessages,
  viewLog,
} from "./moderation.js";
import {
  copyServerGroup,
  createServerGroup,
  getConnectionInfo,
  getHostInfo,
  getInstanceInfo,
  getServerGroupsByClient,
  getServerIDByPort,
  getServerInfo,
  getVersion,
  listBindings,
  listServerGroupClients,
  listServerGroupPermissions,
  listServerGroups,
  listTempPasswords,
  whoAmI,
} from "./server.js";

// A typed command turns the rows a server answers into values. Everything in a
// row is the server's to choose: a number too wide for its id, a sign, a hex
// prefix, a fraction, text where a number goes, a field missing altogether.
// Whatever it sends, a command must resolve, or reject with the SDK's own
// error: a RangeError from an id constructor, or a TypeError from reading
// what is not there, would be a bug.

/** The keys the row parsers read, and a few they do not. */
const KEYS = [
  "average_speed",
  "banid",
  "build",
  "cgid",
  "channel_codec",
  "channel_codec_quality",
  "channel_description",
  "channel_flag_default",
  "channel_flag_password",
  "channel_flag_permanent",
  "channel_icon_id",
  "channel_maxclients",
  "channel_name",
  "channel_needed_talk_power",
  "channel_order",
  "channel_topic",
  "channel_unique_identifier",
  "cid",
  "cldbid",
  "clid",
  "client_away",
  "client_channel_group_id",
  "client_created",
  "client_database_id",
  "client_description",
  "client_id",
  "client_idle_time",
  "client_is_recording",
  "client_is_talker",
  "client_lastconnected",
  "client_lastip",
  "client_login_name",
  "client_nickname",
  "client_servergroups",
  "client_totalconnections",
  "client_type",
  "client_unique_identifier",
  "clientftfid",
  "cluid",
  "connection_bytes_received_total",
  "connection_connected_time",
  "connection_ping",
  "cpid",
  "created",
  "current_speed",
  "datetime",
  "desc",
  "duration",
  "enforcements",
  "fcldbid",
  "file_size",
  "flag_read",
  "fname",
  "ftkey",
  "iconid",
  "invokercldbid",
  "invokername",
  "invokeruid",
  "ip",
  "l",
  "last_pos",
  "lastnickname",
  "log",
  "message",
  "msgid",
  "n",
  "name",
  "namemode",
  "nickname",
  "p",
  "path",
  "permdesc",
  "permid",
  "permname",
  "permnegated",
  "permsid",
  "permskip",
  "permvalue",
  "pid",
  "platform",
  "port",
  "reason",
  "runtime",
  "savedb",
  "seekpos",
  "sender",
  "serverftfid",
  "sgid",
  "size",
  "sizedone",
  "sortid",
  "status",
  "subject",
  "t",
  "tcid",
  "tcldbid",
  "timestamp",
  "token",
  "token_created",
  "token_id1",
  "token_id2",
  "token_type",
  "type",
  "uid",
  "version",
  "virtualserver_id",
  "virtualserver_port",
  "virtualserver_status",
  "virtualserver_unique_identifier",
] as const;

const value = fc.oneof(
  { weight: 4, arbitrary: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String) },
  { weight: 2, arbitrary: fc.integer({ min: -3_000_000_000, max: 5_000_000_000 }).map(String) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      "",
      "-1",
      "0",
      "0x10",
      "1e3",
      "1.5",
      "-0",
      "NaN",
      "Infinity",
      " 7 ",
      "1,2,3",
      "6,,x,9",
      "18446744073709551616",
      "99999999999999999999999999",
      "-2004712318",
      "2290254978",
      "4294967296",
      "65536",
      "1e400",
      "\\s",
      "a\\sb",
    ),
  },
  {
    weight: 2,
    arbitrary: fc.string({ unit: "binary", maxLength: 24 }).map((s) => s.replace(/[ |]/g, "x")),
  },
);

/** What the transport hands a command: the rows of one answer, parsed. */
const answer = fc
  .array(
    fc
      .array(fc.tuple(fc.constantFrom(...KEYS), value), { maxLength: 14 })
      .map((pairs) => pairs.map(([k, v]) => `${k}=${v}`).join(" ")),
    { minLength: 0, maxLength: 4 },
  )
  .map((rows) =>
    splitCommandRows(rows.join("|")).flatMap((line) => {
      const parsed = parseCommand(line);
      return parsed === null ? [] : [parsed.params];
    }),
  );

const cid = asChannelID(1n);
const cldbid = asClientDBID(1n);
const sgid = asServerGroupID(1n);
const permission = permissionByName("i_client_talk_power");

/** Every typed command that reads rows, called with whatever it needs. */
const commands: Record<string, (c: CommandExecutor) => Promise<unknown>> = {
  listChannels: (c) => listChannels(c),
  findChannels: (c) => findChannels(c, "x"),
  getChannelInfo: (c) => getChannelInfo(c, cid),
  createChannel: (c) => createChannel(c, { name: "x" }),
  listChannelPermissions: (c) => listChannelPermissions(c, cid),
  listChannelClientPermissions: (c) => listChannelClientPermissions(c, cid, cldbid),
  listClients: (c) => listClients(c),
  findClients: (c) => findClients(c, "x"),
  getClientProperties: (c) => getClientProperties(c, asClientID(1)),
  getClientIDs: (c) => getClientIDs(c, asUID("x")),
  getClientUIDByID: (c) => getClientUIDByID(c, asClientID(1)),
  getClientDBIDByUID: (c) => getClientDBIDByUID(c, asUID("x")),
  getClientNameByDBID: (c) => getClientNameByDBID(c, cldbid),
  getClientNameByUID: (c) => getClientNameByUID(c, asUID("x")),
  listClientDatabase: (c) => listClientDatabase(c),
  findClientDatabase: (c) => findClientDatabase(c, "x"),
  findClientDatabaseByUID: (c) => findClientDatabaseByUID(c, "x"),
  getClientDatabaseInfo: (c) => getClientDatabaseInfo(c, cldbid),
  listClientPermissions: (c) => listClientPermissions(c, cldbid),
  listFiles: (c) => listFiles(c, cid, "/"),
  getFileInfo: (c) => getFileInfo(c, cid, "/a"),
  listActiveTransfers: (c) => listActiveTransfers(c),
  initFileUpload: (c) => initFileUpload(c, cid, "/a", 3n),
  initFileDownload: (c) => initFileDownload(c, cid, "/a"),
  listChannelGroups: (c) => listChannelGroups(c),
  createChannelGroup: (c) => createChannelGroup(c, "x", GroupType.Regular),
  copyChannelGroup: (c) =>
    copyChannelGroup(c, asChannelGroupID(1n), asChannelGroupID(0n), "x", GroupType.Regular),
  listChannelGroupClients: (c) => listChannelGroupClients(c),
  listChannelGroupPermissions: (c) => listChannelGroupPermissions(c, asChannelGroupID(1n)),
  listPermissions: (c) => listPermissions(c),
  findPermission: (c) => findPermission(c, permission),
  getPermissionOverview: (c) => getPermissionOverview(c, cid, cldbid),
  listPrivilegeKeys: (c) => listPrivilegeKeys(c),
  addPrivilegeKey: (c) => addPrivilegeKey(c, { serverGroupID: sgid }),
  listBans: (c) => listBans(c),
  addBan: (c) => addBan(c, { ip: "1.2.3.4" }),
  listComplaints: (c) => listComplaints(c),
  listMessages: (c) => listMessages(c),
  getMessage: (c) => getMessage(c, asMessageID(1n)),
  viewLog: (c) => viewLog(c),
  listServerGroups: (c) => listServerGroups(c),
  createServerGroup: (c) => createServerGroup(c, "x", GroupType.Regular),
  copyServerGroup: (c) => copyServerGroup(c, sgid, asServerGroupID(0n), "x", GroupType.Regular),
  listServerGroupClients: (c) => listServerGroupClients(c, sgid),
  getServerGroupsByClient: (c) => getServerGroupsByClient(c, cldbid),
  listServerGroupPermissions: (c) => listServerGroupPermissions(c, sgid),
  listTempPasswords: (c) => listTempPasswords(c),
  listBindings: (c) => listBindings(c),
  getServerInfo: (c) => getServerInfo(c),
  getHostInfo: (c) => getHostInfo(c),
  getInstanceInfo: (c) => getInstanceInfo(c),
  getVersion: (c) => getVersion(c),
  whoAmI: (c) => whoAmI(c),
  getConnectionInfo: (c) => getConnectionInfo(c),
  getServerIDByPort: (c) => getServerIDByPort(c, 9987),
  listAPIKeys: (c) => listAPIKeys(c),
  addAPIKey: (c) => addAPIKey(c, "read"),
  listQueryLogins: (c) => listQueryLogins(c),
  addQueryLogin: (c) => addQueryLogin(c, "x"),
  setQueryLogin: (c) => setQueryLogin(c, "x"),
  getOwnPermission: (c) => getOwnPermission(c, permission),
  listCustomProperties: (c) => listCustomProperties(c, cldbid),
  findCustomProperty: (c) => findCustomProperty(c, "x", "%"),
  findBans: (c) => findBans(c, { ip: "1.2.3.4" }),
  listServers: (c) => listServers(c),
  createServer: (c) => createServer(c, "x"),
  createServerSnapshot: (c) => createServerSnapshot(c),
};

const UINT64_MAX = (1n << 64n) - 1n;

describe("typed commands reading a server's answer", () => {
  it("resolve, or reject with the SDK's own error, whatever the rows", async () => {
    await fc.assert(
      fc.asyncProperty(answer, async (rows) => {
        const executor: CommandExecutor = { send: async () => rows };
        for (const [name, run] of Object.entries(commands)) {
          try {
            await run(executor);
          } catch (error) {
            expect(error, `${name}: ${String(error)}`).toBeInstanceOf(TeamspeakError);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("list a client or a channel per row, with ids inside their widths", async () => {
    await fc.assert(
      fc.asyncProperty(answer, async (rows) => {
        const executor: CommandExecutor = { send: async () => rows };
        const clients = await listClients(executor);
        expect(clients).toHaveLength(rows.length);
        for (const client of clients) {
          expect(Number.isInteger(client.id) && client.id >= 0 && client.id <= 0xffff).toBe(true);
          expect(client.channelID >= 0n && client.channelID <= UINT64_MAX).toBe(true);
          for (const group of client.serverGroups ?? [])
            expect(group >= 0n && group <= UINT64_MAX).toBe(true);
        }
        const channels = await listChannels(executor);
        expect(channels).toHaveLength(rows.length);
        for (const channel of channels) {
          expect(channel.id >= 0n && channel.id <= UINT64_MAX).toBe(true);
          expect(channel.parentID >= 0n && channel.parentID <= UINT64_MAX).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });
});
