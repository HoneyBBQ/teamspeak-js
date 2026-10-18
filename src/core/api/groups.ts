/**
 * Channel groups, the permission catalogue, and the privilege keys that grant groups.
 */

import {
  nonZero,
  uint,
  U32,
  firstRow,
  exec,
  execRows,
  continueOnErrorParams,
  query,
  list,
  encodeFields,
  nonEmpty,
  parsePermission,
  permissionParam,
  recoveredGroupID,
  str,
  big,
  num,
  bool,
  date,
} from "./command.js";
import type {
  BatchOptions,
  Params,
  PermissionEntry,
  PermissionValue,
  WireNames,
} from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelGroupID,
  ChannelID,
  ClientDBID,
  IconID,
  PermissionID,
  ServerGroupID,
} from "../command/ids.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asPermissionID,
  asServerGroupID,
} from "../command/ids.js";
import { parseChannelGroup } from "./group-rows.js";
import { PermissionTarget, PrivilegeKeyType } from "../enums.js";
import type { GroupType } from "../enums.js";
import type { Permission } from "../permission.js";
import { escape, unescape } from "../command/command.js";
import type { CustomProperty } from "./clients.js";

/** A channel group as `channelgrouplist` reports it. */
export interface ChannelGroup {
  /** The group's id. */
  readonly id: ChannelGroupID;
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

/** Every channel group. */
export async function listChannelGroups(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ChannelGroup[]> {
  return (await list(client, "channelgrouplist", [], options)).map(parseChannelGroup);
}

/**
 * Create a channel group.
 *
 * `type` is required, and always sent: the server's own default is
 * `GroupType.Regular`, while the type's first value is `Template`, so leaving
 * it to a default on either side is a trap.
 *
 * When the server reports success without the new id, as TS6 WebQuery
 * occasionally does, the group is found by name and type ({@link listChannelGroups}); a
 * NoDataError is thrown only when none matches.
 */
export async function createChannelGroup(
  client: CommandExecutor,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ChannelGroupID> {
  const rows = await query(
    client,
    "channelgroupadd",
    [
      ["name", name],
      ["type", type],
    ],
    options,
  );
  return asChannelGroupID(
    await recoveredGroupID(rows, "cgid", name, type, "channelgroupadd", () =>
      listChannelGroups(client, options),
    ),
  );
}

/** How a group is deleted. */
export interface GroupDeleteOptions extends CommandOptions {
  /** Delete the group even while it has members; false by default (`force`, always sent). */
  readonly force?: boolean | undefined;
}

/** Delete a channel group. */
export async function deleteChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  options: GroupDeleteOptions = {},
): Promise<void> {
  await exec(
    client,
    "channelgroupdel",
    [
      ["cgid", cgid],
      ["force", options.force ?? false],
    ],
    options,
  );
}

/** Rename a channel group. */
export async function renameChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  name: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelgrouprename",
    [
      ["cgid", cgid],
      ["name", name],
    ],
    options,
  );
}

/**
 * Copy a channel group's permissions onto another; a `targetGroupID` of 0
 * makes the server create a new group named `name`, of `type`.
 *
 * When the server reports success without the new id, as TS6 WebQuery
 * occasionally does, the group is found by name and type ({@link listChannelGroups}); a
 * NoDataError is thrown only when none matches.
 */
export async function copyChannelGroup(
  client: CommandExecutor,
  sourceGroupID: ChannelGroupID,
  targetGroupID: ChannelGroupID,
  name: string,
  type: GroupType,
  options?: CommandOptions,
): Promise<ChannelGroupID> {
  const rows = await query(
    client,
    "channelgroupcopy",
    [
      ["scgid", sourceGroupID],
      ["tcgid", targetGroupID],
      ["name", name],
      ["type", type],
    ],
    options,
  );
  // Copying onto an existing group keeps that group's id.
  if (targetGroupID !== 0n) return targetGroupID;
  return asChannelGroupID(
    await recoveredGroupID(rows, "cgid", name, type, "channelgroupcopy", () =>
      listChannelGroups(client, options),
    ),
  );
}

/**
 * Which channel group memberships {@link listChannelGroupClients} reports.
 * Unset fields do not narrow the list.
 */
export interface ChannelGroupClientListOptions extends CommandOptions {
  /** Only memberships in this channel (`cid`). */
  readonly channelID?: ChannelID | undefined;
  /** Only this client's memberships (`cldbid`). */
  readonly databaseID?: ClientDBID | undefined;
  /** Only memberships of this group (`cgid`). */
  readonly groupID?: ChannelGroupID | undefined;
}

