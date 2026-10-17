import { describe, expect, it } from "vitest";
import {
  createChannel,
  getChannelInfo,
  findChannels,
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
  findCustomProperty,
  listCustomProperties,
  findClients,
  getClientDatabaseInfo,
  getClientDBIDByUID,
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
  getServerIDByPort,
  getServerInfo,
  getVersion,
  whoAmI,
  getServerGroupsByClient,
  listBindings,
  listServerGroupClients,
  listServerGroupPermissions,
  listServerGroups,
  listTempPasswords,
} from "./server.js";
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
import { ErrorCode } from "../errorcode.js";
import { GroupType } from "../enums.js";
import { NoDataError, ServerError, TeamspeakError } from "../errors.js";
import { permissionByName } from "../permission.js";

/** An executor whose every command the server refuses with `code`. */
const refusing = (code: number): CommandExecutor => ({
  send: async () => {
    throw new ServerError(code, "refused");
  },
});

const cid = asChannelID(1n);
const cldbid = asClientDBID(1n);
const permission = permissionByName("i_client_talk_power");

/** Every list and find, called with whatever it needs. */
const lists: Record<string, (client: CommandExecutor) => Promise<readonly unknown[]>> = {
  listChannels: (c) => listChannels(c),
  findChannels: (c) => findChannels(c, "x"),
  listChannelPermissions: (c) => listChannelPermissions(c, cid),
  listChannelClientPermissions: (c) => listChannelClientPermissions(c, cid, cldbid),
  listClients: (c) => listClients(c),
  findClients: (c) => findClients(c, "x"),
  getClientIDs: (c) => getClientIDs(c, asUID("x")),
  listClientDatabase: (c) => listClientDatabase(c),
  findClientDatabase: (c) => findClientDatabase(c, "x"),
  listClientPermissions: (c) => listClientPermissions(c, cldbid),
  listFiles: (c) => listFiles(c, cid, "/"),
  listActiveTransfers: (c) => listActiveTransfers(c),
  listChannelGroups: (c) => listChannelGroups(c),
  listChannelGroupClients: (c) => listChannelGroupClients(c),
  listChannelGroupPermissions: (c) => listChannelGroupPermissions(c, asChannelGroupID(1n)),
  listPermissions: (c) => listPermissions(c),
  findPermission: (c) => findPermission(c, permission),
  getPermissionOverview: (c) => getPermissionOverview(c, cid, cldbid),
  listPrivilegeKeys: (c) => listPrivilegeKeys(c),
  listBans: (c) => listBans(c),
  listComplaints: (c) => listComplaints(c),
  listMessages: (c) => listMessages(c),
  listServerGroups: (c) => listServerGroups(c),
  listBindings: (c) => listBindings(c),
  listServerGroupClients: (c) => listServerGroupClients(c, asServerGroupID(1n)),
  getServerGroupsByClient: (c) => getServerGroupsByClient(c, cldbid),
  listServerGroupPermissions: (c) => listServerGroupPermissions(c, asServerGroupID(1n)),
  listTempPasswords: (c) => listTempPasswords(c),
  listAPIKeys: (c) => listAPIKeys(c),
  listQueryLogins: (c) => listQueryLogins(c),
  listCustomProperties: (c) => listCustomProperties(c, cldbid),
  findCustomProperty: (c) => findCustomProperty(c, "x", "%"),
  findBans: (c) => findBans(c, { ip: "1.2.3.4" }),
  listServers: (c) => listServers(c),
};

