/**
 * Channel commands.
 *
 * Channel settings are a wide, mostly-optional set. The options objects name
 * them in camelCase without the `channel_` prefix (`codecQuality` for
 * `channel_codec_quality`), and each options type has a table naming every
 * field's wire parameter, so the mapping is written down once and a key the
 * table does not know is never sent.
 */

import {
  nonZero,
  firstRow,
  exec,
  query,
  list,
  parseChannel,
  parsePermission,
  permissionParam,
  encodeFields,
  inSeconds,
  big,
  str,
} from "./command.js";
import type { Channel, PermissionEntry, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type { ChannelID, ClientDBID } from "../command/ids.js";
import { asChannelID } from "../command/ids.js";
import { ErrorCode } from "../errorcode.js";
import type { Codec } from "../enums.js";
import type { Permission } from "../permission.js";

/**
 * Channel settings, as `channelcreate` and `channeledit` take them.
 *
 * Only the fields you set are sent. An unset (undefined) field is omitted and
 * leaves the setting alone; any other value is sent, so `""` sends an empty
 * value — `password: ""` clears a channel's password, while leaving `password`
 * unset keeps it.
 */
export interface ChannelSettings {
  /** The topic shown under the name (`channel_topic`). */
  readonly topic?: string | undefined;
  /** The description (`channel_description`). */
  readonly description?: string | undefined;
  /**
   * The channel password (`channel_password`), in cleartext: the voice client
   * hashes it on the wire and ServerQuery sends it as is. `""` removes it.
   */
  readonly password?: string | undefined;
  /**
   * Whether the channel is password-protected (`channel_flag_password`). The
   * server sets this itself when a password is set.
   */
  readonly hasPassword?: boolean | undefined;
  /** The voice codec (`channel_codec`). */
  readonly codec?: Codec | undefined;
  /** The codec's quality, 0 to 10 (`channel_codec_quality`). */
  readonly codecQuality?: number | undefined;
  /** How many packets of voice to send at once, 1 to 10 (`channel_codec_latency_factor`). */
  readonly codecLatencyFactor?: number | undefined;
  /** Whether voice in the channel travels unencrypted (`channel_codec_is_unencrypted`). */
  readonly isUnencrypted?: boolean | undefined;
  /** How many clients may be in the channel (`channel_maxclients`). */
  readonly maxClients?: number | undefined;
  /**
   * How many clients may be in the channel and those under it
   * (`channel_maxfamilyclients`).
   */
  readonly maxFamilyClients?: number | undefined;
  /** Whether `maxClients` is ignored (`channel_flag_maxclients_unlimited`). */
  readonly isMaxClientsUnlimited?: boolean | undefined;
  /** Whether `maxFamilyClients` is ignored (`channel_flag_maxfamilyclients_unlimited`). */
  readonly isMaxFamilyClientsUnlimited?: boolean | undefined;
  /**
   * Whether the family limit is taken from the parent
   * (`channel_flag_maxfamilyclients_inherited`).
   */
  readonly isMaxFamilyClientsInherited?: boolean | undefined;
  /**
   * The channel to sort this one after among its siblings; 0 sorts it first
   * (`channel_order`).
   */
  readonly order?: ChannelID | undefined;
  /** The talk power a client needs to speak here (`channel_needed_talk_power`). */
  readonly neededTalkPower?: number | undefined;
  /** Whether the channel survives a server restart (`channel_flag_permanent`). */
  readonly isPermanent?: boolean | undefined;
  /**
   * Whether the channel survives its last client leaving, but not a restart
   * (`channel_flag_semi_permanent`).
   */
  readonly isSemiPermanent?: boolean | undefined;
  /** Whether new clients land here (`channel_flag_default`). */
  readonly isDefault?: boolean | undefined;
  /**
   * How long a temporary channel survives its last client leaving, in
   * milliseconds (`channel_delete_delay`). Sent in whole seconds.
   */
  readonly deleteDelayMs?: number | undefined;
  /** How the name is pronounced, for text-to-speech (`channel_name_phonetic`). */
  readonly namePhonetic?: string | undefined;
}

const settingNames: WireNames<ChannelSettings> = {
  topic: "channel_topic",
  description: "channel_description",
  password: "channel_password",
  hasPassword: "channel_flag_password",
  codec: "channel_codec",
  codecQuality: "channel_codec_quality",
  codecLatencyFactor: "channel_codec_latency_factor",
  isUnencrypted: "channel_codec_is_unencrypted",
  maxClients: "channel_maxclients",
  maxFamilyClients: "channel_maxfamilyclients",
  isMaxClientsUnlimited: "channel_flag_maxclients_unlimited",
  isMaxFamilyClientsUnlimited: "channel_flag_maxfamilyclients_unlimited",
  isMaxFamilyClientsInherited: "channel_flag_maxfamilyclients_inherited",
  order: "channel_order",
  neededTalkPower: "channel_needed_talk_power",
  isPermanent: "channel_flag_permanent",
  isSemiPermanent: "channel_flag_semi_permanent",
  isDefault: "channel_flag_default",
  deleteDelayMs: ["channel_delete_delay", inSeconds],
  namePhonetic: "channel_name_phonetic",
};

/** A new channel's settings. Only `name` is required; see {@link ChannelSettings}. */
export interface ChannelCreateOptions extends ChannelSettings {
  /** The channel's name (`channel_name`). */
  readonly name: string;
  /**
   * The channel to create the new one under; unset or 0 is the top level, and
   * either omits the parameter (`cpid`).
   */
  readonly parentID?: ChannelID | undefined;
}

const createNames: WireNames<ChannelCreateOptions> = {
  name: "channel_name",
  parentID: ["cpid", nonZero],
  ...settingNames,
};

/**
 * Create a channel and return the id the server assigned.
 *
 * Over the voice protocol the server also moves the creator into the new
 * channel.
 *
 * `channel` is what to send; the command's `signal` and `timeoutMs` go in
 * `options`, a separate last argument — set among the fields, they are not
 * read.
 */
export async function createChannel(
  client: CommandExecutor,
  channel: ChannelCreateOptions,
  options?: CommandOptions,
): Promise<ChannelID> {
  const rows = await query(client, "channelcreate", encodeFields(channel, createNames), options, [
    "channel_password",
  ]);
  return asChannelID(big(firstRow(rows, "channelcreate", "cid"), "cid"));
}

/** A channel's changed settings; see {@link ChannelSettings}. */
export interface ChannelEditOptions extends ChannelSettings {
  /** The channel's new name (`channel_name`). */
  readonly name?: string | undefined;
}

const editNames: WireNames<ChannelEditOptions> = { name: "channel_name", ...settingNames };

/**
 * Change a channel's settings. Only the fields you set are sent.
 *
 * `settings` is what to send; the command's `signal` and `timeoutMs` go in
 * `options`, a separate last argument — set among the fields, they are not
 * read.
 */
export async function editChannel(
  client: CommandExecutor,
  cid: ChannelID,
  settings: ChannelEditOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "channeledit", [["cid", cid], ...encodeFields(settings, editNames)], options, [
    "channel_password",
  ]);
}