// A filter of 0 matches nothing in particular, so it is omitted, as unset is.
const membershipFilterNames: WireNames<ChannelGroupClientListOptions> = {
  channelID: ["cid", nonZero],
  databaseID: ["cldbid", nonZero],
  groupID: ["cgid", nonZero],
};

/** One client holding one channel group in one channel. */
export interface ChannelGroupMembership {
  /** The channel. */
  readonly channelID: ChannelID;
  /** The client's database id. */
  readonly databaseID: ClientDBID;
  /** The channel group. */
  readonly groupID: ChannelGroupID;
}

/**
 * Which channel group each client holds in which channel.
 *
 * Set at least one filter field to narrow it; called with none the server may
 * return nothing.
 */
export async function listChannelGroupClients(
  client: CommandExecutor,
  options: ChannelGroupClientListOptions = {},
): Promise<ChannelGroupMembership[]> {
  const rows = await list(
    client,
    "channelgroupclientlist",
    encodeFields(options, membershipFilterNames),
    options,
  );
  return rows.map((row) => ({
    channelID: asChannelID(big(row, "cid")),
    databaseID: asClientDBID(big(row, "cldbid")),
    groupID: asChannelGroupID(big(row, "cgid")),
  }));
}

/** Permissions set on a channel group. */
export async function listChannelGroupPermissions(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "channelgrouppermlist", [["cgid", cgid]], options)).map(
    parsePermission,
  );
}

/** Set a permission on a channel group. */
export async function addChannelGroupPermission(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permission: Permission,
  value: number,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelgroupaddperm",
    [["cgid", cgid], permissionParam(permission), ["permvalue", value]],
    options,
  );
}

/**
 * Set several permissions on a channel group, in one command: each permission
 * is a row. With none, nothing is sent. The server's answer is as for
 * {@link addChannelPermissions}: every row is checked first, and one it
 * refuses leaves none set, with or without `continueOnError`.
 */
export async function addChannelGroupPermissions(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permissions: readonly PermissionValue[],
  options: BatchOptions = {},
): Promise<void> {
  await execRows(
    client,
    "channelgroupaddperm",
    [...continueOnErrorParams(options), ["cgid", cgid]],
    permissions.map((entry) => [permissionParam(entry.permission), ["permvalue", entry.value]]),
    options,
  );
}

/**
 * Remove several permissions from a channel group, in one command: each
 * permission is a row. With none, nothing is sent. Every row is checked
 * first: one the server refuses (an unknown permission, 2562) leaves none
 * removed, with or without `continueOnError`. Removing a permission the group
 * does not have succeeds.
 */
export async function deleteChannelGroupPermissions(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permissions: readonly Permission[],
  options: BatchOptions = {},
): Promise<void> {
  await execRows(
    client,
    "channelgroupdelperm",
    [...continueOnErrorParams(options), ["cgid", cgid]],
    permissions.map((permission) => [permissionParam(permission)]),
    options,
  );
}

/** Remove a permission from a channel group. */
export async function deleteChannelGroupPermission(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "channelgroupdelperm", [["cgid", cgid], permissionParam(permission)], options);
}

// ---- Permissions ------------------------------------------------------------

/** One permission in the server's catalogue. */
export interface PermissionInfo {
  /** The permission's id on this server build (`permid`). */
  readonly id: PermissionID;
  /** The permission's name, such as "i_client_talk_power" (`permname`). */
  readonly name: string;
  /** What the permission controls (`permdesc`). */
  readonly description: string;
}

/**
 * The server's full permission catalogue.
 *
 * Rows that name no permission — the group markers some servers interleave —
 * are left out.
 *
 * ServerQuery sends each permission's id. The voice protocol sends none: there
 * a permission's id is its place in the list, counting from 1, which `id` is
 * set to.
 */
