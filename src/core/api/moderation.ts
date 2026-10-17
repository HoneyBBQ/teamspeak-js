/**
 * Bans, complaints, offline messages, text messages and the server log.
 *
 * All administrative: expect a permission error, not an empty list, when the
 * client lacks the rights.
 */

import {
  nonZero,
  firstRow,
  exec,
  query,
  list,
  encodeFields,
  nonEmpty,
  toWireDuration,
  str,
  big,
  num,
  bool,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { Params, WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions, ParamValue } from "../command/request.js";
import type { BanID, ClientDBID, ClientID, MessageID, UID } from "../command/ids.js";
import { asBanID, asClientDBID, asMessageID, asUID } from "../command/ids.js";
import { TextMessageTarget } from "../enums.js";
import type { LogLevel } from "../enums.js";

// ---- Bans -------------------------------------------------------------------

/** A ban, as `banlist` reports it. */
export interface BanEntry {
  /** The ban's id. */
  readonly id: BanID;
  /** The address pattern the ban matches, or "". */
  readonly ip: string;
  /** The nickname pattern the ban matches, or "". */
  readonly name: string;
  /** The unique identifier the ban matches, or "". */
  readonly uid: UID;
  /** The myTeamSpeak id the ban matches, or "" (`mytsid`); TS6 only, TS3 sends none. */
  readonly mytsid: string;
  /** The nickname of the last client the ban caught. */
  readonly lastNickname: string;
  /** When the ban was made. */
  readonly createdAt: Date | undefined;
  /**
   * How long the ban lasts from `createdAt`, in milliseconds; 0 is a
   * permanent ban. The server reports it in seconds.
   */
  readonly durationMs: number;
  /** Who made the ban. */
  readonly invokerDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly invokerName: string;
  /** Their unique identifier. */
  readonly invokerUID: UID;
  /** The reason given. */
  readonly reason: string;
  /** How many times the ban has turned a client away. */
  readonly enforcements: number;
}

const parseBan = (row: Record<string, string>): BanEntry => ({
  id: asBanID(big(row, "banid")),
  ip: str(row, "ip"),
  name: str(row, "name"),
  uid: asUID(str(row, "uid")),
  mytsid: str(row, "mytsid"),
  lastNickname: str(row, "lastnickname"),
  createdAt: date(row, "created"),
  durationMs: durationMs(row, "duration", SECOND),
  invokerDatabaseID: asClientDBID(big(row, "invokercldbid")),
  invokerName: str(row, "invokername"),
  invokerUID: asUID(str(row, "invokeruid")),
  reason: str(row, "reason"),
  enforcements: num(row, "enforcements"),
});

/** Which bans {@link listBans} reports. */
export interface BanListOptions extends CommandOptions {
  /** Skip this many bans (`start`). */
  readonly start?: number | undefined;
  /**
   * Report at most this many bans (`duration`). The server caps it at 200;
   * unset reports every ban.
   */
  readonly limit?: number | undefined;
}

const banListNames: WireNames<BanListOptions> = { start: "start", limit: "duration" };

/**
 * Every active ban, or a page of them with `start` and `limit`. A server with
 * none, or a `start` past the last, answers an empty list.
 *
 * `-count`, which adds the total number of bans to the first row, is not sent:
 * the function returns the bans, and the total would be a second result.
 */
export async function listBans(
  client: CommandExecutor,
  options: BanListOptions = {},
): Promise<BanEntry[]> {
  return (await list(client, "banlist", encodeFields(options, banListNames), options)).map(
    parseBan,
  );
}

/**
 * What {@link findBans} looks a ban up by. Set at least one; an empty string is
 * treated as unset, never sent.
 */
export interface BanCriteria {
  /** An address; matches the bans whose address pattern it fits (`ip`). */
  readonly ip?: string | undefined;
  /** A nickname; matches the bans whose nickname pattern it fits (`name`). */
  readonly name?: string | undefined;
  /** A unique identifier (`uid`). */
  readonly uid?: UID | undefined;
  /** A myTeamSpeak id (`mytsid`). */
  readonly mytsid?: string | undefined;
}

const banCriteriaNames: WireNames<BanCriteria> = {
  ip: ["ip", nonEmpty],
  name: ["name", nonEmpty],
  uid: ["uid", nonEmpty],
  mytsid: ["mytsid", nonEmpty],
};

/**
 * The bans that would catch a client with this address, nickname, uid or
 * myTeamSpeak id. None is an empty list.
 *
 * TeamSpeak 6 only, over the voice protocol and SSH: TS3 has no `banfind`, and
 * TS6's WebQuery answers it as an unknown command (1538). Needs
 * `b_client_ban_list`. The server refuses a call with no criteria with error
 * 1542, so that is refused here first.
 */
export async function findBans(
  client: CommandExecutor,
  criteria: BanCriteria,
  options?: CommandOptions,
): Promise<BanEntry[]> {
  if (!criteria.ip && !criteria.name && !criteria.uid && !criteria.mytsid) {
    throw new TypeError("finding a ban needs an ip, a name, a uid or a mytsid");
  }
  return (await list(client, "banfind", encodeFields(criteria, banCriteriaNames), options)).map(
    parseBan,
  );
}

/**
 * A ban's duration on the wire. A permanent ban (0) omits it: the server's
 * default is permanent, which is also what `time=0` means. A positive duration
 * never rounds down to 0, which would make it permanent.
 */
const banTime = (ms: number): ParamValue => (ms === 0 ? undefined : toWireDuration(ms, SECOND));

/**
 * What a ban matches, how long it lasts and why: the ban itself, never a
 * command's options. `ip` and `name` are regular expressions matched against
 * a client's address and nickname.
 *
 * Unset fields are omitted, and an empty string is treated as unset in every
 * field here, never sent: an empty pattern would match every client.
 */
export interface BanFields {
  /** The address pattern to ban (`ip`). */
  readonly ip?: string | undefined;
  /** The nickname pattern to ban (`name`). */
  readonly name?: string | undefined;
  /** The unique identifier to ban (`uid`). */
  readonly uid?: UID | undefined;
  /** The myTeamSpeak id to ban (`mytsid`); TS6 only, and a 44-character base64 value (the server refuses others with 1538).
   *
   * The literal `empty` is accepted and stored as it is, and it bans every
   * client without a myTeamSpeak id: never send it to ban one client. */
  readonly mytsid?: string | undefined;
  /** The nickname to record as the last one the ban caught (`lastnickname`). */
  readonly lastNickname?: string | undefined;
  /** The reason, shown to the banned client (`banreason`). */
  readonly reason?: string | undefined;
  /**
   * How long the ban lasts, in milliseconds (`time`); unset or 0 is permanent.
   * Sent in whole seconds, and a positive duration under a second is sent as
   * one rather than rounded down to forever.
   */
  readonly durationMs?: number | undefined;
}

/**
 * A ban to add: {@link BanFields}, at least one of `ip`, `name`, `uid` or `mytsid` set; a
 * ban matching nothing is refused before anything is sent. It carries no
 * signal or timeoutMs: those are addBan's separate last argument.
 */
export type BanOptions = BanFields;

const banNames: WireNames<BanFields> = {
  ip: ["ip", nonEmpty],
  name: ["name", nonEmpty],
  uid: ["uid", nonEmpty],
  mytsid: ["mytsid", nonEmpty],
  lastNickname: ["lastnickname", nonEmpty],
  reason: ["banreason", nonEmpty],
  durationMs: ["time", banTime],
};

/**
 * How long {@link banClient}'s bans last and why — {@link BanFields}' duration
 * and reason — with the command's signal and timeoutMs, as the last argument.
 */
export interface BanClientOptions
  extends Pick<BanFields, "durationMs" | "reason">, CommandOptions {}

const banClientNames: WireNames<BanClientOptions> = {
  durationMs: ["time", banTime],
  reason: ["banreason", nonEmpty],
};

/**
 * Add a ban and return its id — over ServerQuery. The voice protocol reports
 * no id, so there this resolves to undefined.
 *
 * `ban` is what to ban; the command's `signal` and `timeoutMs` go in `options`,
 * a separate last argument — set among the fields, they are not read.
 */
export async function addBan(
  client: CommandExecutor,
  ban: BanOptions,
  options?: CommandOptions,
): Promise<BanID | undefined> {
  if (!ban.ip && !ban.name && !ban.uid && !ban.mytsid) {
    throw new TypeError("a ban needs an ip, a name, a uid or a mytsid to match");
  }
  const rows = await query(client, "banadd", encodeFields(ban, banNames), options);
  return rows[0]?.["banid"] === undefined ? undefined : asBanID(big(rows[0], "banid"));
}

/**
 * Ban a connected client by clid, and return the id of every ban that made.
 *
 * The server bans the client on several counts at once — its address, its
 * uid, and on TS6 its myTeamSpeak id — and over ServerQuery answers one
 * `banid` row for each; returning the first left the others to be found by
 * hand. The voice protocol reports no ids, so there this resolves to `[]`.
 */
export async function banClient(
  client: CommandExecutor,
  clid: ClientID,
  options: BanClientOptions = {},
): Promise<BanID[]> {
  const rows = await query(
    client,
    "banclient",
    [["clid", clid], ...encodeFields(options, banClientNames)],
    options,
  );
  return rows.flatMap((row) => (str(row, "banid") === "" ? [] : [asBanID(big(row, "banid"))]));
}

/** Remove a ban. */
export async function deleteBan(
  client: CommandExecutor,
  banID: BanID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "bandel", [["banid", banID]], options);
}

