/**
 * Server and instance commands.
 *
 * "Server" here means the virtual server a client is connected to; "instance"
 * means the process hosting it. The distinction matters because the setting
 * names differ (`virtualserver_*` versus `serverinstance_*`) and the two are
 * easy to mix up.
 */

import {
  nonEmpty,
  uint,
  U16,
  firstRow,
  exec,
  query,
  list,
  encodeFields,
  inSeconds,
  parsePermission,
  permissionParam,
  rawProperties,
  createdGroupID,
  str,
  big,
  num,
  bool,
  icon,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { PermissionEntry, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelID,
  ClientDBID,
  ClientID,
  IconID,
  ServerGroupID,
  ServerID,
  UID,
} from "../command/ids.js";
import {
  asChannelID,
  asClientDBID,
  asClientID,
  asServerGroupID,
  asServerID,
  asUID,
} from "../command/ids.js";
import type { GroupAutoUpdateType, GroupType } from "../enums.js";
import type { GroupDeleteOptions } from "./groups.js";
import type { Permission } from "../permission.js";

/** A server group as `servergrouplist` reports it. */
export interface ServerGroup {
  /** The group's id. */
  readonly id: ServerGroupID;
  /** The group's name. */
  readonly name: string;
  /** What kind of group this is, one of {@link GroupType}. */
  readonly type: number;
  /** The group's icon, or undefined for none. */
  readonly iconID: IconID | undefined;
  /** Whether membership is stored, rather than lost when the server restarts. */
  readonly savedInDatabase: boolean;
  /** Where the group sorts among the others; a 32-bit value. */
  readonly sortID: number;
  /** Where the group's name shows beside a member's nickname, one of {@link GroupNameMode}. */
  readonly nameMode: number;
  /** The power needed to modify the group. */
  readonly modifyPower: number;
  /** The power needed to add a member. */
  readonly memberAddPower: number;
  /** The power needed to remove a member. */
  readonly memberRemovePower: number;
}

const parseServerGroup = (row: Record<string, string>): ServerGroup => ({
  id: asServerGroupID(big(row, "sgid")),
  name: str(row, "name"),
  type: num(row, "type"),
  iconID: icon(row, "iconid"),
  savedInDatabase: bool(row, "savedb"),
  sortID: num(row, "sortid"),
  nameMode: num(row, "namemode"),
  modifyPower: num(row, "n_modifyp"),
  memberAddPower: num(row, "n_member_addp"),
  memberRemovePower: num(row, "n_member_removep"),
});

/** Every server group. */
export async function listServerGroups(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ServerGroup[]> {
  return (await list(client, "servergrouplist", [], options)).map(parseServerGroup);
}

/**
 * The virtual server's settings, as `serverinfo` reports them.
 *
 * Raw rather than parsed: `serverinfo` carries well over a hundred
 * `virtualserver_*` fields, which ones appear depends on the server version and
 * on the caller's permissions, and a typed subset would drop the rest. The
 * keys are named in `PropertyName`.
 */
export async function getServerInfo(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<Readonly<Record<string, string>>> {
  return firstRow(await query(client, "serverinfo", [], options), "serverinfo");
}

/**
 * Change the virtual server's settings. Only the properties you pass are sent.
 *
 * Unlike every other options object, these are the raw `virtualserver_*`
 * wire properties from `serverinfo`, passed through as given rather than
 * enumerated: there are well over a hundred, they are version-dependent, and a
 * value read back from {@link getServerInfo} should be writable straight back.
 * The values are strings, as `getServerInfo` returns them. The editable keys
 * are marked in `PropertyName`.
 */
export async function editServer(
  client: CommandExecutor,
  settings: Readonly<Record<string, string>>,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "serveredit", rawProperties(settings), options);
}

/**
 * The host process's settings, as `hostinfo` reports them, raw.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query. The keys are
 * named in `PropertyName`.
 */
export async function getHostInfo(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<Readonly<Record<string, string>>> {
  return firstRow(await query(client, "hostinfo", [], options), "hostinfo");
}

/**
 * The server instance's settings, as `instanceinfo` reports them, raw.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query. The keys are
 * named in `PropertyName`.
 */
export async function getInstanceInfo(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<Readonly<Record<string, string>>> {
  return firstRow(await query(client, "instanceinfo", [], options), "instanceinfo");
}

/**
 * Change the server instance's settings: raw `serverinstance_*` properties,
 * passed through as given, for the same reasons as {@link editServer}. The
 * editable keys are marked in `PropertyName`.
 */
export async function editInstance(
  client: CommandExecutor,
  settings: Readonly<Record<string, string>>,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "instanceedit", rawProperties(settings), options);
}

/** An address the instance listens on. */
export interface Binding {
  /**
   * What listens there: `voice`, `query` or `filetransfer`. The server does not
   * name it in each row, so it is the subsystem asked for, or `voice` when none
   * was.
   */
  readonly subsystem: string;
  /** The address. */
  readonly ip: string;
  /** The port; undefined when the server does not report one. */
  readonly port: number | undefined;
}

/** Which bindings {@link listBindings} reports. */
export interface BindingListOptions extends CommandOptions {
  /** Only this subsystem's: `voice`, `query` or `filetransfer`; unset for all (`subsystem`). */
  readonly subsystem?: string | undefined;
}

/**
 * Active IP bindings, when the instance is multi-homed.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function listBindings(
  client: CommandExecutor,
  options: BindingListOptions = {},
): Promise<Binding[]> {
  const subsystem = options.subsystem || "voice";
  const rows = await list(
    client,
    "bindinglist",
    [["subsystem", nonEmpty(options.subsystem ?? "")]],
    options,
  );
  return rows.map((row) => ({
    subsystem: str(row, "subsystem") || subsystem,
    ip: str(row, "ip"),
    port: row["port"] === undefined ? undefined : num(row, "port"),
  }));
}

/** The server's build, as `version` reports it. */
export interface ServerVersion {
  /** The version, such as "3.13.7". */
  readonly version: string;
  /** The build number. */
  readonly build: number;
  /** The platform the server runs on, such as "Linux". */
  readonly platform: string;
}

/** The server's build version. */
export async function getVersion(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ServerVersion> {
  const row = firstRow(await query(client, "version", [], options), "version");
  return { version: str(row, "version"), build: num(row, "build"), platform: str(row, "platform") };
}

/** Which server and client a connection is, as `whoami` reports it. */
export interface WhoAmI {
  /** The virtual server's state, such as "online" (`virtualserver_status`). */
  readonly serverStatus: string;
  /** The virtual server's id, 0 when none is selected (`virtualserver_id`). */
  readonly serverID: ServerID;
  /** The virtual server's unique identifier (`virtualserver_unique_identifier`). */
  readonly serverUID: string;
  /** The virtual server's voice port (`virtualserver_port`). */
  readonly serverPort: number;
  /** This connection's client id (`client_id`). */
  readonly clientID: ClientID;
  /** The channel this connection is in (`client_channel_id`). */
  readonly channelID: ChannelID;
  /** This connection's nickname (`client_nickname`). */
  readonly nickname: string;
  /** This connection's database id (`client_database_id`). */
  readonly databaseID: ClientDBID;
  /** The ServerQuery login name, "" for a voice client (`client_login_name`). */
  readonly loginName: string;
  /**
   * This connection's unique identifier (`client_unique_identifier`). The voice
   * protocol sends the field empty; the voice client's `uid` has
   * it.
   */
  readonly uid: UID;
}

/** Which server and client this connection is, as the server sees it. */
export async function whoAmI(client: CommandExecutor, options?: CommandOptions): Promise<WhoAmI> {
  const row = firstRow(await query(client, "whoami", [], options), "whoami");
  return {
    serverStatus: str(row, "virtualserver_status"),
    serverID: asServerID(big(row, "virtualserver_id")),
    serverUID: str(row, "virtualserver_unique_identifier"),
    serverPort: num(row, "virtualserver_port"),
    clientID: asClientID(uint(row, "client_id", U16)),
    channelID: asChannelID(big(row, "client_channel_id")),
    nickname: str(row, "client_nickname"),
    databaseID: asClientDBID(big(row, "client_database_id")),
    loginName: str(row, "client_login_name"),
    uid: asUID(str(row, "client_unique_identifier")),
  };
}

/**
 * The virtual server's traffic, as `serverrequestconnectioninfo` reports it.
 * Byte counts are bytes; bandwidths are bytes per second.
 */
export interface ServerConnectionInfo {
  /** File transfer bandwidth out (`connection_filetransfer_bandwidth_sent`). */
  readonly fileTransferBandwidthSent: number;
  /** File transfer bandwidth in (`connection_filetransfer_bandwidth_received`). */
  readonly fileTransferBandwidthReceived: number;
  /** File transfer bytes sent (`connection_filetransfer_bytes_sent_total`). */
  readonly fileTransferBytesSent: number;
  /** File transfer bytes received (`connection_filetransfer_bytes_received_total`). */
  readonly fileTransferBytesReceived: number;
  /** Packets sent (`connection_packets_sent_total`). */
  readonly packetsSent: number;
  /** Bytes sent (`connection_bytes_sent_total`). */
  readonly bytesSent: number;
  /** Packets received (`connection_packets_received_total`). */
  readonly packetsReceived: number;
  /** Bytes received (`connection_bytes_received_total`). */
  readonly bytesReceived: number;
  /** Bandwidth out over the last second (`connection_bandwidth_sent_last_second_total`). */
  readonly bandwidthSentLastSecond: number;
  /** Bandwidth out over the last minute (`connection_bandwidth_sent_last_minute_total`). */
  readonly bandwidthSentLastMinute: number;
  /** Bandwidth in over the last second (`connection_bandwidth_received_last_second_total`). */
  readonly bandwidthReceivedLastSecond: number;
  /** Bandwidth in over the last minute (`connection_bandwidth_received_last_minute_total`). */
  readonly bandwidthReceivedLastMinute: number;
  /**
   * How long the virtual server has been running, in milliseconds
   * (`connection_connected_time`). Sent in seconds here — unlike the field of
   * the same name in `clientinfo`, which is in milliseconds.
   */
  readonly connectedTimeMs: number;
  /** The share of packets lost, 0 to 1 (`connection_packetloss_total`). */
  readonly packetLoss: number;
  /** The average ping, in milliseconds (`connection_ping`). */
  readonly pingMs: number;
}

/**
 * The virtual server's traffic statistics — not this connection's, as the
 * command's name suggests.
 */
export async function getConnectionInfo(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ServerConnectionInfo> {
  const row = firstRow(
    await query(client, "serverrequestconnectioninfo", [], options),
    "serverrequestconnectioninfo",
  );
  return {
    fileTransferBandwidthSent: num(row, "connection_filetransfer_bandwidth_sent"),
    fileTransferBandwidthReceived: num(row, "connection_filetransfer_bandwidth_received"),
    fileTransferBytesSent: num(row, "connection_filetransfer_bytes_sent_total"),
    fileTransferBytesReceived: num(row, "connection_filetransfer_bytes_received_total"),
    packetsSent: num(row, "connection_packets_sent_total"),
    bytesSent: num(row, "connection_bytes_sent_total"),
    packetsReceived: num(row, "connection_packets_received_total"),
    bytesReceived: num(row, "connection_bytes_received_total"),
    bandwidthSentLastSecond: num(row, "connection_bandwidth_sent_last_second_total"),
    bandwidthSentLastMinute: num(row, "connection_bandwidth_sent_last_minute_total"),
    bandwidthReceivedLastSecond: num(row, "connection_bandwidth_received_last_second_total"),
    bandwidthReceivedLastMinute: num(row, "connection_bandwidth_received_last_minute_total"),
    connectedTimeMs: durationMs(row, "connection_connected_time", SECOND),
    packetLoss: num(row, "connection_packetloss_total"),
    pingMs: num(row, "connection_ping"),
  };
}

/**
 * The numeric id of the virtual server listening on `port`.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getServerIDByPort(
  client: CommandExecutor,
  port: number,
  options?: CommandOptions,
): Promise<ServerID> {
  const rows = await query(client, "serveridgetbyport", [["virtualserver_port", port]], options);
  return asServerID(big(firstRow(rows, "serveridgetbyport", "server_id"), "server_id"));
}

// ---- Server groups ----------------------------------------------------------

/**
 * Create a server group.
 *
 * `type` is required, and always sent: the server's own default is
 * `GroupType.Regular`, while the type's first value is `Template`, so leaving
 * it to a default on either side is a trap.
 */
export async function createServerGroup(
  client: CommandExecutor,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ServerGroupID> {
  const rows = await query(
    client,
    "servergroupadd",
    [
      ["name", name],
      ["type", type],
    ],
    options,
  );
  return asServerGroupID(createdGroupID(rows, "sgid", name, "servergroupadd"));
}

/** Delete a server group. */
export async function deleteServerGroup(
  client: CommandExecutor,
  sgid: ServerGroupID,
  options: GroupDeleteOptions = {},
): Promise<void> {
  await exec(
    client,
    "servergroupdel",
    [
      ["sgid", sgid],
      ["force", options.force ?? false],
    ],
    options,
  );
}

/** Rename a server group. */
export async function renameServerGroup(
  client: CommandExecutor,
  sgid: ServerGroupID,
  name: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "servergrouprename",
    [
      ["sgid", sgid],
      ["name", name],
    ],
    options,
  );
}

/**
 * Copy a server group's permissions onto another; a `targetGroupID` of 0 makes
 * the server create a new group named `name`, of `type`.
 */
export async function copyServerGroup(
  client: CommandExecutor,
  sourceGroupID: ServerGroupID,
  targetGroupID: ServerGroupID,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ServerGroupID> {
  const rows = await query(
    client,
    "servergroupcopy",
    [
      ["ssgid", sourceGroupID],
      ["tsgid", targetGroupID],
      ["name", name],
      ["type", type],
    ],
    options,
  );
  // Copying onto an existing group keeps that group's id.
  if (targetGroupID !== 0n) return targetGroupID;
  return asServerGroupID(createdGroupID(rows, "sgid", name, "servergroupcopy"));
}

/** Add a client to a server group. */
export async function addClientToServerGroup(
  client: CommandExecutor,
  sgid: ServerGroupID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "servergroupaddclient",
    [
      ["sgid", sgid],
      ["cldbid", cldbid],
    ],
    options,
  );
}

/** Remove a client from a server group. */
export async function removeClientFromServerGroup(
  client: CommandExecutor,
  sgid: ServerGroupID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "servergroupdelclient",
    [
      ["sgid", sgid],
      ["cldbid", cldbid],
    ],
    options,
  );
}

/** Which optional fields `servergroupclientlist` should include. */
export interface ServerGroupClientListOptions extends CommandOptions {
  /** Each member's nickname and unique identifier (`-names`). */
  readonly names?: boolean | undefined;
}

const memberFlags: WireNames<ServerGroupClientListOptions> = { names: "-names" };

/** A member of a server group. */
export interface ServerGroupMember {
  /** The member's database id. */
  readonly databaseID: ClientDBID;
  /** The member's nickname, with `names`; "" otherwise. */
  readonly nickname: string;
  /** The member's unique identifier, with `names`; "" otherwise. */
  readonly uid: UID;
}

/** Members of a server group, optionally with their nicknames and unique identifiers. */
export async function listServerGroupClients(
  client: CommandExecutor,
  sgid: ServerGroupID,
  options: ServerGroupClientListOptions = {},
): Promise<ServerGroupMember[]> {
  const rows = await list(
    client,
    "servergroupclientlist",
    [["sgid", sgid], ...encodeFields(options, memberFlags)],
    options,
  );
  return rows.map((row) => ({
    databaseID: asClientDBID(big(row, "cldbid")),
    nickname: str(row, "client_nickname"),
    uid: asUID(str(row, "client_unique_identifier")),
  }));
}

/** A server group a client belongs to. */
export interface ServerGroupRef {
  /** The group's id. */
  readonly id: ServerGroupID;
  /** The group's name. */
  readonly name: string;
}

/** Server groups a client belongs to. */
export async function getServerGroupsByClient(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<ServerGroupRef[]> {
  const rows = await list(client, "servergroupsbyclientid", [["cldbid", cldbid]], options);
  return rows.map((row) => ({ id: asServerGroupID(big(row, "sgid")), name: str(row, "name") }));
}

/** Permissions set on a server group. */
export async function listServerGroupPermissions(
  client: CommandExecutor,
  sgid: ServerGroupID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "servergrouppermlist", [["sgid", sgid]], options)).map(
    parsePermission,
  );
}

/** How {@link addServerGroupPermission} sets the permission. */
export interface ServerGroupPermissionOptions extends CommandOptions {
  /** Whether the value is negated, so the lowest wins; false by default (`permnegated`). */
  readonly negated?: boolean | undefined;
  /** Whether it skips channel and client overrides; false by default (`permskip`). */
  readonly skip?: boolean | undefined;
}

/** Set a permission on a server group. */
export async function addServerGroupPermission(
  client: CommandExecutor,
  sgid: ServerGroupID,
  permission: Permission,
  value: number,
  options: ServerGroupPermissionOptions = {},
): Promise<void> {
  await exec(
    client,
    "servergroupaddperm",
    [
      ["sgid", sgid],
      permissionParam(permission),
      ["permvalue", value],
      ["permnegated", options.negated ?? false],
      ["permskip", options.skip ?? false],
    ],
    options,
  );
}

/** Remove a permission from a server group. */
export async function deleteServerGroupPermission(
  client: CommandExecutor,
  sgid: ServerGroupID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "servergroupdelperm", [["sgid", sgid], permissionParam(permission)], options);
}

/**
 * Set a permission on every regular server group of a type, on every virtual
 * server of the instance: the groups whose `i_group_auto_update_type` is
 * `type`.
 *
 * Instance-wide, so it needs `b_permission_modify_power_ignore`, which a
 * virtual server's Server Admin does not hold: a voice client gets error 2568.
 *
 * The server requires `permnegated` and `permskip`, so both are always sent:
 * `options.negated` and `options.skip`, each false when unset.
 */
export async function addServerGroupPermissionByType(
  client: CommandExecutor,
  type: GroupAutoUpdateType,
  permission: Permission,
  value: number,
  options: ServerGroupPermissionOptions = {},
): Promise<void> {
  await exec(
    client,
    "servergroupautoaddperm",
    [
      ["sgtype", type],
      permissionParam(permission),
      ["permvalue", value],
      ["permnegated", options.negated ?? false],
      ["permskip", options.skip ?? false],
    ],
    options,
  );
}

/**
 * Remove a permission from every regular server group of a type, on every
 * virtual server of the instance; see {@link addServerGroupPermissionByType}.
 * Needs `b_permission_modify_power_ignore`: a voice client gets error 2568.
 */
export async function deleteServerGroupPermissionByType(
  client: CommandExecutor,
  type: GroupAutoUpdateType,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "servergroupautodelperm",
    [["sgtype", type], permissionParam(permission)],
    options,
  );
}

// ---- Temporary passwords ----------------------------------------------------

/** A temporary server password. */
export interface TempPassword {
  /** The password itself (`pw_clear`). */
  readonly password: string;
  /** What it is for (`desc`). */
  readonly description: string;
  /** Who created it (`nickname`). */
  readonly creatorNickname: string;
  /** The creator's unique identifier (`uid`). */
  readonly creatorUID: UID;
  /** When it became valid (`start`). */
  readonly startsAt: Date | undefined;
  /** When it stops being valid (`end`). */
  readonly endsAt: Date | undefined;
  /** The channel a client joining with it lands in, or 0 for the default channel. */
  readonly targetChannelID: ChannelID;
}

/** The server's temporary passwords. */
export async function listTempPasswords(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<TempPassword[]> {
  const rows = await list(client, "servertemppasswordlist", [], options);
  return rows.map((row) => ({
    password: str(row, "pw_clear"),
    description: str(row, "desc"),
    creatorNickname: str(row, "nickname"),
    creatorUID: asUID(str(row, "uid")),
    startsAt: date(row, "start"),
    endsAt: date(row, "end"),
    targetChannelID: asChannelID(big(row, "tcid")),
  }));
}

/** A temporary password to create. */
export interface TempPasswordOptions {
  /**
   * The password (`pw`). The caller chooses it; the server does not generate
   * one, and an empty one is refused here rather than created.
   */
  readonly password: string;
  /** What it is for, shown in the list (`desc`). */
  readonly description: string;
  /**
   * How long it stays valid, in milliseconds (`duration`). Sent in whole
   * seconds; a positive duration under a second is sent as one.
   */
  readonly durationMs: number;
  /** The channel a client joining with it lands in; unset or 0 is the default channel (`tcid`). */
  readonly targetChannelID?: ChannelID | undefined;
  /** That channel's password, in cleartext; unset or "" for none (`tcpw`). */
  readonly targetChannelPassword?: string | undefined;
}

const tempPasswordNames: WireNames<TempPasswordOptions> = {
  password: "pw",
  description: "desc",
  durationMs: ["duration", inSeconds],
  targetChannelID: "tcid",
  targetChannelPassword: "tcpw",
};

/**
 * Create a temporary server password.
 *
 * The server reports nothing back — the password is the one passed in.
 */
export async function addTempPassword(
  client: CommandExecutor,
  temp: TempPasswordOptions,
  options?: CommandOptions,
): Promise<void> {
  if (typeof temp.password !== "string" || temp.password === "") {
    throw new TypeError("a temporary password cannot be empty");
  }
  // tcid and tcpw are required on the wire, even for the default channel.
  const fields: TempPasswordOptions = {
    ...temp,
    targetChannelID: temp.targetChannelID ?? asChannelID(0),
    targetChannelPassword: temp.targetChannelPassword ?? "",
  };
  await exec(client, "servertemppasswordadd", encodeFields(fields, tempPasswordNames), options, [
    "tcpw",
  ]);
}

/** Delete a temporary password. */
export async function deleteTempPassword(
  client: CommandExecutor,
  password: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "servertemppassworddel", [["pw", password]], options);
}