export async function listPermissions(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<PermissionInfo[]> {
  const rows = await list(client, "permissionlist", [], options);
  return rows
    .filter((row) => row["permname"] !== undefined)
    .map((row, index) => ({
      id: asPermissionID(row["permid"] === undefined ? index + 1 : uint(row, "permid", U32)),
      name: str(row, "permname"),
      description: str(row, "permdesc"),
    }));
}

/**
 * Resolve a permission name to its numeric id.
 *
 * A name the server does not know is not an `undefined` result: both TS3 3.13.8
 * and TS6 beta13.1 refuse it with a ServerError 2562 (invalid permission ID),
 * which is thrown. `undefined` is only for a server that acknowledges the
 * command with no row, which neither measured server does.
 *
 * Needs an instance-level permission (`b_serverinstance_*`), which not even the
 * Server Admin group holds by default — expect error 2568 until it is granted.
 * Granted, it works over the voice protocol like any other query.
 */
export async function getPermissionIDByName(
  client: CommandExecutor,
  name: string,
  options?: CommandOptions,
): Promise<PermissionID | undefined> {
  const rows = await query(client, "permidgetbyname", [["permsid", name]], options);
  if (rows.length === 0) return undefined;
  return asPermissionID(uint(firstRow(rows, "permidgetbyname", "permid"), "permid", U32));
}

/**
 * What a permission is set on, as `permfind` and `permoverview` report it:
 * discriminated on `target`, so each kind carries its own typed ids. The wire
 * sends them as `t`, `id1` and `id2`, whose meaning depends on `t`; a row with
 * a target this table does not name is left out of the results.
 */
export type PermissionLocation =
  | {
      /** Set on a server group. */
      readonly target: typeof PermissionTarget.ServerGroup;
      /** The group (`id1`). */
      readonly serverGroupID: ServerGroupID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a client, server-wide. */
      readonly target: typeof PermissionTarget.Client;
      /** The client (`id1`). */
      readonly databaseID: ClientDBID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a channel. */
      readonly target: typeof PermissionTarget.Channel;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a channel group, in one channel. */
      readonly target: typeof PermissionTarget.ChannelGroup;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The group (`id2`). */
      readonly channelGroupID: ChannelGroupID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    }
  | {
      /** Set on a client within one channel. */
      readonly target: typeof PermissionTarget.ChannelClient;
      /** The channel (`id1`). */
      readonly channelID: ChannelID;
      /** The client (`id2`). */
      readonly databaseID: ClientDBID;
      /** The permission (`p`). */
      readonly permission: PermissionID;
    };

/** Read a location from a `permfind` or `permoverview` row; undefined for an unknown target. */
function parseLocation(row: Record<string, string>): PermissionLocation | undefined {
  const permission = asPermissionID(uint(row, "p", U32));
  const id1 = big(row, "id1");
  const id2 = big(row, "id2");
  switch (num(row, "t")) {
    case PermissionTarget.ServerGroup:
      return {
        target: PermissionTarget.ServerGroup,
        serverGroupID: asServerGroupID(id1),
        permission,
      };
    case PermissionTarget.Client:
      return { target: PermissionTarget.Client, databaseID: asClientDBID(id1), permission };
    case PermissionTarget.Channel:
      return { target: PermissionTarget.Channel, channelID: asChannelID(id1), permission };
    case PermissionTarget.ChannelGroup:
      return {
        target: PermissionTarget.ChannelGroup,
        channelID: asChannelID(id1),
        channelGroupID: asChannelGroupID(id2),
        permission,
      };
    case PermissionTarget.ChannelClient:
      return {
        target: PermissionTarget.ChannelClient,
        channelID: asChannelID(id1),
        databaseID: asClientDBID(id2),
        permission,
      };
    default:
      return undefined;
  }
}

/** Every place a permission is set. */
export async function findPermission(
  client: CommandExecutor,
  permission: Permission,
  options?: CommandOptions,
): Promise<PermissionLocation[]> {
  const rows = await list(client, "permfind", [permissionParam(permission)], options);
  return rows.flatMap((row) => parseLocation(row) ?? []);
}

/** One of this connection's own permissions, as `permget` reports it. */
export interface OwnPermission {
  /** The permission's numeric id (`permid`); it differs between server builds. */
  readonly id: PermissionID;
  /** The permission's name (`permsid`). */
  readonly name: string;
  /** The value this connection holds (`permvalue`). */
  readonly value: number;
}

/**
 * The value of one permission for this connection, with every group, channel
 * and client setting resolved: what a client can check before trying
 * something.
 *
 * Needs `b_client_permissionoverview_own`. A permission the server does not
 * know is refused with error 2562 (invalid permission ID). Over the voice
 * protocol TS3 answers with plain rows and TS6 with a notification, which the
 * client pairs with this command. TS6's `forauthenticationtoken` and `cid`
 * forms are not sent.
 */
export async function getOwnPermission(
  client: CommandExecutor,
  permission: Permission,
  options?: CommandOptions,
): Promise<OwnPermission> {
  const rows = await query(client, "permget", [permissionParam(permission)], options);
  const row = firstRow(rows, "permget", "permvalue");
  return {
    id: asPermissionID(uint(row, "permid", U32)),
    name: str(row, "permsid"),
    value: num(row, "permvalue"),
  };
}

/** How a permission applies, in a {@link PermissionOverviewEntry}. */
export interface PermissionOverviewValue {
  /** The permission's value there (`v`). */
  readonly value: number;
  /** Whether the value is negated (`n`). */
  readonly negated: boolean;
  /** Whether it skips channel and client overrides (`s`). */
  readonly skip: boolean;
}

/** One permission applying to a client in a channel, as `permoverview` reports it. */
export type PermissionOverviewEntry = PermissionLocation & PermissionOverviewValue;

/**
 * Every permission that applies to a client in a channel, from every source,
 * unfiltered.
 *
 * It always asks for all of them (`permid=0`): the server requires a
 * permission parameter — omitting it fails with 1539 — and treats 0 as "all".
 * Each entry names its permission, so one is easy to pick out.
 */
export async function getPermissionOverview(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<PermissionOverviewEntry[]> {
  const rows = await list(
    client,
    "permoverview",
    [
      ["cid", cid],
      ["cldbid", cldbid],
      ["permid", 0],
    ],
    options,
  );
  return rows.flatMap((row) => {
    const location = parseLocation(row);
    if (location === undefined) return [];
    return [{ ...location, value: num(row, "v"), negated: bool(row, "n"), skip: bool(row, "s") }];
  });
}

/**
 * Wipe all permission overrides and restore the defaults.
 *
 * Destructive: every custom permission on the server goes. It also drops the
 * caller's own rights, because it resets the group they rely on.
 */
export async function resetPermissions(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "permreset", [], options);
}

// ---- Privilege keys ----------------------------------------------

/**
 * A privilege key, which grants a group when redeemed. The server also
 * accepts the older `token…` commands for the same keys; these functions use
 * the `privilegekey…` ones.
 */
export interface PrivilegeKey {
  /** The key itself. */
  readonly token: string;
  /** Which kind of group the key grants, one of {@link PrivilegeKeyType}. */
  readonly type: number;
  /** The server group a `PrivilegeKeyType.ServerGroup` key grants; undefined otherwise. */
  readonly serverGroupID: ServerGroupID | undefined;
  /** The channel group a `PrivilegeKeyType.ChannelGroup` key grants; undefined otherwise. */
  readonly channelGroupID: ChannelGroupID | undefined;
  /** The channel a `PrivilegeKeyType.ChannelGroup` key grants its group in; undefined otherwise. */
  readonly channelID: ChannelID | undefined;
  /** The key's description. */
  readonly description: string;
  /** When the key was created. */
  readonly createdAt: Date | undefined;
  /**
   * The custom client properties a client gets by using the key
   * (`token_customset`); empty for a key with none.
   */
  readonly customSet: readonly CustomProperty[];
}

/**
 * Read a key. The wire carries the group as `token_id1` and the channel as
 * `token_id2`, whichever kind of group it is; which typed field each belongs in
 * depends on the token type.
 */
const parseKey = (row: Record<string, string>): PrivilegeKey => {
  const type = num(row, "token_type");
  const channelGroup = type === PrivilegeKeyType.ChannelGroup;
  return {
    token: str(row, "token"),
    type,
    serverGroupID: channelGroup ? undefined : asServerGroupID(big(row, "token_id1")),
    channelGroupID: channelGroup ? asChannelGroupID(big(row, "token_id1")) : undefined,
    channelID: channelGroup ? asChannelID(big(row, "token_id2")) : undefined,
    description: str(row, "token_description"),
    createdAt: date(row, "token_created"),
    customSet: parseCustomSet(str(row, "token_customset")),
  };
};

/**
 * Read a key's custom set, `ident=a value=b|ident=c value=d`. The server stores
 * the text as it was given, so a value with a space in it is escaped inside it
 * (see {@link encodeCustomSet}) for it to be read back whole; a set made some
 * other way is read as well as it parses, and an entry that is not
 * `ident=… value=…` is skipped.
 */
function parseCustomSet(raw: string): CustomProperty[] {
  if (raw === "") return [];
  return raw.split("|").flatMap((entry) => {
    const match = /^ident=(.*?) value=(.*)$/s.exec(entry);
    return match === null ? [] : [{ ident: unescape(match[1]!), value: unescape(match[2]!) }];
  });
}

/**
 * Write a custom set for `tokencustomset`.
 *
 * The text is escaped twice: here, so each ident and value survives the
 * server splitting the set on spaces and pipes, and again as the parameter
 * goes on the wire. The server's own example escapes only once, which cuts a
 * value at its first space.
 */
function encodeCustomSet(set: readonly CustomProperty[]): string | undefined {
  if (set.length === 0) return undefined;
  return set.map((p) => `ident=${escape(p.ident)} value=${escape(p.value)}`).join("|");
}

/** Every privilege key on the server. */
export async function listPrivilegeKeys(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<PrivilegeKey[]> {
  return (await list(client, "privilegekeylist", [], options)).map(parseKey);
}

/**
 * A privilege key to create: one that grants a server group, or one that
 * grants a channel group in one channel.
 */
export type PrivilegeKeyOptions =
  | {
      /** The server group the key grants. */
      readonly serverGroupID: ServerGroupID;
      readonly channelGroupID?: never;
      readonly channelID?: never;
      /** Shown in the key list; unset or "" sends none. */
      readonly description?: string | undefined;
      /**
       * Custom client properties to set on whoever uses the key, such as an
       * account id from another system; unset or empty sends none
       * (`tokencustomset`).
       */
      readonly customSet?: readonly CustomProperty[] | undefined;
    }
  | {
      readonly serverGroupID?: never;
      /** The channel group the key grants. */
      readonly channelGroupID: ChannelGroupID;
      /** The channel it grants the group in. */
      readonly channelID: ChannelID;
      /** Shown in the key list; unset or "" sends none. */
      readonly description?: string | undefined;
      /**
       * Custom client properties to set on whoever uses the key; unset or
       * empty sends none (`tokencustomset`).
       */
      readonly customSet?: readonly CustomProperty[] | undefined;
    };

/**
 * Encode the group a key grants.
 *
 * The wire form is a type and two untyped ids whose meaning depends on it:
 * `tokenid1` is the group and `tokenid2` the channel. The options used to take
 * them as such, documented the other way round, so the typed fields are checked
 * here to describe exactly one kind of key.
 */
function keyParams(key: PrivilegeKeyOptions): Params {
  const { serverGroupID, channelGroupID, channelID } = key as {
    serverGroupID?: unknown;
    channelGroupID?: unknown;
    channelID?: unknown;
  };
  const isID = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n;
  const description = nonEmpty(key.description ?? "");
  const customSet = encodeCustomSet(key.customSet ?? []);
  if (isID(serverGroupID) && channelGroupID === undefined && channelID === undefined) {
    return [
      ["tokentype", PrivilegeKeyType.ServerGroup],
      ["tokenid1", serverGroupID],
      ["tokenid2", 0],
      ["tokendescription", description],
      ["tokencustomset", customSet],
    ];
  }
  if (serverGroupID === undefined && isID(channelGroupID) && isID(channelID)) {
    return [
      ["tokentype", PrivilegeKeyType.ChannelGroup],
      ["tokenid1", channelGroupID],
      ["tokenid2", channelID],
      ["tokendescription", description],
      ["tokencustomset", customSet],
    ];
  }
  throw new TypeError("a key grants a server group, or a channel group in a channel");
}

/**
 * Create a privilege key. Returns the key as the server generated it.
 *
 * A NoDataError from this means the command took effect: TS6 WebQuery
 * occasionally answers a successful create with no data. The key exists, and
 * cannot be told apart from an identical one, so it is not looked up: do not
 * retry blindly, or a second key is made. List the keys to find it.
 */
export async function addPrivilegeKey(
  client: CommandExecutor,
  key: PrivilegeKeyOptions,
  options?: CommandOptions,
): Promise<string> {
  const rows = await query(client, "privilegekeyadd", keyParams(key), options);
  return str(firstRow(rows, "privilegekeyadd", "token"), "token");
}

/** Delete a privilege key. */
export async function deletePrivilegeKey(
  client: CommandExecutor,
  token: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "privilegekeydelete", [["token", token]], options);
}

/**
 * Redeem a privilege key.
 *
 * The key grants only if this connection has not already used one.
 */
export async function usePrivilegeKey(
  client: CommandExecutor,
  token: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "privilegekeyuse", [["token", token]], options);
}
