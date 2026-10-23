/**
 * Client commands.
 *
 * A "client" is someone connected right now, identified by `clid`; a "client
 * database entry" is the persistent record, identified by `cldbid`. Both exist
 * and both appear below, so the two are named apart in the types rather than
 * relying on the reader to tell `ClientID` from `ClientDBID`.
 */

import {
  uint,
  U16,
  firstRow,
  exec,
  execRows,
  continueOnErrorParams,
  query,
  list,
  pages,
  encodeFields,
  nonEmpty,
  parsePermission,
  permissionParam,
  str,
  big,
  num,
  optNum,
  date,
} from "./command.js";
import type {
  BatchOptions,
  PagingOptions,
  Params,
  PermissionEntry,
  PermissionValue,
  WireNames,
} from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelGroupID,
  ChannelID,
  ChannelUID,
  ClientDBID,
  ClientID,
  IconID,
  ServerGroupID,
  UID,
} from "../command/ids.js";
import { asChannelID, asChannelUID, asClientDBID, asClientID, asUID } from "../command/ids.js";
import type { Permission } from "../permission.js";
import { Reason } from "../reason.js";
import { ErrorCode } from "../errorcode.js";
import { parseClient } from "./parse.js";

/** A connected client, as `clientlist` reports one. */
export interface ClientEntry {
  /** The client's id for this connection. It changes every time the client connects. */
  readonly id: ClientID;
  /** The client's nickname. */
  readonly nickname: string;
  /** What kind of connection this is, one of {@link ClientType}; every source carries it. */
  readonly type: number;
  /** The channel the client is in; every source carries it. */
  readonly channelID: ChannelID;
  /** The client's database id (`client_database_id`); every list and every enter notification carries it. */
  readonly databaseID: ClientDBID;

  // Everything below is `undefined` when the row did not carry its key, never
  // a default: a client that is not away and one whose away state was not asked
  // for are different, and `false` would claim the first. `clientlist` carries
  // only what its flags bring, and a client coming into view carries all but
  // the fields said to be missing there. Which list flag brings a field is said
  // on it; "no flag" means only a client coming into view (or a notification)
  // has it, so a client learned from `listClients` never does.

  /** The client's unique identifier, stable across connections, with `uid`. Empty is a client that has none. */
  readonly uid?: UID | undefined;
  /**
   * The server groups the client holds, with `groups`. Ids rather than names:
   * the server sends ids, and resolving them costs a separate call.
   */
  readonly serverGroups?: readonly ServerGroupID[] | undefined;
  /** Whether the client is away, with `away`. */
  readonly isAway?: boolean | undefined;
  /** Whether the client is recording, with `voice`. */
  readonly isRecording?: boolean | undefined;
  /** Whether the client may talk despite the channel's needed talk power, with `voice`. */
  readonly isTalker?: boolean | undefined;
  /** The channel group the client holds in its channel, with `groups`. */
  readonly channelGroupID?: ChannelGroupID | undefined;
  /** When the client first connected to this server, with `times`. */
  readonly createdAt?: Date | undefined;
  /** When the client last connected before this session, with `times`. */
  readonly lastConnectedAt?: Date | undefined;
  /**
   * How long since the client last did anything, in milliseconds
   * (`client_idle_time`), with `times`; undefined without it.
   */
  readonly idleTimeMs?: number | undefined;

  /** The away message (`client_away_message`), with `away`. */
  readonly awayMessage?: string | undefined;
  /** Whether the microphone is muted (`client_input_muted`), with `voice`. */
  readonly isInputMuted?: boolean | undefined;
  /** Whether the speakers are muted (`client_output_muted`), with `voice`. */
  readonly isOutputMuted?: boolean | undefined;
  /** Whether the client's output-only mute is set (`client_outputonly_muted`); no flag. */
  readonly isOutputOnlyMuted?: boolean | undefined;
  /** Whether the client has a working microphone (`client_input_hardware`), with `voice`. */
  readonly hasInputHardware?: boolean | undefined;
  /** Whether the client has working speakers (`client_output_hardware`), with `voice`. */
  readonly hasOutputHardware?: boolean | undefined;
  /** Whether the client speaks as channel commander (`client_is_channel_commander`), with `voice`. */
  readonly isChannelCommander?: boolean | undefined;
  /** Whether the client is a priority speaker (`client_is_priority_speaker`), with `voice`. */
  readonly isPrioritySpeaker?: boolean | undefined;
  /** The client's talk power in its channel (`client_talk_power`), with `voice`. */
  readonly talkPower?: number | undefined;
  /**
   * Whether the client is requesting to talk. The wire value is the time of
   * the request (`client_talk_request`); any non-zero value is true. No flag.
   */
  readonly isRequestingTalk?: boolean | undefined;
  /**
   * When the client asked to talk (`client_talk_request`, a unix time; 0 on
   * the wire when there is no request, which reads as undefined); no flag.
   */
  readonly talkRequestedAt?: Date | undefined;
  /** The message sent with a talk request (`client_talk_request_msg`); no flag. */
  readonly talkRequestMessage?: string | undefined;
  /** The client's description (`client_description`); no flag. */
  readonly description?: string | undefined;
  /** The client's meta data, an opaque string a client may set (`client_meta_data`); no flag. */
  readonly metaData?: string | undefined;
  /** The MD5 of the client's avatar (`client_flag_avatar`); "" for none; no flag. */
  readonly avatar?: string | undefined;
  /** The client's icon (`client_icon_id`), with `icon`; undefined for none as well as for absent. */
  readonly iconID?: IconID | undefined;
  /** How the nickname is pronounced (`client_nickname_phonetic`); no flag. */
  readonly nicknamePhonetic?: string | undefined;
  /** How many offline messages the client has not read (`client_unread_messages`); no flag. */
  readonly unreadMessages?: number | undefined;
  /**
   * The ServerQuery view power the client needs to see this client
   * (`client_needed_serverquery_view_power`); no flag. The server sends it
   * with every change of groups, so a changed group list carries it.
   */
  readonly neededServerQueryViewPower?: number | undefined;
  /**
   * The channel the client's channel group is inherited from
   * (`client_channel_group_inherited_channel_id`), with `groups`.
   */
  readonly channelGroupInheritedChannelID?: ChannelID | undefined;
  /** The client's country code (`client_country`), with `country`. */
  readonly country?: string | undefined;
  /** The client's version string (`client_version`), with `info`; not carried on coming into view. */
  readonly version?: string | undefined;
  /** The client's platform (`client_platform`), with `info`; not carried on coming into view. */
  readonly platform?: string | undefined;
  /** The client's address (`connection_client_ip`), with `ip`; not carried on coming into view. */
  readonly ip?: string | undefined;
  /** The client's badges (`client_badges`), with `badges`. */
  readonly badges?: string | undefined;
  /** The client's signed badges, as the server sends them (`client_signed_badges`); no flag. */
  readonly signedBadges?: string | undefined;
  /** The client's MyTeamSpeak id (`client_myteamspeak_id`); no flag. */
  readonly myTeamSpeakID?: string | undefined;
  /** The client's MyTeamSpeak avatar (`client_myteamspeak_avatar`); no flag. */
  readonly myTeamSpeakAvatar?: string | undefined;
  /** The client's integrations, as the server sends them (`client_integrations`); no flag. */
  readonly integrations?: string | undefined;
  /** The client's user tag (`client_user_tag`); TeamSpeak 6 only, no flag. */
  readonly userTag?: string | undefined;
  /** Whether the client is streaming (`client_is_streaming`); TeamSpeak 6 only, no flag. */
  readonly isStreaming?: boolean | undefined;
}