/** Remove every ban. */
export async function deleteAllBans(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "bandelall", [], options);
}

// ---- Complaints -------------------------------------------------------------

/** A complaint one client filed against another. */
export interface Complaint {
  /** Who the complaint is about. */
  readonly targetDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly targetName: string;
  /** Who filed it. */
  readonly fromDatabaseID: ClientDBID;
  /** Their nickname. */
  readonly fromName: string;
  /** The complaint. */
  readonly message: string;
  /** When it was filed. */
  readonly createdAt: Date | undefined;
}

const parseComplaint = (row: Record<string, string>): Complaint => ({
  targetDatabaseID: asClientDBID(big(row, "tcldbid")),
  targetName: str(row, "tname"),
  fromDatabaseID: asClientDBID(big(row, "fcldbid")),
  fromName: str(row, "fname"),
  message: str(row, "message"),
  createdAt: date(row, "timestamp"),
});

/** Which complaints {@link listComplaints} reports. */
export interface ComplaintListOptions extends CommandOptions {
  /** Only those against this client; unset for all (`tcldbid`). */
  readonly targetDatabaseID?: ClientDBID | undefined;
}

/** Complaints, optionally only those against one client. */
export async function listComplaints(
  client: CommandExecutor,
  options: ComplaintListOptions = {},
): Promise<Complaint[]> {
  // 0 names no client, so it lists every complaint, as unset does.
  const target = options.targetDatabaseID;
  const params: Params = [["tcldbid", target === undefined ? undefined : nonZero(target)]];
  return (await list(client, "complainlist", params, options)).map(parseComplaint);
}