/** How {@link deleteChannel} deletes. */
export interface ChannelDeleteOptions extends CommandOptions {
  /**
   * Delete the channel even while clients are in it, moving them out; false
   * by default, which the server then refuses for an occupied channel
   * (`force`, always sent).
   */
  readonly force?: boolean | undefined;
}

/** Delete a channel. */
export async function deleteChannel(
  client: CommandExecutor,
  cid: ChannelID,
  options: ChannelDeleteOptions = {},
): Promise<void> {
  await exec(
    client,
    "channeldelete",
    [
      ["cid", cid],
      ["force", options.force ?? false],
    ],
    options,
  );
}

const listFlags: ReadonlyArray<readonly [string, true]> = [
  ["-topic", true],
  ["-flags", true],
  ["-voice", true],
  ["-limits", true],
  ["-icon", true],
  ["-secondsempty", true],
  ["-banners", true],
];

/**
 * All channels on the server, in the server's own sort order.
 *
 * Always asks for the topic, flags, voice, limits, icon, seconds empty and
 * banners, which a bare `channellist` leaves out. The last two are asked for
 * and not read: `Channel` has no field for them yet. `description` and `uid` are not part of
 * `channellist` and stay empty; `getChannelInfo` has them.
 */
export async function listChannels(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<Channel[]> {
  return (await list(client, "channellist", listFlags, options)).map(parseChannel);
}

/**
 * One channel's full settings.
 *
 * `totalClients`, `totalFamilyClients` and `neededSubscribePower` are left
 * undefined: `channelinfo` does not carry them. `listChannels` does.
 *
 * `channelinfo` answers with `pid` and the settings but no `cid` — the channel
 * is whatever was asked for — so the id is taken from the argument rather than
 * read from the row, where it would come back 0.
 */
export async function getChannelInfo(
  client: CommandExecutor,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<Channel> {
  const rows = await query(client, "channelinfo", [["cid", cid]], options);
  return { ...parseChannel(firstRow(rows, "channelinfo")), id: cid };
}

/** A channel whose name matched a search. */
export interface ChannelMatch {
  /** The channel's id. */
  readonly id: ChannelID;
  /** The channel's name. */
  readonly name: string;
}

/**
 * Channels whose name contains `pattern`; none is an empty list. The server
 * reports finding none as error 768 (invalid channelID), which this answers
 * as `[]`.
 */
export async function findChannels(
  client: CommandExecutor,
  pattern: string,
  options?: CommandOptions,
): Promise<ChannelMatch[]> {
  const rows = await list(client, "channelfind", [["pattern", pattern]], options, {
    noMatch: ErrorCode.ChannelInvalidID,
  });
  return rows.map((row) => ({ id: asChannelID(big(row, "cid")), name: str(row, "channel_name") }));
}

/** Where {@link moveChannel} sorts the channel among its new siblings. */
export interface ChannelMoveOptions extends CommandOptions {
  /** The sibling to sort after, 0 for first; unset leaves it to the server (`order`). */
  readonly order?: ChannelID | undefined;
}

/** Move a channel under a new parent. */
export async function moveChannel(
  client: CommandExecutor,
  cid: ChannelID,
  parentID: ChannelID,
  options: ChannelMoveOptions = {},
): Promise<void> {
  await exec(
    client,
    "channelmove",
    [
      ["cid", cid],
      ["cpid", parentID],
      ["order", options.order],
    ],
    options,
  );
}

// ---- Channel permissions ----------------------------------------------------

/** Set a permission on a channel. */
export async function addChannelPermission(
  client: CommandExecutor,
  cid: ChannelID,
  permission: Permission,
  value: number,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channeladdperm",
    [["cid", cid], permissionParam(permission), ["permvalue", value]],
    options,
  );
}

/** Remove a permission from a channel. */
export async function deleteChannelPermission(
  client: CommandExecutor,
  cid: ChannelID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "channeldelperm", [["cid", cid], permissionParam(permission)], options);
}

/** Permissions set directly on a channel. */
export async function listChannelPermissions(
  client: CommandExecutor,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "channelpermlist", [["cid", cid]], options)).map(parsePermission);
}

/** Permissions granted to one client within one channel. */
export async function listChannelClientPermissions(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  const rows = await list(
    client,
    "channelclientpermlist",
    [
      ["cid", cid],
      ["cldbid", cldbid],
    ],
    options,
  );
  return rows.map(parsePermission);
}

/** Set a permission on one client within one channel. */
export async function addChannelClientPermission(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  permission: Permission,
  value: number,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelclientaddperm",
    [["cid", cid], ["cldbid", cldbid], permissionParam(permission), ["permvalue", value]],
    options,
  );
}

/** Remove a permission from one client within one channel. */
export async function deleteChannelClientPermission(
  client: CommandExecutor,
  cid: ChannelID,
  cldbid: ClientDBID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "channelclientdelperm",
    [["cid", cid], ["cldbid", cldbid], permissionParam(permission)],
    options,
  );
}