/**
 * A change to a client: only the properties a notification named, by the names
 * of {@link ClientEntry}. A key is present exactly when the notification
 * carried it, so `"isAway" in changes` says it changed, and an `isAway` of
 * `false` says the client is no longer away. A key holding `undefined` says
 * the value was cleared: `iconID` is `undefined` when the icon was removed.
 * A list, such as `serverGroups`, is the whole new list.
 */
export type ClientChanges = {
  readonly [K in Exclude<keyof ClientEntry, "id">]?: ClientEntry[K];
};

/**
 * The client with `changes` applied, as a new object; `entry` is not touched.
 * Keys `changes` lacks keep their value, and a key holding `undefined` clears
 * the property: the notification carried it and it is now none, as for an
 * icon of 0 or a withdrawn talk request.
 */
export function applyClientChanges(entry: ClientEntry, changes: ClientChanges): ClientEntry {
  const next: Record<string, unknown> = { ...entry };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as ClientEntry;
}

/**
 * Which optional fields `clientlist` should include. Each asks the server for
 * more per client; turn them off for a narrower response when watching a busy
 * server.
 */
export interface ClientListOptions extends CommandOptions {
  /** The unique identifier (`-uid`). On unless set to false: almost every caller needs it. */
  readonly uid?: boolean | undefined;
  /** Away state and message (`-away`). */
  readonly away?: boolean | undefined;
  /** Voice state: muted, talking, recording, talker (`-voice`). */
  readonly voice?: boolean | undefined;
  /** Server and channel groups (`-groups`). */
  readonly groups?: boolean | undefined;
  /** Creation, last connection and idle times (`-times`). */
  readonly times?: boolean | undefined;
  /** Client version and platform (`-info`). */
  readonly info?: boolean | undefined;
  /** The client's country (`-country`). */
  readonly country?: boolean | undefined;
  /** The client's address (`-ip`). */
  readonly ip?: boolean | undefined;
  /** The client's badges (`-badges`). */
  readonly badges?: boolean | undefined;
  /** The client's icon (`-icon`), which fills `ClientEntry.iconID`. */
  readonly icon?: boolean | undefined;
}

const listFlags: WireNames<ClientListOptions> = {
  uid: "-uid",
  away: "-away",
  voice: "-voice",
  groups: "-groups",
  times: "-times",
  info: "-info",
  country: "-country",
  ip: "-ip",
  badges: "-badges",
  icon: "-icon",
};

/** Every client currently connected. */
export async function listClients(
  client: CommandExecutor,
  options: ClientListOptions = {},
): Promise<ClientEntry[]> {
  const flags = encodeFields({ ...options, uid: options.uid !== false }, listFlags);
  return (await list(client, "clientlist", flags, options)).map(parseClient);
}

/**
 * One connected client's full detail, as the server sent it.
 *
 * Raw rather than parsed: `clientinfo` carries some eighty fields, which ones
 * appear depends on the server version and on the caller's permissions, and a
 * typed subset would drop the rest. Durations here are in the server's units —
 * `client_idle_time` and `connection_connected_time` in milliseconds. The keys
 * are named in `PropertyName`.
 */