describe("empty results", () => {
  // The server reports an empty list as error 1281; several lists threw it.
  it.each(Object.keys(lists))("%s answers [] for 1281", async (name) => {
    await expect(lists[name]!(refusing(ErrorCode.DatabaseEmptyResult))).resolves.toEqual([]);
  });

  it.each(Object.keys(lists))("%s still throws any other refusal", async (name) => {
    await expect(
      lists[name]!(refusing(ErrorCode.PermissionsClientInsufficient)),
    ).rejects.toBeInstanceOf(ServerError);
  });

  // Measured on TS3 3.13: clientfind finding no one answers 512, channelfind
  // finding nothing 768. Neither command names a client or a channel, so
  // that can only mean no match.
  it("answers a search that found nothing with []", async () => {
    await expect(findClients(refusing(ErrorCode.ClientInvalidID), "x")).resolves.toEqual([]);
    await expect(findChannels(refusing(ErrorCode.ChannelInvalidID), "x")).resolves.toEqual([]);
    await expect(listClients(refusing(ErrorCode.ClientInvalidID))).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  // Measured on TS3 and TS6: custominfo for a client with no properties answers
  // 512, as it does for a client that does not exist.
  it("answers custominfo's 512 with []", async () => {
    await expect(
      listCustomProperties(refusing(ErrorCode.ClientInvalidID), cldbid),
    ).resolves.toEqual([]);
  });
});

/** An executor that answers every command with `rows`. */
const answering = (rows: Array<Record<string, string>>): CommandExecutor => ({
  send: async () => rows,
});

/** Every command that exists to return data, called with whatever it needs. */
const required: Record<string, (client: CommandExecutor) => Promise<unknown>> = {
  createChannel: (c) => createChannel(c, { name: "x" }),
  getChannelInfo: (c) => getChannelInfo(c, cid),
  getClientProperties: (c) => getClientProperties(c, asClientID(1)),
  getClientUIDByID: (c) => getClientUIDByID(c, asClientID(1)),
  getClientDBIDByUID: (c) => getClientDBIDByUID(c, asUID("x")),
  getClientNameByDBID: (c) => getClientNameByDBID(c, cldbid),
  getClientNameByUID: (c) => getClientNameByUID(c, asUID("x")),
  getClientDatabaseInfo: (c) => getClientDatabaseInfo(c, cldbid),
  getFileInfo: (c) => getFileInfo(c, cid, "/a"),
  initFileUpload: (c) => initFileUpload(c, cid, "/a", 3n),
  initFileDownload: (c) => initFileDownload(c, cid, "/a"),
  createChannelGroup: (c) => createChannelGroup(c, "x", GroupType.Regular),
  copyChannelGroup: (c) =>
    copyChannelGroup(c, asChannelGroupID(1n), asChannelGroupID(0n), "x", GroupType.Regular),
  createServerGroup: (c) => createServerGroup(c, "x", GroupType.Regular),
  copyServerGroup: (c) =>
    copyServerGroup(c, asServerGroupID(1n), asServerGroupID(0n), "x", GroupType.Regular),
  addPrivilegeKey: (c) => addPrivilegeKey(c, { serverGroupID: asServerGroupID(6n) }),
  getMessage: (c) => getMessage(c, asMessageID(1n)),
  viewLog: (c) => viewLog(c),
  getServerInfo: (c) => getServerInfo(c),
  getHostInfo: (c) => getHostInfo(c),
  getInstanceInfo: (c) => getInstanceInfo(c),
  getVersion: (c) => getVersion(c),
  whoAmI: (c) => whoAmI(c),
  getConnectionInfo: (c) => getConnectionInfo(c),
  getServerIDByPort: (c) => getServerIDByPort(c, 9987),
  addAPIKey: (c) => addAPIKey(c, "read"),
  addQueryLogin: (c) => addQueryLogin(c, "x"),
  setQueryLogin: (c) => setQueryLogin(c, "x"),
  getOwnPermission: (c) => getOwnPermission(c, permission),
  createServer: (c) => createServer(c, "x"),
  createServerSnapshot: (c) => createServerSnapshot(c),
};

/** Those whose row must also carry the value they exist for. */
const keyed = [
  "createChannel",
  "getClientUIDByID",
  "getClientDBIDByUID",
  "getClientNameByUID",
  "initFileUpload",
  "initFileDownload",
  "createChannelGroup",
  "createServerGroup",
  "addPrivilegeKey",
  "getServerIDByPort",
  "addAPIKey",
  "addQueryLogin",
  "setQueryLogin",
  "getOwnPermission",
  "createServer",
  "createServerSnapshot",
];

describe("required data", () => {
  // These used to answer an id of 0 or an object of empty fields, which reads
  // like a real answer.
  it.each(Object.keys(required))(
    "%s throws a NoDataError when the server sends no row",
    async (name) => {
      const error = await required[name]!(answering([])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NoDataError);
      expect(error).toBeInstanceOf(TeamspeakError);
    },
  );

  it.each(keyed)("%s throws a NoDataError for a row without its value", async (name) => {
    await expect(required[name]!(answering([{ unrelated: "1" }]))).rejects.toBeInstanceOf(
      NoDataError,
    );
  });
});

describe("ids read off the wire", () => {
  // The constructors refuse out-of-range values; a server sending one must
  // not make a whole list throw.
  it("read as 0 when the server sends one no id can be", async () => {
    const clients = await listClients(
      answering([
        {
          clid: "70000",
          cid: "-1",
          client_channel_group_id: "18446744073709551616",
          client_servergroups: "18446744073709551616,6",
        },
      ]),
    );
    expect(clients[0]).toMatchObject({
      id: 0,
      channelID: 0n,
      channelGroupID: 0n,
      serverGroups: [6n],
    });
  });
});