/** File a complaint against a client. */
export async function addComplaint(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "complainadd",
    [
      ["tcldbid", targetDatabaseID],
      ["message", message],
    ],
    options,
  );
}

/** Withdraw one complaint. */
export async function deleteComplaint(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  fromDatabaseID: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "complaindel",
    [
      ["tcldbid", targetDatabaseID],
      ["fcldbid", fromDatabaseID],
    ],
    options,
  );
}

/** Withdraw every complaint against a client. */
export async function deleteAllComplaints(
  client: CommandExecutor,
  targetDatabaseID: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "complaindelall", [["tcldbid", targetDatabaseID]], options);
}

// ---- Offline messages -------------------------------------------------------

/** A message left for a client while they were away. */
export interface OfflineMessage {
  /** The message's id. */
  readonly id: MessageID;
  /** The sender's unique identifier. */
  readonly uid: UID;
  /** The subject. */
  readonly subject: string;
  /** The message; `messagelist` leaves it out, `getMessage` has it. */
  readonly message: string;
  /** When it was sent. */
  readonly sentAt: Date | undefined;
  /** Whether it has been read. */
  readonly isRead: boolean;
}

const parseMessage = (row: Record<string, string>): OfflineMessage => ({
  id: asMessageID(big(row, "msgid")),
  uid: asUID(str(row, "cluid")),
  subject: str(row, "subject"),
  message: str(row, "message"),
  sentAt: date(row, "timestamp"),
  isRead: bool(row, "flag_read"),
});

/** Offline messages for this client. None is an empty list. */
export async function listMessages(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<OfflineMessage[]> {
  return (await list(client, "messagelist", [], options)).map(parseMessage);
}

/** One offline message, with its text. */
export async function getMessage(
  client: CommandExecutor,
  messageID: MessageID,
  options?: CommandOptions,
): Promise<OfflineMessage> {
  const rows = await query(client, "messageget", [["msgid", messageID]], options);
  return { ...parseMessage(firstRow(rows, "messageget")), id: messageID };
}

/**
 * Leave an offline message for a client by its unique identifier, whether or
 * not it is online. It lands in the recipient's inbox, which `listMessages`
 * reads when connected as that client.
 *
 * Needs `b_client_offline_textmessage_send`, which the server's own command
 * reference does not list: a client without it gets error 2568. The server
 * refuses a uid it has no client record for with error 512 (invalid clientID);
 * it accepts an empty subject or message.
 * Works over the voice protocol and ServerQuery on TS3 and TS6.
 */
export async function sendOfflineMessage(
  client: CommandExecutor,
  uid: UID,
  subject: string,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "messageadd",
    [
      ["cluid", uid],
      ["subject", subject],
      ["message", message],
    ],
    options,
  );
}

