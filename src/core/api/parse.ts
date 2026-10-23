/**
 * Row parsers shared with the client and query modules, kept out of the public index:
 * they read wire rows, which is plumbing, not API. They reach them through
 * `./internal`.
 */

import {
  str,
  big,
  num,
  uint,
  U16,
  bool,
  icon,
  date,
  durationMs,
  readFields,
  MILLISECOND,
} from "./command.js";
import type { FieldSpec } from "./command.js";
import type { ServerGroupID } from "../command/ids.js";
import {
  asChannelID,
  asChannelGroupID,
  asClientDBID,
  asClientID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import type { ClientChanges, ClientEntry } from "./clients.js";

/** A comma-separated list of server group ids; anything that is not one is skipped. */
export function parseServerGroups(raw: string): ServerGroupID[] {
  if (raw === "") return [];
  return raw
    .split(",")
    .flatMap((id) =>
      /^\d{1,20}$/.test(id) && BigInt(id) < 1n << 64n ? [asServerGroupID(BigInt(id))] : [],
    );
}

const text = (key: string): FieldSpec<string> => ({ keys: [key], read: str });
const flag = (key: string): FieldSpec<boolean> => ({ keys: [key], read: bool });

/**
 * The wire key of every client field but `id`, and how each is read: the one
 * table `parseClient` and `parseClientChanges` share, so a row, a listing and
 * a change cannot disagree about a name. `always` marks the fields every
 * source carries, which read as a default from a row without them; every
 * other field is left out when the row lacks it.
 */
export const clientFields: {
  readonly [K in Exclude<keyof ClientEntry, "id">]-?: FieldSpec<ClientEntry[K]>;
} = {
  nickname: { keys: ["client_nickname"], read: str, always: true },
  // A listing names the channel `cid`, an enter notification `ctid`.
  channelID: { keys: ["cid", "ctid"], read: (r, k) => asChannelID(big(r, k)), always: true },
  type: { keys: ["client_type"], read: num, always: true },
  uid: { keys: ["client_unique_identifier"], read: (r, k) => asUID(str(r, k)) },
  serverGroups: {
    keys: ["client_servergroups"],
    read: (r, k) => parseServerGroups(r[k] ?? ""),
  },
  isAway: flag("client_away"),
  isRecording: flag("client_is_recording"),
  isTalker: flag("client_is_talker"),
  channelGroupID: {
    keys: ["client_channel_group_id"],
    read: (r, k) => asChannelGroupID(big(r, k)),
  },
  createdAt: { keys: ["client_created"], read: date },
  lastConnectedAt: { keys: ["client_lastconnected"], read: date },
  idleTimeMs: {
    keys: ["client_idle_time"],
    read: (r, k) => durationMs(r, k, MILLISECOND),
  },
  databaseID: {
    keys: ["client_database_id"],
    read: (r, k) => asClientDBID(big(r, k)),
    always: true,
  },
  awayMessage: text("client_away_message"),
  isInputMuted: flag("client_input_muted"),
  isOutputMuted: flag("client_output_muted"),
  isOutputOnlyMuted: flag("client_outputonly_muted"),
  hasInputHardware: flag("client_input_hardware"),
  hasOutputHardware: flag("client_output_hardware"),
  isChannelCommander: flag("client_is_channel_commander"),
  isPrioritySpeaker: flag("client_is_priority_speaker"),
  talkPower: { keys: ["client_talk_power"], read: num },
  // The wire value is when the request was made; any non-zero is a request.
  isRequestingTalk: flag("client_talk_request"),
  talkRequestedAt: { keys: ["client_talk_request"], read: date },
  talkRequestMessage: text("client_talk_request_msg"),
  description: text("client_description"),
  metaData: text("client_meta_data"),
  avatar: text("client_flag_avatar"),
  iconID: { keys: ["client_icon_id"], read: icon },
  nicknamePhonetic: text("client_nickname_phonetic"),
  unreadMessages: { keys: ["client_unread_messages"], read: num },
  neededServerQueryViewPower: { keys: ["client_needed_serverquery_view_power"], read: num },
  channelGroupInheritedChannelID: {
    keys: ["client_channel_group_inherited_channel_id"],
    read: (r, k) => asChannelID(big(r, k)),
  },
  country: text("client_country"),
  version: text("client_version"),
  platform: text("client_platform"),
  ip: text("connection_client_ip"),
  badges: text("client_badges"),
  signedBadges: text("client_signed_badges"),
  myTeamSpeakID: text("client_myteamspeak_id"),
  myTeamSpeakAvatar: text("client_myteamspeak_avatar"),
  integrations: text("client_integrations"),
  userTag: text("client_user_tag"),
  isStreaming: flag("client_is_streaming"),
};

/**
 * Read a client from a `clientlist` row, or from a `notifycliententerview`,
 * which names its channel `ctid` where the list says `cid`. Reached by the
 * client module through `./internal`.
 *
 * The fields every source carries read as a default from a row without
 * them; the others are `undefined` instead.
 */
export function parseClient(row: Record<string, string>): ClientEntry {
  return {
    id: asClientID(uint(row, "clid", U16)),
    ...readFields(clientFields, row, false),
  } as unknown as ClientEntry;
}

/**
 * Read the properties a `notifyclientupdated` row named, and only those: the
 * result holds exactly the keys the row carried, and one the row cleared (an
 * icon of 0) holds `undefined`. The client's id is not among them; the row's `clid` is.
 */
export function parseClientChanges(row: Record<string, string>): ClientChanges {
  return readFields(clientFields, row, true);
}