export async function getClientProperties(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<Readonly<Record<string, string>>> {
  const rows = await query(client, "clientinfo", [["clid", clid]], options);
  return firstRow(rows, "clientinfo");
}

/** The three classes of traffic the server counts. */
export type ConnectionTrafficClass = "speech" | "keepalive" | "control";

/** One direction of one class of a client's traffic, as the client reported it. */
export interface ClientTraffic {
  /** Packets (`connection_packets_{sent,received}_<class>`). */
  readonly packets: number;
  /** Bytes (`connection_bytes_{sent,received}_<class>`). */
  readonly bytes: number;
  /** Bandwidth over the last second (`connection_bandwidth_{sent,received}_last_second_<class>`). */
  readonly bandwidthLastSecond: number;
  /** Bandwidth over the last minute (`connection_bandwidth_{sent,received}_last_minute_<class>`). */
  readonly bandwidthLastMinute: number;
}

/** Packet loss per class and in total, as a fraction. */
export interface PacketLoss {
  /** Loss of voice packets. */
  readonly speech: number;
  /** Loss of ping and pong packets. */
  readonly keepalive: number;
  /** Loss of command and acknowledgement packets. */
  readonly control: number;
  /** Loss over all packets. */
  readonly total: number;
}

/**
 * Another client's connection statistics, as `getconnectioninfo` reports
 * them. Most figures are what the client itself reported with
 * `setconnectioninfo`; a client that has not reported yet shows zeros.
 * `connectedTimeMs` and `idleTimeMs` come from the server, as do the
 * `clientToServerLoss` figures (a client's own report of them is ignored).
 */
export interface ClientConnectionInfo {
  /** The client the figures are about (`clid`). */
  readonly id: ClientID;
  /** Round-trip time in milliseconds (`connection_ping`). */
  readonly pingMs: number;
  /** Deviation of the round-trip time in milliseconds (`connection_ping_deviation`). */
  readonly pingDeviationMs: number;
  /** How long the client has been connected, in milliseconds (`connection_connected_time`). */
  readonly connectedTimeMs: number;
  /** How long the client has been idle, in milliseconds (`connection_idle_time`). */
  readonly idleTimeMs: number;
  /** The client's address (`connection_client_ip`); absent when the server does not send it. */
  readonly ip?: string | undefined;
  /** The client's port (`connection_client_port`); absent when the server does not send it. */
  readonly port?: number | undefined;
  /** What the client sent, by class. */
  readonly sent: Readonly<Record<ConnectionTrafficClass, ClientTraffic>>;
  /** What the client received, by class. */
  readonly received: Readonly<Record<ConnectionTrafficClass, ClientTraffic>>;
  /** Loss on the way from the server to the client (`connection_server2client_packetloss_<class>`). */
  readonly serverToClientLoss: PacketLoss;
  /** Loss on the way from the client to the server (`connection_client2server_packetloss_<class>`). */
  readonly clientToServerLoss: PacketLoss;
  /** File transfer bandwidth out (`connection_filetransfer_bandwidth_sent`). */
  readonly fileTransferBandwidthSent: number;
  /** File transfer bandwidth in (`connection_filetransfer_bandwidth_received`). */
  readonly fileTransferBandwidthReceived: number;
}

const trafficClasses = ["speech", "keepalive", "control"] as const;

function readTraffic(
  row: Record<string, string>,
  direction: "sent" | "received",
): Record<ConnectionTrafficClass, ClientTraffic> {
  const out = {} as Record<ConnectionTrafficClass, ClientTraffic>;
  for (const c of trafficClasses) {
    out[c] = {
      packets: num(row, `connection_packets_${direction}_${c}`),
      bytes: num(row, `connection_bytes_${direction}_${c}`),
      bandwidthLastSecond: num(row, `connection_bandwidth_${direction}_last_second_${c}`),
      bandwidthLastMinute: num(row, `connection_bandwidth_${direction}_last_minute_${c}`),
    };
  }
  return out;
}

function readLoss(row: Record<string, string>, way: "server2client" | "client2server"): PacketLoss {
  return {
    speech: num(row, `connection_${way}_packetloss_speech`),
    keepalive: num(row, `connection_${way}_packetloss_keepalive`),
    control: num(row, `connection_${way}_packetloss_control`),
    total: num(row, `connection_${way}_packetloss_total`),
  };
}

/**
 * Another client's connection statistics (`getconnectioninfo clid=`). The
 * server answers with `notifyconnectioninfo`, and asks that client to report
 * its figures meanwhile; what is returned is what the server holds, so a
 * client that never reported shows zeros. Not the same as
 * {@link getConnectionInfo}, which is about the virtual server. `ip` and `port` are
 * present on both servers for the account measured; whether a permission
 * governs them is unmeasured.
 *
 * On the voice protocol the row that names the client is the answer, whether
 * it comes before or after the command's `error`; if it has not come by then,
 * the call waits for it until `options` give up.
 */
export async function getClientConnectionInfo(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<ClientConnectionInfo> {
  const row = firstRow(
    await query(client, "getconnectioninfo", [["clid", clid]], options),
    "getconnectioninfo",
  );
  return {
    id: asClientID(uint(row, "clid", U16)),
    pingMs: num(row, "connection_ping"),
    pingDeviationMs: num(row, "connection_ping_deviation"),
    connectedTimeMs: num(row, "connection_connected_time"),
    idleTimeMs: num(row, "connection_idle_time"),
    ip: row["connection_client_ip"],
    port:
      row["connection_client_port"] === undefined ? undefined : num(row, "connection_client_port"),
    sent: readTraffic(row, "sent"),
    received: readTraffic(row, "received"),
    serverToClientLoss: readLoss(row, "server2client"),
    clientToServerLoss: readLoss(row, "client2server"),
    fileTransferBandwidthSent: num(row, "connection_filetransfer_bandwidth_sent"),
    fileTransferBandwidthReceived: num(row, "connection_filetransfer_bandwidth_received"),
  };
}

/** How {@link moveClient} enters the channel. */
export interface ClientMoveOptions extends CommandOptions {
  /**
   * The channel's password, in cleartext; the voice client hashes it on the
   * wire. Unset sends none (`cpw`).
   */
  readonly password?: string | undefined;
}

/** Move a client to another channel. */
export async function moveClient(
  client: CommandExecutor,
  clid: ClientID,
  channelID: ChannelID,
  options: ClientMoveOptions = {},
): Promise<void> {
  await exec(
    client,
    "clientmove",
    [
      ["clid", clid],
      ["cid", channelID],
      ["cpw", options.password],
    ],
    options,
    ["cpw"],
  );
}

/** How {@link moveClients} enters the channel. */
export interface ClientsMoveOptions extends ClientMoveOptions, BatchOptions {}

/**
 * Move several clients to one channel, in one command, such as
 * `clientmove clid=5|clid=6 cid=3`. With no ids nothing is sent.
 *
 * The server reports one answer for the whole call, never one per client, so
 * this resolves to nothing and a failure says only what the server said.
 * Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1, over raw
 * ServerQuery, SSH, WebQuery and the voice protocol alike:
 *
 * - Without `continueOnError`, the server checks every client first: one id it
 *   cannot move (no such client, error 512; a client already in the channel,
 *   770) refuses the call, and no client is moved.
 * - With it (`-continueonerror`), a client that cannot be moved is skipped, the
 *   others are moved, and the answer is success, even when none could be moved.
 *   Read the channel back, as `listClients` reports it, to know who moved.
 *
 * A channel that does not exist fails the call either way (768).
 */
export async function moveClients(
  client: CommandExecutor,
  clientIDs: readonly ClientID[],
  channelID: ChannelID,
  options: ClientsMoveOptions = {},
): Promise<void> {
  await execRows(
    client,
    "clientmove",
    [...continueOnErrorParams(options), ["cid", channelID], ["cpw", options.password]],
    clientIDs.map((clid) => [["clid", clid]]),
    options,
    ["cpw"],
  );
}

/** The reasons a client can be kicked for. */
export type KickReason = typeof Reason.KickChannel | typeof Reason.KickServer;

/** What {@link kickClient} tells the kicked client. */
export interface ClientKickOptions extends CommandOptions {
  /** Shown to the client; unset or `""` sends none (`reasonmsg`). */
  readonly reasonMessage?: string | undefined;
}

/**
 * Kick a client from its channel (`Reason.KickChannel`), which moves it to the
 * default channel, or from the server (`Reason.KickServer`), which disconnects
 * it. Any other reason is refused before anything is sent.
 */
export async function kickClient(
  client: CommandExecutor,
  clid: ClientID,
  reason: KickReason,
  options: ClientKickOptions = {},
): Promise<void> {
  if (reason !== Reason.KickChannel && reason !== Reason.KickServer) {
    throw new RangeError(
      `a kick's reason is Reason.KickChannel or Reason.KickServer, not ${String(reason)}`,
    );
  }
  await exec(
    client,
    "clientkick",
    [
      ["clid", clid],
      ["reasonid", reason],
      ["reasonmsg", nonEmpty(options.reasonMessage ?? "")],
    ],
    options,
  );
}

/** What {@link kickClients} tells the kicked clients, and whether it goes on past a failure. */
export interface ClientsKickOptions extends ClientKickOptions, BatchOptions {}

/**
 * Kick several clients for one reason, in one command, such as
 * `clientkick reasonid=4 clid=5|clid=6`. The reason is as for
 * {@link kickClient}; with no ids nothing is sent.
 *
 * The server reports one answer for the whole call, never one per client, so
 * this resolves to nothing and a failure says only what the server said.
 * Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1, over raw
 * ServerQuery, SSH, WebQuery and the voice protocol alike:
 *
 * - Without `continueOnError`, the clients are kicked in the order given and
 *   the call stops at the first one that fails (an id no client has, 512):
 *   the clients before it are kicked, the ones after it are not, and the
 *   error is that client's.
 * - With it (`-continueonerror`), every client is tried, a failing one is
 *   skipped, and the answer is success, even when none could be kicked. Read
 *   the clients back, as `listClients` reports them, to know who was kicked.
 */
export async function kickClients(
  client: CommandExecutor,
  clientIDs: readonly ClientID[],
  reason: KickReason,
  options: ClientsKickOptions = {},
): Promise<void> {
  if (reason !== Reason.KickChannel && reason !== Reason.KickServer) {
    throw new RangeError(
      `a kick's reason is Reason.KickChannel or Reason.KickServer, not ${String(reason)}`,
    );
  }
  await execRows(
    client,
    "clientkick",
    [
      ...continueOnErrorParams(options),
      ["reasonid", reason],
      ["reasonmsg", nonEmpty(options.reasonMessage ?? "")],
    ],
    clientIDs.map((clid) => [["clid", clid]]),
    options,
  );
}

/** Send a poke to a client. */
export async function pokeClient(
  client: CommandExecutor,
  clid: ClientID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientpoke",
    [
      ["clid", clid],
      ["msg", message],
    ],
    options,
  );
}

/**
 * Who receives a plugin command: `"channel"` for the clients in the sender's
 * channel, `"server"` for every client on the server, or one client by id.
 */
export type PluginCommandTarget = "channel" | "server" | { readonly clientID: ClientID };

/** The `targetmode` of `plugincmd`, by what it addresses. */
const pluginTargetModes = { channel: 0, server: 1, client: 2 } as const;

/**
 * Send a plugin command: a named payload that other clients' plugins agree on
 * and the server relays without reading. The receiving client gets it as the
 * `pluginCommand` event.
 *
 * Measured on TeamSpeak 3 and 6, who receives it:
 *
 * - `"channel"`: the clients in the sender's channel, and the sender. A client
 *   in another channel gets nothing, subscribed to this one or not.
 * - `"server"`: every client on the server, and the sender.
 * - `{ clientID }`: that client only; the sender receives it just when it
 *   names itself. An id no client has is refused with `ErrorCode.ClientInvalidID`.
 *
 * `data` may be empty, and is delivered empty. A ServerQuery connection cannot
 * send plugin commands: the server refuses with 516, invalid client type.
 * The server has a fourth mode, 3, which was seen to reach the same clients as
 * the whole server, so it is not offered.
 */
export async function sendPluginCommand(
  client: CommandExecutor,
  name: string,
  data: string,
  target: PluginCommandTarget,
  options?: CommandOptions,
): Promise<void> {
  const addressed: Params =
    target === "channel"
      ? [["targetmode", pluginTargetModes.channel]]
      : target === "server"
        ? [["targetmode", pluginTargetModes.server]]
        : [
            ["targetmode", pluginTargetModes.client],
            ["target", target.clientID],
          ];
  await exec(client, "plugincmd", [["name", name], ["data", data], ...addressed], options);
}

/**
 * Tell a client that we are typing a private message to it, which it receives
 * as the `clientChatComposing` event. Only that client is told, whatever
 * channel it is in; naming ourselves tells ourselves. An id no client has is
 * refused with `ErrorCode.ClientInvalidID`. A ServerQuery connection cannot send
 * it: the server answers 256, command not found.
 */
export async function sendChatComposing(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientchatcomposing", [["clid", clid]], options);
}

/**
 * Tell a client that we closed our private chat with it. It is only delivered
 * to a client we have sent a private message to; for any other the server
 * accepts the command and sends nothing. The client receives it as a
 * `notification` named `NotificationName.ClientChatClosed`, since it has no
 * typed event. A ServerQuery connection cannot send it.
 */
export async function closePrivateChat(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientchatclosed", [["clid", clid]], options);
}

/**
 * Our own client state, as `clientupdate` takes it.
 *
 * Only the fields you set are sent. An unset (undefined) field is omitted and
 * leaves the setting alone; any other value is sent, so `""` sends an empty
 * value — `awayMessage: ""` clears the away message.
 */
export interface ClientUpdateOptions {
  /** Our nickname (`client_nickname`). */
  readonly nickname?: string | undefined;
  /** How the nickname is pronounced, for text-to-speech (`client_nickname_phonetic`). */
  readonly nicknamePhonetic?: string | undefined;
  /** Whether our microphone is muted (`client_input_muted`). */
  readonly isInputMuted?: boolean | undefined;
  /** Whether our speakers are muted (`client_output_muted`). */
  readonly isOutputMuted?: boolean | undefined;
  /** Whether we have a working microphone (`client_input_hardware`). */
  readonly hasInputHardware?: boolean | undefined;
  /** Whether we have working speakers (`client_output_hardware`). */
  readonly hasOutputHardware?: boolean | undefined;
  /** Whether we are away (`client_away`). */
  readonly isAway?: boolean | undefined;
  /** The away message (`client_away_message`). */
  readonly awayMessage?: string | undefined;
  /** Whether we speak as channel commander (`client_is_channel_commander`). */
  readonly isChannelCommander?: boolean | undefined;
  /** Whether we are recording (`client_is_recording`). */
  readonly isRecording?: boolean | undefined;
  /** Whether we are requesting to talk (`client_talk_request`). */
  readonly isRequestingTalk?: boolean | undefined;
  /** The message sent with a talk request (`client_talk_request_msg`). */
  readonly talkRequestMessage?: string | undefined;
  /** Our avatar's MD5, as uploaded to the file area; "" removes it (`client_flag_avatar`). */
  readonly avatar?: string | undefined;
  /** Our badges, in the client's own format (`client_badges`). */
  readonly badges?: string | undefined;
  /** Opaque data other clients see in their record of us (`client_meta_data`). */
  readonly metaData?: string | undefined;
}

const updateNames: WireNames<ClientUpdateOptions> = {
  nickname: "client_nickname",
  nicknamePhonetic: "client_nickname_phonetic",
  isInputMuted: "client_input_muted",
  isOutputMuted: "client_output_muted",
  hasInputHardware: "client_input_hardware",
  hasOutputHardware: "client_output_hardware",
  isAway: "client_away",
  awayMessage: "client_away_message",
  isChannelCommander: "client_is_channel_commander",
  isRecording: "client_is_recording",
  isRequestingTalk: "client_talk_request",
  talkRequestMessage: "client_talk_request_msg",
  avatar: "client_flag_avatar",
  badges: "client_badges",
  metaData: "client_meta_data",
};

/**
 * Change our own client state (nickname, mute, away, …). Only the fields you
 * set are sent.
 *
 * `clientupdate` addresses the calling client implicitly — there is no clid
 * parameter on the wire, which is why this takes no id.
 *
 * `update` is what to send; the command's `signal` and `timeoutMs` go in
 * `options`, a separate last argument — set among the fields, they are not
 * read.
 */
export async function updateClient(
  client: CommandExecutor,
  update: ClientUpdateOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientupdate", encodeFields(update, updateNames), options);
}

/**
 * Another client's editable attributes, as `clientedit` takes them. Unset
 * fields are omitted; `""` is sent empty.
 */
export interface ClientEditOptions {
  /** The client's description (`client_description`). */
  readonly description?: string | undefined;
  /** Whether the client may talk despite a channel's needed talk power (`client_is_talker`). */
  readonly isTalker?: boolean | undefined;
}

const editNames: WireNames<ClientEditOptions> = {
  description: "client_description",
  isTalker: "client_is_talker",
};

/**
 * Change another client's editable attributes. Only the fields you set are
 * sent.
 *
 * `edit` is what to send; the command's `signal` and `timeoutMs` go in
 * `options`, a separate last argument — set among the fields, they are not
 * read.
 */
export async function editClient(
  client: CommandExecutor,
  clid: ClientID,
  edit: ClientEditOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientedit", [["clid", clid], ...encodeFields(edit, editNames)], options);
}

/** A connected client whose nickname matched a search. */
export interface ClientMatch {
  /** The client's id. */
  readonly id: ClientID;
  /** The client's nickname. */
  readonly nickname: string;
  /** The channel the client is in, from `findClients` with `channelID`, on TS6; undefined otherwise. */
  readonly channelID?: ChannelID | undefined;
  /** That channel's unique identifier, from `findClients` with `channelUID`, on TS6; undefined otherwise. */
  readonly channelUID?: ChannelUID | undefined;
}

/** Which extra fields {@link findClients} reports, where the server has them (TS6). */
export interface ClientFindOptions extends CommandOptions {
  /** Report the channel each client is in, as `channelID` (`-cid`). */
  readonly channelID?: boolean | undefined;
  /** Report the unique identifier of that channel, as `channelUID` (`-chuid`). */
  readonly channelUID?: boolean | undefined;
}

const findFlags: WireNames<ClientFindOptions> = { channelID: "-cid", channelUID: "-chuid" };

/**
 * Clients whose nickname contains `pattern`; none is an empty list. The server
 * reports finding no one as error 512 (invalid clientID), which this answers
 * as `[]`.
 *
 * `channelID` and `channelUID` add where each client is. They report, they do
 * not filter: every match is returned either way. TS3 accepts the flags and
 * sends neither field, so on TS3 the fields stay undefined.
 */
export async function findClients(
  client: CommandExecutor,
  pattern: string,
  options: ClientFindOptions = {},
): Promise<ClientMatch[]> {
  const rows = await list(
    client,
    "clientfind",
    [["pattern", pattern], ...encodeFields(options, findFlags)],
    options,
    { noMatch: ErrorCode.ClientInvalidID },
  );
  return rows.map((row) => ({
    id: asClientID(uint(row, "clid", U16)),
    nickname: str(row, "client_nickname"),
    ...(row["cid"] === undefined ? {} : { channelID: asChannelID(big(row, "cid")) }),
    ...(row["chuid"] === undefined ? {} : { channelUID: asChannelUID(str(row, "chuid")) }),
  }));
}

/**
 * Every client currently using a given unique identifier, with the nickname
 * each uses; none is an empty list.
 */
export async function getClientIDs(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientMatch[]> {
  const rows = await list(client, "clientgetids", [["cluid", uid]], options);
  return rows.map((row) => ({
    id: asClientID(uint(row, "clid", U16)),
    nickname: str(row, "name"),
  }));
}

/** The uid of a connected client. */
export async function getClientUIDByID(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<UID> {
  const rows = await query(client, "clientgetuidfromclid", [["clid", clid]], options);
  return asUID(str(firstRow(rows, "clientgetuidfromclid", "cluid"), "cluid"));
}

/** What `clientgetuidfromclid` says about a connected client. */
export interface ClientUIDInfo {
  /** The client's id (`clid`). */
  readonly clientID: ClientID;
  /** The client's unique identifier (`cluid`). */
  readonly uid: UID;
  /** The client's nickname (`nickname`). */
  readonly nickname: string;
  /** The client's myTeamSpeak id (`mytsid`); "" for none, as TS3 3.13.8 and TS6 6.0.0-beta13.1 sent it for a client without one. */
  readonly mytsid: string;
}

/**
 * The uid, nickname and myTeamSpeak id of a connected client.
 * {@link getClientUIDByID} is the same command, keeping only the uid.
 */
export async function getClientUIDInfoByID(
  client: CommandExecutor,
  clid: ClientID,
  options?: CommandOptions,
): Promise<ClientUIDInfo> {
  const rows = await query(client, "clientgetuidfromclid", [["clid", clid]], options);
  const row = firstRow(rows, "clientgetuidfromclid", "cluid");
  return {
    clientID: asClientID(uint(row, "clid", U16)),
    uid: asUID(str(row, "cluid")),
    nickname: str(row, "nickname"),
    mytsid: str(row, "mytsid"),
  };
}

/** The persistent database id behind a uid. */
export async function getClientDBIDByUID(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientDBID> {
  const rows = await query(client, "clientgetdbidfromuid", [["cluid", uid]], options);
  return asClientDBID(big(firstRow(rows, "clientgetdbidfromuid", "cldbid"), "cldbid"));
}

/** The database record a uid or database id names. */
export interface ClientDatabaseName {
  /** The client's database id. */
  readonly databaseID: ClientDBID;
  /** The nickname the client last used. */
  readonly name: string;
  /** The client's unique identifier (`cluid`); "" when the server sent none. */
  readonly uid: UID;
}

function parseDatabaseName(row: Record<string, string>): ClientDatabaseName {
  return {
    databaseID: asClientDBID(big(row, "cldbid")),
    name: str(row, "name"),
    uid: asUID(str(row, "cluid")),
  };
}

/** The database id and nickname recorded for a database id. */
export async function getClientNameByDBID(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<ClientDatabaseName> {
  const rows = await query(client, "clientgetnamefromdbid", [["cldbid", cldbid]], options);
  return parseDatabaseName(firstRow(rows, "clientgetnamefromdbid", "cldbid"));
}

/** The database id and nickname recorded for a uid. */
export async function getClientNameByUID(
  client: CommandExecutor,
  uid: UID,
  options?: CommandOptions,
): Promise<ClientDatabaseName> {
  const rows = await query(client, "clientgetnamefromuid", [["cluid", uid]], options);
  return parseDatabaseName(firstRow(rows, "clientgetnamefromuid", "cldbid"));
}

/** Give a client a channel group in one channel. */
export async function setClientChannelGroup(
  client: CommandExecutor,
  cgid: ChannelGroupID,
  cid: ChannelID,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "setclientchannelgroup",
    [
      ["cgid", cgid],
      ["cid", cid],
      ["cldbid", cldbid],
    ],
    options,
  );
}

// ---- Client database --------------------------------------------------------

/** A persistent client record, as `clientdblist` and `clientdbinfo` report it. */
export interface ClientDatabaseEntry {
  /** The record's id. */
  readonly databaseID: ClientDBID;
  /** The client's unique identifier. */
  readonly uid: UID;
  /** The nickname the client last used. */
  readonly nickname: string;
  /** When the client first connected. */
  readonly createdAt: Date | undefined;
  /** When the client last connected. */
  readonly lastConnectedAt: Date | undefined;
  /** How many times the client has connected. */
  readonly totalConnections: number;
  /** The client's description. */
  readonly description: string;
  /** The address the client last connected from. */
  readonly lastIP: string;
  /** The client's query account name (`client_login_name`); "" for none; `clientdblist` rows only. */
  readonly loginName?: string | undefined;
  /** The MD5 of the client's avatar (`client_flag_avatar`), "" for none; `getClientDatabaseInfo` only. */
  readonly avatarHash?: string | undefined;
  /** Bytes the client has uploaded in all (`client_total_bytes_uploaded`); `getClientDatabaseInfo` only. */
  readonly totalBytesUploaded?: number | undefined;
  /** Bytes the client has downloaded in all (`client_total_bytes_downloaded`); `getClientDatabaseInfo` only. */
  readonly totalBytesDownloaded?: number | undefined;
  /** Bytes the client has uploaded this month (`client_month_bytes_uploaded`); `getClientDatabaseInfo` only. */
  readonly monthBytesUploaded?: number | undefined;
  /** Bytes the client has downloaded this month (`client_month_bytes_downloaded`); `getClientDatabaseInfo` only. */
  readonly monthBytesDownloaded?: number | undefined;
}

const optStr = (row: Record<string, string>, key: string): string | undefined => row[key];

const parseDatabaseEntry = (row: Record<string, string>): ClientDatabaseEntry => ({
  databaseID: asClientDBID(big(row, "cldbid")),
  uid: asUID(str(row, "client_unique_identifier")),
  nickname: str(row, "client_nickname"),
  createdAt: date(row, "client_created"),
  lastConnectedAt: date(row, "client_lastconnected"),
  totalConnections: num(row, "client_totalconnections"),
  description: str(row, "client_description"),
  lastIP: str(row, "client_lastip"),
  loginName: optStr(row, "client_login_name"),
  avatarHash: optStr(row, "client_flag_avatar"),
  totalBytesUploaded: optNum(row, "client_total_bytes_uploaded"),
  totalBytesDownloaded: optNum(row, "client_total_bytes_downloaded"),
  monthBytesUploaded: optNum(row, "client_month_bytes_uploaded"),
  monthBytesDownloaded: optNum(row, "client_month_bytes_downloaded"),
});

/** Which slice of the client database {@link listClientDatabase} reads. */
export interface ClientDatabasePageOptions extends CommandOptions {
  /** The offset of the first record, 0 by default (`start`). */
  readonly start?: number | undefined;
  /** How many records to read at most; the server caps it (`duration`). */
  readonly limit?: number | undefined;
}

const pageNames: WireNames<ClientDatabasePageOptions> = { start: "start", limit: "duration" };

/**
 * One page of persistent client records.
 *
 * The database is paged, and the server caps a page; {@link iterateClientDatabase}
 * walks all of it. A `start` past the last record is an empty page.
 */
export async function listClientDatabase(
  client: CommandExecutor,
  options: ClientDatabasePageOptions = {},
): Promise<ClientDatabaseEntry[]> {
  return (await list(client, "clientdblist", encodeFields(options, pageNames), options)).map(
    parseDatabaseEntry,
  );
}

/**
 * Every persistent client record, fetched a page at a time as the loop asks
 * for more:
 *
 * ```ts
 * for await (const entry of iterateClientDatabase(client, { signal })) { ... }
 * ```
 *
 * The walk ends when the server answers a page past the last record with
 * error 1281, or with a page shorter than an earlier one; any other error is
 * thrown from the loop. Each page is a separate `clientdblist`, given the
 * options' signal and timeoutMs, so records added or removed meanwhile can be
 * skipped or seen twice.
 */
export function iterateClientDatabase(
  client: CommandExecutor,
  options?: PagingOptions,
): AsyncIterable<ClientDatabaseEntry> {
  return pages(
    client,
    "clientdblist",
    parseDatabaseEntry,
    (previous, next) => next.databaseID > previous.databaseID,
    options,
  );
}

/**
 * Database ids of the records whose nickname matches `pattern`, which may use
 * `%` as a wildcard. No match is an empty list.
 */
export async function findClientDatabase(
  client: CommandExecutor,
  pattern: string,
  options?: CommandOptions,
): Promise<ClientDBID[]> {
  const rows = await list(client, "clientdbfind", [["pattern", pattern]], options);
  return rows.map((row) => asClientDBID(big(row, "cldbid")));
}

/**
 * Database ids of the records whose unique identifier matches `pattern`
 * (`clientdbfind -uid`). No match is an empty list.
 *
 * The match is SQL `LIKE` over the whole identifier, on TeamSpeak 3 and 6
 * alike: without a wildcard `pattern` must be the entire uid, `%` stands for
 * any run of characters and `_` for any one, and case is ignored. A fragment
 * of a uid with no `%` finds nothing, so append `%` to search by prefix. A server answers
 * at most 50 ids for one pattern.
 */
export async function findClientDatabaseByUID(
  client: CommandExecutor,
  pattern: string,
  options?: CommandOptions,
): Promise<ClientDBID[]> {
  const rows = await list(
    client,
    "clientdbfind",
    [
      ["pattern", pattern],
      ["-uid", true],
    ],
    options,
  );
  return rows.map((row) => asClientDBID(big(row, "cldbid")));
}

/** One database record. */
export async function getClientDatabaseInfo(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<ClientDatabaseEntry> {
  const rows = await query(client, "clientdbinfo", [["cldbid", cldbid]], options);
  return { ...parseDatabaseEntry(firstRow(rows, "clientdbinfo")), databaseID: cldbid };
}

/**
 * A database record's editable attributes, as `clientdbedit` takes them.
 * Unset fields are omitted; `""` is sent empty.
 */
export interface ClientDatabaseEditOptions {
  /** The client's description (`client_description`). */
  readonly description?: string | undefined;
}

const databaseEditNames: WireNames<ClientDatabaseEditOptions> = {
  description: "client_description",
};

/**
 * Change a database record. Only the fields you set are sent.
 *
 * `edit` is what to send; the command's `signal` and `timeoutMs` go in
 * `options`, a separate last argument — set among the fields, they are not
 * read.
 */
export async function editClientDatabase(
  client: CommandExecutor,
  cldbid: ClientDBID,
  edit: ClientDatabaseEditOptions,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "clientdbedit",
    [["cldbid", cldbid], ...encodeFields(edit, databaseEditNames)],
    options,
  );
}

/** Delete a client from the database entirely. */
export async function deleteClientDatabase(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientdbdelete", [["cldbid", cldbid]], options);
}

// ---- Client permissions -----------------------------------------------------

/** Permissions set on a client, server-wide. */
export async function listClientPermissions(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<PermissionEntry[]> {
  return (await list(client, "clientpermlist", [["cldbid", cldbid]], options)).map(parsePermission);
}

/** How {@link addClientPermission} sets the permission. */
export interface ClientPermissionOptions extends CommandOptions {
  /**
   * Whether it skips channel and client overrides; false by default. Always
   * sent: the server requires it here, unlike the channel equivalent
   * (`permskip`).
   */
  readonly skip?: boolean | undefined;
}

/** Set a permission on a client, server-wide. */
export async function addClientPermission(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permission: Permission,
  value: number,
  options: ClientPermissionOptions = {},
): Promise<void> {
  await exec(
    client,
    "clientaddperm",
    [
      ["cldbid", cldbid],
      permissionParam(permission),
      ["permvalue", value],
      ["permskip", options.skip ?? false],
    ],
    options,
  );
}

/** One permission to set on a client, server-wide, as {@link addClientPermissions} takes it. */
export interface ClientPermissionValue extends PermissionValue {
  /** Whether it skips channel and client overrides; false by default. Always sent (`permskip`). */
  readonly skip?: boolean | undefined;
}

/**
 * Set several permissions on a client, server-wide, in one command: each
 * permission is a row (`permsid=…  permvalue=…  permskip=0|…`). With none,
 * nothing is sent.
 *
 * The server checks every row before it applies any: a permission it does not
 * know (2562) or a value it cannot read (1540) refuses the call, and none is
 * set, with or without `continueOnError`. Measured on TeamSpeak 3 3.13.8 and
 * TeamSpeak 6 beta13.1, over raw ServerQuery, SSH, WebQuery and the voice
 * protocol alike. Resolves to nothing: the server never reports one answer
 * per row.
 *
 * A permission the caller has too little modify power for (2570, or 2568 where
 * the group power is short) is another matter: the rows are applied in order.
 * Without `continueOnError` the first row that fails ends the call, so the rows
 * before it are set and the rows after it are not; with it the rows that fail
 * are skipped and the others set. The error is the failing row's, and which row
 * is not reported; with several failing rows which error comes back was not
 * measured. Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 beta13.1, over raw
 * ServerQuery (TeamSpeak 3), SSH, WebQuery and the voice protocol, in both
 * orders of a free and a locked permission.
 */
export async function addClientPermissions(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permissions: readonly ClientPermissionValue[],
  options: BatchOptions = {},
): Promise<void> {
  await execRows(
    client,
    "clientaddperm",
    [...continueOnErrorParams(options), ["cldbid", cldbid]],
    permissions.map((entry) => [
      permissionParam(entry.permission),
      ["permvalue", entry.value],
      ["permskip", entry.skip ?? false],
    ]),
    options,
  );
}

/** Remove a permission from a client. */
export async function deleteClientPermission(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permission: Permission,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "clientdelperm", [["cldbid", cldbid], permissionParam(permission)], options);
}

/**
 * Remove several permissions from a client, in one command: each permission is
 * a row (`permsid=…|permsid=…`). With none, nothing is sent.
 *
 * The server checks every row before it removes any: one permission it does
 * not know (2562) refuses the call and none is removed. Removing a permission
 * the client does not have succeeds. A permission the caller has too little
 * modify power for (2570) ends the call at that row: the rows before it are
 * removed and the rows after it are not, measured on TeamSpeak 3 3.13.8 and
 * TeamSpeak 6 beta13.1 over every query transport and the voice protocol. The
 * server documents no `-continueonerror` for this command, so none is offered,
 * and sent anyway it changed nothing.
 */
export async function deleteClientPermissions(
  client: CommandExecutor,
  cldbid: ClientDBID,
  permissions: readonly Permission[],
  options?: CommandOptions,
): Promise<void> {
  await execRows(
    client,
    "clientdelperm",
    [["cldbid", cldbid]],
    permissions.map((permission) => [permissionParam(permission)]),
    options,
  );
}

// ---- Custom properties --------------------------------------------------------

/** One custom property of a client: a key and a value, both free text. */
export interface CustomProperty {
  /** The property's name (`ident`). */
  readonly ident: string;
  /** Its value (`value`). */
  readonly value: string;
}

/** A custom property found by {@link findCustomProperty}, and whose it is. */
export interface CustomPropertyMatch extends CustomProperty {
  /** The client that has it (`cldbid`). */
  readonly databaseID: ClientDBID;
}

/**
 * Set a custom property on a client, creating or replacing it. The server does
 * not check that the client exists.
 *
 * Needs `b_client_modify_dbproperties`. Works over the voice protocol and
 * ServerQuery on TS3 and TS6.
 */
export async function setCustomProperty(
  client: CommandExecutor,
  cldbid: ClientDBID,
  ident: string,
  value: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "customset",
    [
      ["cldbid", cldbid],
      ["ident", ident],
      ["value", value],
    ],
    options,
  );
}

/**
 * Remove a custom property from a client. Removing one it does not have is not
 * an error.
 *
 * Needs `b_client_delete_dbproperties`.
 */
export async function deleteCustomProperty(
  client: CommandExecutor,
  cldbid: ClientDBID,
  ident: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "customdelete",
    [
      ["cldbid", cldbid],
      ["ident", ident],
    ],
    options,
  );
}

/**
 * A client's custom properties. None is an empty list.
 *
 * The server reports a client with no properties as error 512 (invalid
 * clientID), the same as a client that does not exist, so both answer `[]`
 * here; `getClientDatabaseInfo` tells them apart.
 */
export async function listCustomProperties(
  client: CommandExecutor,
  cldbid: ClientDBID,
  options?: CommandOptions,
): Promise<CustomProperty[]> {
  const rows = await list(client, "custominfo", [["cldbid", cldbid]], options, {
    noMatch: ErrorCode.ClientInvalidID,
  });
  return rows.map((row) => ({ ident: str(row, "ident"), value: str(row, "value") }));
}

/**
 * Every client with a custom property `ident` whose value matches `pattern`,
 * which may hold the SQL wildcard `%`. None is an empty list.
 */
export async function findCustomProperty(
  client: CommandExecutor,
  ident: string,
  pattern: string,
  options?: CommandOptions,
): Promise<CustomPropertyMatch[]> {
  const rows = await list(
    client,
    "customsearch",
    [
      ["ident", ident],
      ["pattern", pattern],
    ],
    options,
  );
  return rows.map((row) => ({
    databaseID: asClientDBID(big(row, "cldbid")),
    ident: str(row, "ident"),
    value: str(row, "value"),
  }));
}