/** Delete an offline message. */
export async function deleteMessage(
  client: CommandExecutor,
  messageID: MessageID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "messagedel", [["msgid", messageID]], options);
}

/** The flags of an offline message that can be changed. */
export interface MessageFlags {
  /** Whether the message is marked read (`flag`). */
  readonly read: boolean;
}

/** Mark a message read or unread. */
export async function updateMessageFlag(
  client: CommandExecutor,
  messageID: MessageID,
  flags: MessageFlags,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "messageupdateflag",
    [
      ["msgid", messageID],
      ["flag", flags.read],
    ],
    options,
  );
}

// ---- Text messages ----------------------------------------------------------
//
// Three functions rather than one taking a mode and an id, because the id meant
// a different thing in each mode — a clid, a cid, or nothing — and an untyped
// one let a channel id reach an unrelated client.
//
// Each waits for the server's answer, so a refusal — no permission to message
// that target — is thrown rather than lost.

/** Send a text message to one client. */
export async function sendPrivateMessage(
  client: CommandExecutor,
  clid: ClientID,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Client],
      ["target", clid],
      ["msg", message],
    ],
    options,
  );
}

/**
 * Send a text message to the channel this connection is in.
 *
 * It takes no channel because the server takes none: measured on TS3 and TS6,
 * a channel message naming another channel still arrives in the sender's own.
 * To write to another channel, move there first.
 */
export async function sendChannelMessage(
  client: CommandExecutor,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Channel],
      ["msg", message],
    ],
    options,
  );
}

/** Send a text message to everyone on the virtual server. */
export async function sendServerMessage(
  client: CommandExecutor,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "sendtextmessage",
    [
      ["targetmode", TextMessageTarget.Server],
      ["msg", message],
    ],
    options,
  );
}

// ---- Log --------------------------------------------------------------------

/** One read of the server log. */
export interface LogPage {
  /** The lines read, in the order the server sent them. */
  readonly lines: readonly string[];
  /**
   * The byte offset the read stopped at. Pass it as the next read's
   * `beginPosition` to continue from there.
   */
  readonly lastPosition: number;
  /** The log file's size in bytes. */
  readonly fileSize: number;
}

/**
 * Which part of the log {@link viewLog} reads. Unset fields are omitted, and
 * left to the server.
 *
 * The log is paged by byte offset rather than by row, and nothing says when
 * the walk is done, so there is no iterator as there is for the client
 * database: read a page, then pass its `lastPosition` as the next read's
 * `beginPosition`.
 */
export interface LogViewOptions extends CommandOptions {
  /** How many lines to read, at most 100; unset or 0 leaves it to the server (`lines`). */
  readonly lines?: number | undefined;
  /** Read backwards from `beginPosition`, newest line first; false by default (`reverse`, always sent). */
  readonly reverse?: boolean | undefined;
  /** Read the instance log rather than the virtual server's; false by default (`instance`, always sent). */
  readonly instance?: boolean | undefined;
  /**
   * The byte offset to read from; 0 is the start of the log, and unset leaves
   * where to start to the server (`begin_pos`).
   */
  readonly beginPosition?: number | undefined;
}

const logViewNames: WireNames<LogViewOptions> = {
  lines: ["lines", (lines) => (lines === 0 ? undefined : lines)],
  reverse: "reverse",
  instance: "instance",
  beginPosition: "begin_pos",
};

/** Read a page of the server log. */
export async function viewLog(
  client: CommandExecutor,
  options: LogViewOptions = {},
): Promise<LogPage> {
  const fields: LogViewOptions = {
    ...options,
    reverse: options.reverse ?? false,
    instance: options.instance ?? false,
  };
  const rows = await query(client, "logview", encodeFields(fields, logViewNames), options);
  const first = firstRow(rows, "logview");
  // One line per row, under the key `l`. This used to read only a `log` field
  // from the first row, which the server does not send; it is still read,
  // should a server send the lines that way.
  const lines = rows.flatMap((row) => (row["l"] === undefined ? [] : [row["l"]]));
  const joined = str(first, "log");
  return {
    lines: lines.length === 0 && joined !== "" ? joined.split("\n") : lines,
    lastPosition: num(first, "last_pos"),
    fileSize: num(first, "file_size"),
  };
}

/** Write an entry to the server log. */
export async function addLog(
  client: CommandExecutor,
  level: LogLevel,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(
    client,
    "logadd",
    [
      ["loglevel", level],
      ["logmsg", message],
    ],
    options,
  );
}
