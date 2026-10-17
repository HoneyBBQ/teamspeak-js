/**
 * Typed command layer.
 *
 * Every command both the voice protocol and ServerQuery accept is one function
 * here, running on any CommandExecutor. Functions that only send a command
 * return `Promise<void>`; functions that read return a parsed type. Every one
 * takes a last, optional {@link CommandOptions} — a signal to abandon it and a
 * timeoutMs — which is passed to the executor as it is.
 *
 * Nothing here re-encodes ids or field names by hand at the call site: the
 * branded id types, the field tables below and the request encoder
 * turn parameters into wire form in one place.
 */

import { ErrorCode } from "../errorcode.js";
import { NoDataError, ServerError } from "../errors.js";
import type { CommandExecutor, CommandOptions, ParamValue } from "../command/request.js";
import { asChannelID, asChannelUID, asPermissionID, parseIconID } from "../command/ids.js";
import type { ChannelID, ChannelUID, IconID } from "../command/ids.js";
import { permissionByID, permissionByName } from "../permission.js";
import type { Permission } from "../permission.js";

/** Parameters in the order they are sent. */
export type Params = ReadonlyArray<readonly [string, ParamValue]>;

// ---- Sending ----------------------------------------------------------------

/**
 * Send a command that produces no data and wait for the server's answer.
 *
 * `passwords` names the parameters that carry a channel password. Naming them
 * here, rather than encoding them, leaves the encoding to the transport — the
 * voice protocol hashes them, ServerQuery does not — and keeps every call site
 * from having to remember, which is how a raw password once reached the server
 * and failed 781.
 */
async function exec(
  client: CommandExecutor,
  command: string,
  params: Params = [],
  options?: CommandOptions,
  passwords: readonly string[] = [],
): Promise<void> {
  await client.send({ command, params, passwords }, commandOptions(options));
}

/**
 * The signal and timeoutMs of a command's options, alone: a command's own
 * options extend CommandOptions, and the executor, and any middleware on it,
 * should see only what is theirs.
 */
function commandOptions(options: CommandOptions | undefined): CommandOptions | undefined {
  if (options === undefined) return undefined;
  return { signal: options.signal, timeoutMs: options.timeoutMs };
}

/** Send a command and return its response rows. */
async function query(
  client: CommandExecutor,
  command: string,
  params: Params = [],
  options?: CommandOptions,
  passwords: readonly string[] = [],
): Promise<Array<Record<string, string>>> {
  return client.send({ command, params, passwords }, commandOptions(options));
}

/** Whether an error is the server's "database empty result set" (1281). */
const isEmptyResult = (err: unknown): boolean =>
  err instanceof ServerError && err.code === ErrorCode.DatabaseEmptyResult;

/**
 * Send a command that lists or finds something and return its rows.
 *
 * The server reports an empty list as error 1281, "database empty result set",
 * rather than as no rows — `banlist` on a server with no bans, `messagelist`
 * with no messages — which made every list function throw where it should
 * have answered `[]`. A search may report finding nothing with an error of its
 * own, `how.noMatch`: `clientfind` answers 512 and `channelfind` 768, which for a
 * command naming no client or channel can mean nothing else. `how.passwords`
 * is as for {@link exec}.
 */
async function list(
  client: CommandExecutor,
  command: string,
  params: Params = [],
  options?: CommandOptions,
  how: { readonly noMatch?: number; readonly passwords?: readonly string[] } = {},
): Promise<Array<Record<string, string>>> {
  const { noMatch, passwords } = how;
  try {
    return await query(client, command, params, options, passwords);
  } catch (err) {
    if (isEmptyResult(err)) return [];
    if (noMatch !== undefined && err instanceof ServerError && err.code === noMatch) return [];
    throw err;
  }
}

/** Default page size for a paged walk. */
const DEFAULT_PAGE_SIZE = 100;

/** How a paged command is walked, as by {@link iterateClientDatabase}. */
export interface PagingOptions extends CommandOptions {
  /**
   * How many rows to ask for per page; 100 by default. The server may cap a
   * page below this, which the walk allows for.
   */
  readonly pageSize?: number | undefined;
}

/**
 * Walk a command the server pages with `start` and `duration`, a page at a
 * time, as the caller asks for more.
 *
 * The walk ends when the server answers a `start` past the last row with error
 * 1281, "database empty result set", on an empty page, or on a page shorter
 * than an earlier one. A short *first* page does not end it: the server may cap
 * a page below what was asked, so the walk asks once more to find out. It also
 * ends when a page starts at or before the last row already seen
 * (`advanced` says), which is a server ignoring `start` — without that check
 * such a server would be asked for its first page forever.
 *
 * Any other error is thrown from the iteration. Rows added or removed during
 * the walk can be skipped or seen twice, since each page is a separate query.
 *
 * `options` reaches every page's command.
 */
async function* pages<T>(
  client: CommandExecutor,
  command: string,
  parse: (row: Record<string, string>) => T,
  advanced: (previous: T, next: T) => boolean,
  options: PagingOptions = {},
): AsyncGenerator<T, void, undefined> {
  const { pageSize = DEFAULT_PAGE_SIZE, ...rest } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`a page size is a positive integer, not ${pageSize}`);
  }

  let start = 0;
  let fullPage = 0;
  let last: T | undefined;
  for (;;) {
    let rows: Array<Record<string, string>>;
    try {
      rows = await query(
        client,
        command,
        [
          ["start", start],
          ["duration", pageSize],
        ],
        rest,
      );
    } catch (err) {
      if (isEmptyResult(err)) return;
      throw err;
    }
    if (rows.length === 0) return;

    const parsed = rows.map(parse);
    if (last !== undefined && !advanced(last, parsed[0] as T)) return;
    for (const item of parsed) yield item;
    last = parsed[parsed.length - 1];

    if (rows.length < fullPage) return;
    fullPage = Math.max(fullPage, rows.length);
    start += rows.length;
  }
}

/**
 * The row a command is defined to answer with, which must hold `key` when one
 * is named. A server that acknowledged the command without it has not
 * answered, which is a NoDataError rather than a row of empty fields.
 */
function firstRow(
  rows: ReadonlyArray<Record<string, string>>,
  command: string,
  key?: string,
): Record<string, string> {
  const row = rows[0];
  if (row === undefined || (key !== undefined && (row[key] ?? "") === "")) {
    throw new NoDataError(command);
  }
  return row;
}

export { exec, query, list, pages, commandOptions, firstRow };
export type { ParamValue };

// ---- Field tables -----------------------------------------------------------

/**
 * How one option field goes on the wire: its parameter name, or its name and a
 * function from the field's value to the parameter's. An encoder may return
 * undefined to omit the parameter.
 */
export type WireField<V> = string | readonly [name: string, encode: (value: V) => ParamValue];

/**
 * A wire name for every field of an options type.
 *
 * Every key is required, so a field added to the options interface without a
 * wire name is a compile error rather than a field silently never sent; the
 * signal and timeoutMs every command's options carry are not parameters. A
 * field whose type is not already a parameter value — a duration in
 * milliseconds sent in seconds, say — must have an encoder.
 */
export type WireNames<T> = {
  readonly [K in Exclude<keyof T, keyof CommandOptions>]-?: Exclude<
    T[K],
    undefined
  > extends ParamValue
    ? WireField<Exclude<T[K], undefined>>
    : readonly [name: string, encode: (value: Exclude<T[K], undefined>) => ParamValue];
};

/**
 * Encode an options object through its field table.
 *
 * The table, not the object, decides what is sent: a key missing from the
 * table — a typo, or anything else a JavaScript caller put there — is ignored
 * rather than forwarded onto the wire. An unset field (undefined, or null from
 * JavaScript) is omitted; any other value is sent, so `""` is sent as an empty
 * parameter, which is how a setting such as a channel password is cleared.
 */
export function encodeFields<T extends object>(fields: T, names: WireNames<T>): Params {
  const out: Array<readonly [string, ParamValue]> = [];
  for (const key of Object.keys(names) as Array<keyof T & string>) {
    const value = fields[key] as unknown;
    if (value === undefined || value === null) continue;
    const field = (names as Record<string, WireField<unknown>>)[key]!;
    if (typeof field === "string") out.push([field, value as ParamValue]);
    else out.push([field[0], field[1](value)]);
  }
  return out;
}

/** Raw wire properties, sent as given; a value that is not a string is left out. */
export const rawProperties = (settings: Readonly<Record<string, string>>): Params =>
  Object.entries(settings).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

/** An encoder that omits an empty string instead of sending it. */
export const nonEmpty = (value: string): string | undefined => (value === "" ? undefined : value);

/**
 * An encoder that omits an id of 0 instead of sending it: where a command
 * takes an id as a filter or a target, 0 names no channel, client or group,
 * so it can only mean "any" or "none".
 */
export const nonZero = (value: bigint): bigint | undefined => (value === 0n ? undefined : value);

// ---- Units ------------------------------------------------------------------

/** One second, in milliseconds: the unit most durations travel in. */
export const SECOND = 1000;

/** One millisecond: the unit `client_idle_time` and its like travel in. */
export const MILLISECOND = 1;

/**
 * A duration in milliseconds, as the count of `unitMs` the wire carries.
 *
 * Rounds to the nearest unit, except that a positive duration never becomes 0:
 * several fields read 0 as "forever" (a ban) or "never" (a temporary
 * password), so half a second sent as 0 seconds would turn a short ban into a
 * permanent one. A negative or non-finite duration is refused.
 */
export function toWireDuration(ms: number, unitMs: number): number {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`a duration is a non-negative number of milliseconds, not ${ms}`);
  }
  const units = Math.round(ms / unitMs);
  return units === 0 && ms > 0 ? 1 : units;
}

/** An encoder for a millisecond field the wire carries in seconds. */
export const inSeconds = (ms: number): number => toWireDuration(ms, SECOND);

// ---- Reading rows -----------------------------------------------------------

/**
 * Read a string field, tolerating absence.
 *
 * The parser has already unescaped it; unescaping again would turn a nickname
 * that really contains `\s` into one with a space.
 */
const str = (row: Record<string, string>, key: string): string => row[key] ?? "";

/**
 * Read an unsigned 64-bit field, tolerating absence. Garbage, and a value
 * outside 0 to 2^64-1, read as 0: every field read this way is an id or a
 * size, and reading one must not throw where the id constructors would.
 */
const big = (row: Record<string, string>, key: string): bigint => {
  const raw = row[key];
  if (raw === undefined || !/^\d+$/.test(raw)) return 0n;
  const value = BigInt(raw);
  return value > MAX_UINT64 ? 0n : value;
};

const MAX_UINT64 = (1n << 64n) - 1n;

/**
 * Read an id no wider than `max`: an integer from 0 to `max`, or 0 for
 * anything else, so the id constructors never see a value they refuse.
 */
const uint = (row: Record<string, string>, key: string, max: number): number => {
  const value = num(row, key);
  return Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
};

/** The widths {@link uint} reads ids at. */
const U16 = 0xffff;
const U32 = 0xffff_ffff;

/** Read a number field, tolerating absence. Fractions are kept. */
const num = (row: Record<string, string>, key: string): number => {
  const raw = row[key];
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Read a number field that may be absent: undefined when the key is missing, else as {@link num}. */
const optNum = (row: Record<string, string>, key: string): number | undefined =>
  row[key] === undefined ? undefined : num(row, key);

/** Read a boolean field: the protocol writes 0/1. */
const bool = (row: Record<string, string>, key: string): boolean => num(row, key) !== 0;

/** Read an icon id, signed or unsigned, as its unsigned value; 0 is no icon. */
const icon = (row: Record<string, string>, key: string): IconID | undefined =>
  parseIconID(row[key]);

// Timestamps at or above these are not seconds. TS6 sends some in finer units —
// ftgetfilelist's datetime in milliseconds, ftgetfileinfo's in nanoseconds, for
// the same file — while TS3 sends seconds throughout. 1e11 seconds is the year
// 5138, and 1e11 milliseconds early 1973, so the magnitude settles the unit for
// any date this protocol will carry.
const MAX_UNIX_SECONDS = 10n ** 11n;
const MAX_UNIX_MILLIS = 10n ** 14n;
const MAX_UNIX_MICROS = 10n ** 17n;

/**
 * Read a unix timestamp as a Date.
 *
 * 0, absence and garbage are `undefined`, not 1970: the server sends 0 for
 * "never" (a client that never connected, a key never used).
 */
const date = (row: Record<string, string>, key: string): Date | undefined => {
  const raw = row[key];
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  const value = BigInt(raw);
  if (value <= 0n) return undefined;
  if (value < MAX_UNIX_SECONDS) return new Date(Number(value) * 1000);
  if (value < MAX_UNIX_MILLIS) return new Date(Number(value));
  if (value < MAX_UNIX_MICROS) return new Date(Number(value / 1000n));
  return new Date(Number(value / 1_000_000n));
};

/** Read a duration sent as a count of `unitMs`, in milliseconds. */
const durationMs = (row: Record<string, string>, key: string, unitMs: number): number =>
  num(row, key) * unitMs;

export { str, big, num, uint, U16, U32, bool, icon, date, durationMs };

// ---- Read tables ------------------------------------------------------------

/**
 * How one record field is read from a row: the wire keys that carry it, in
 * the order they are tried, and how to read the one that is there. An `always`
 * field is read even from a row without it, as the default `read` gives; the
 * others are left out, so a field is `undefined` when the row lacked it.
 */
export interface FieldSpec<T> {
  /** The wire keys that name the field; the first one the row has is read. */
  readonly keys: readonly [string, ...string[]];
  /** Reads the field from the row, given the key that was found (or the first, for an absent `always` field). */
  readonly read: (row: Record<string, string>, key: string) => T;
  /** Whether a full record reads the field from a row that lacks it. */
  readonly always?: true;
}

/**
 * Read the fields of `table` from a row into a new object.
 *
 * With `onlyPresent`, a field is read only when the row carries one of its
 * keys, and a value that reads as `undefined` is left out: what comes back
 * holds exactly the keys the row named, which is what a change needs, since
 * an explicit `undefined` would erase a field when merged. Without it, the
 * `always` fields are read whether or not the row has them, as a full record
 * does.
 */
export function readFields(
  table: Readonly<Record<string, FieldSpec<unknown>>>,
  row: Record<string, string>,
  onlyPresent: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(table)) {
    const key = spec.keys.find((k) => row[k] !== undefined);
    const full = spec.always === true && !onlyPresent;
    if (key === undefined) {
      if (full) out[name] = spec.read(row, spec.keys[0]);
      continue;
    }
    const value = spec.read(row, key);
    if (value !== undefined || full) out[name] = value;
  }
  return out;
}

// ---- Shared shapes ----------------------------------------------------------

/**
 * The id of the group a create or copy just made.
 *
 * ServerQuery answers `servergroupadd` with the new id alone. The voice
 * protocol answers with the whole group list instead (`notifyservergrouplist`),
 * so taking the first row returned the first group on the server rather than
 * the new one. The new group is the one with the requested name — the newest,
 * should the name repeat across group types.
 *
 * The difference is a property of the answers, not a choice:
 * `notifychannelcreated` names the client that invoked it, so `channelcreate`
 * keeps only its own row, while the group commands answer with the whole list
 * and name no invoker — `notifyservergrouplist` for `servergroupadd` and
 * `servergroupcopy`, `notifychannelgrouplist` for `channelgroupadd` and
 * `channelgroupcopy` — leaving nothing but the name to match on. A group of
 * the same name created concurrently by another party is therefore
 * indistinguishable from ours, channel groups as much as server groups, and
 * the id returned may be theirs rather than the one we just made. That is a
 * limit of what the notification reports, not of this function.
 *
 * TeamSpeak 6's WebQuery occasionally answers a create that succeeded with no
 * row at all. That case is not handled here: see {@link recoveredGroupID},
 * which the four group-creating functions use, and which looks the group up by
 * name and type.
 */
export function createdGroupID(
  rows: ReadonlyArray<Record<string, string>>,
  idKey: "sgid" | "cgid",
  name: string,
  command: string,
): bigint {
  const listed = rows.filter((row) => row["name"] !== undefined);
  if (listed.length === 0) return big(firstRow(rows, command, idKey), idKey);

  let id = 0n;
  for (const row of listed) {
    if (row["name"] === name && big(row, idKey) > id) id = big(row, idKey);
  }
  if (id === 0n) {
    throw new NoDataError(command, `the server did not report the new group "${name}"`);
  }
  return id;
}

/**
 * The id of the group a create or copy just made, as {@link createdGroupID}
 * finds it, or, when the answer carries no group row and no id, by listing the
 * groups and taking the one with the requested name and type.
 *
 * TeamSpeak 6's WebQuery occasionally answers a successful create with no data.
 * A server refuses a duplicate name within one type, so a group matching both
 * is the one just created. A NoDataError is thrown only when none matches.
 */
export async function recoveredGroupID(
  rows: ReadonlyArray<Record<string, string>>,
  idKey: "sgid" | "cgid",
  name: string,
  type: number,
  command: string,
  listGroups: () => Promise<ReadonlyArray<{ id: bigint; name: string; type: number }>>,
): Promise<bigint> {
  if (rows.some((row) => row["name"] !== undefined || (row[idKey] ?? "") !== "")) {
    return createdGroupID(rows, idKey, name, command);
  }
  const found = (await listGroups()).find((g) => g.name === name && g.type === type);
  if (found === undefined) {
    throw new NoDataError(command, `the server did not report the new group "${name}"`);
  }
  return found.id;
}

/**
 * Encode a permission as `permid` or `permsid`, whichever names it.
 *
 * A JavaScript caller can pass an object naming neither, and a command sent
 * with neither parameter fails on the server with a less helpful error, if it
 * fails at all — so that is refused here.
 */
export function permissionParam(permission: Permission): readonly [string, ParamValue] {
  const value = permission as { readonly id?: unknown; readonly name?: unknown };
  if (typeof value.name === "string" && value.name !== "") return ["permsid", value.name];
  // No permission has id 0: a Permission naming it names none.
  if (typeof value.id === "number" && Number.isInteger(value.id) && value.id > 0) {
    return ["permid", value.id];
  }
  throw new TypeError("a permission is permissionByID(id), id above 0, or permissionByName(name)");
}

/** A channel as returned by `channellist` or `channelinfo`. */
export interface Channel {
  /** The channel's id. */
  readonly id: ChannelID;
  /**
   * The channel this one sits under, or 0 at the top level.
   *
   * `channellist` names this `cpid` and `channelinfo` names it `pid` — the same
   * value under two keys, which is why both are read here.
   */
  readonly parentID: ChannelID;
  /** The channel's name. */
  readonly name: string;
  /** The topic shown under the name (`channel_topic`). */
  readonly topic: string;
  /**
   * The description (`channel_description`). `channellist` does not carry it,
   * so `listChannels` leaves it empty; `getChannelInfo` or the voice client's
   * `getChannelDescription` has it.
   */
  readonly description: string;
  /**
   * The channel this one is sorted after among its siblings, or 0 for the
   * first: `channel_order` is a channel id, not a position.
   */
  readonly order: ChannelID;
  /** Whether joining needs a password. */
  readonly hasPassword: boolean;
  /** Whether new clients land here. */
  readonly isDefault: boolean;
  /** Whether the channel survives a server restart (`channel_flag_permanent`). */
  readonly isPermanent: boolean;
  /**
   * Whether the channel is kept until the last client leaves it, but not
   * across a restart (`channel_flag_semi_permanent`).
   */
  readonly isSemiPermanent: boolean;
  /** The voice codec, one of {@link Codec}. */
  readonly codec: number;
  /** The codec's quality, 0 to 10. */
  readonly codecQuality: number;
  /** How many clients may be in the channel (`channel_maxclients`); -1 for no limit. */
  readonly maxClients: number;
  /**
   * How many clients may be in the channel and its subchannels together
   * (`channel_maxfamilyclients`); -1 for no limit.
   */
  readonly maxFamilyClients: number;
  /**
   * How many clients are in the channel now (`total_clients`).
   * `listChannels` reports it; `getChannelInfo` leaves it undefined, because
   * `channelinfo` does not carry it.
   */
  readonly totalClients: number | undefined;
  /**
   * How many clients are in the channel and its subchannels now
   * (`total_clients_family`). `listChannels` reports it; `getChannelInfo`
   * leaves it undefined, because `channelinfo` does not carry it.
   */
  readonly totalFamilyClients: number | undefined;
  /**
   * The subscribe power a client needs to subscribe to the channel
   * (`channel_needed_subscribe_power`). `listChannels` reports it;
   * `getChannelInfo` leaves it undefined, because `channelinfo` does not
   * carry it.
   */
  readonly neededSubscribePower: number | undefined;
  /** The talk power a client needs to speak here. */
  readonly neededTalkPower: number;
  /** The channel's icon, or undefined for none. */
  readonly iconID: IconID | undefined;
  /**
   * The unique identifier the server gives the channel
   * (`channel_unique_identifier`): TS6 sends one, TS3 none, which reads as "".
   * `channellist` does not carry it, so `listChannels` leaves it empty.
   */
  readonly uid: ChannelUID;

  // Everything below is `undefined` when the row did not carry its key, never
  // a default. `channellist` carries none of it, so `listChannels` leaves it
  // undefined; `getChannelInfo` fills it in, and a created or edited
  // notification names the ones that changed.

  /** How many packets of voice are sent at once, 1 to 10 (`channel_codec_latency_factor`). */
  readonly codecLatencyFactor?: number | undefined;
  /** Whether voice in the channel travels unencrypted (`channel_codec_is_unencrypted`). */
  readonly isUnencrypted?: boolean | undefined;
  /** Whether `maxClients` is ignored (`channel_flag_maxclients_unlimited`). */
  readonly isMaxClientsUnlimited?: boolean | undefined;
  /** Whether `maxFamilyClients` is ignored (`channel_flag_maxfamilyclients_unlimited`). */
  readonly isMaxFamilyClientsUnlimited?: boolean | undefined;
  /** Whether the family limit is taken from the parent (`channel_flag_maxfamilyclients_inherited`). */
  readonly isMaxFamilyClientsInherited?: boolean | undefined;
  /**
   * How long a temporary channel survives its last client leaving, in
   * milliseconds (`channel_delete_delay`, which the wire carries in seconds).
   */
  readonly deleteDelayMs?: number | undefined;
  /** How the name is pronounced, for text-to-speech (`channel_name_phonetic`). */
  readonly namePhonetic?: string | undefined;
  /** Whether only clients with talk power may speak (`channel_forced_silence`). */
  readonly isForcedSilence?: boolean | undefined;
  /** The URL of the channel's banner image (`channel_banner_gfx_url`). */
  readonly bannerURL?: string | undefined;
  /** How the banner is scaled (`channel_banner_mode`). */
  readonly bannerMode?: number | undefined;
}

/**
 * A change to a channel: only the properties a notification named, by the
 * names of {@link Channel}. A key is present exactly when the notification
 * carried it, and a property it did not carry is not "unknown" but, for a
 * created channel, the server's default.
 */
export type ChannelChanges = {
  readonly [K in Exclude<keyof Channel, "id">]?: Channel[K];
};

/**
 * The channel with `changes` applied, as a new object; `channel` is not
 * touched. Keys `changes` lacks keep their value, and a key holding
 * `undefined` is skipped, so no property is erased by a change that did not
 * carry it.
 */
export function applyChannelChanges(channel: Channel, changes: ChannelChanges): Channel {
  const next: Record<string, unknown> = { ...channel };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as Channel;
}

/** The wire key of every channel field but `id`, and how each is read; one table for rows and for changes. */
export const channelFields: {
  readonly [K in Exclude<keyof Channel, "id">]-?: FieldSpec<Channel[K]>;
} = {
  parentID: {
    keys: ["pid", "cpid"],
    read: (row) => asChannelID(big(row, "pid") || big(row, "cpid")),
    always: true,
  },
  name: { keys: ["channel_name"], read: str, always: true },
  topic: { keys: ["channel_topic"], read: str, always: true },
  description: { keys: ["channel_description"], read: str, always: true },
  order: { keys: ["channel_order"], read: (row, key) => asChannelID(big(row, key)), always: true },
  hasPassword: { keys: ["channel_flag_password"], read: bool, always: true },
  isDefault: { keys: ["channel_flag_default"], read: bool, always: true },
  isPermanent: { keys: ["channel_flag_permanent"], read: bool, always: true },
  isSemiPermanent: { keys: ["channel_flag_semi_permanent"], read: bool, always: true },
  codec: { keys: ["channel_codec"], read: num, always: true },
  codecQuality: { keys: ["channel_codec_quality"], read: num, always: true },
  maxClients: { keys: ["channel_maxclients"], read: num, always: true },
  maxFamilyClients: { keys: ["channel_maxfamilyclients"], read: num, always: true },
  totalClients: { keys: ["total_clients"], read: optNum, always: true },
  totalFamilyClients: { keys: ["total_clients_family"], read: optNum, always: true },
  neededSubscribePower: { keys: ["channel_needed_subscribe_power"], read: optNum, always: true },
  neededTalkPower: { keys: ["channel_needed_talk_power"], read: num, always: true },
  iconID: { keys: ["channel_icon_id"], read: icon, always: true },
  uid: {
    keys: ["channel_unique_identifier"],
    read: (row, key) => asChannelUID(str(row, key)),
    always: true,
  },
  codecLatencyFactor: { keys: ["channel_codec_latency_factor"], read: num },
  isUnencrypted: { keys: ["channel_codec_is_unencrypted"], read: bool },
  isMaxClientsUnlimited: { keys: ["channel_flag_maxclients_unlimited"], read: bool },
  isMaxFamilyClientsUnlimited: { keys: ["channel_flag_maxfamilyclients_unlimited"], read: bool },
  isMaxFamilyClientsInherited: { keys: ["channel_flag_maxfamilyclients_inherited"], read: bool },
  deleteDelayMs: {
    keys: ["channel_delete_delay"],
    read: (row, key) => durationMs(row, key, SECOND),
  },
  namePhonetic: { keys: ["channel_name_phonetic"], read: str },
  isForcedSilence: { keys: ["channel_forced_silence"], read: bool },
  bannerURL: { keys: ["channel_banner_gfx_url"], read: str },
  bannerMode: { keys: ["channel_banner_mode"], read: num },
};

function parseChannel(row: Record<string, string>): Channel {
  return {
    id: asChannelID(big(row, "cid")),
    ...readFields(channelFields, row, false),
  } as unknown as Channel;
}

/**
 * Read the properties a channel notification named, and only those. The
 * channel's id is not among them: a notification carries it as `cid`, which
 * the event holds as its own field.
 */
function parseChannelChanges(row: Record<string, string>): ChannelChanges {
  return readFields(channelFields, row, true);
}

export { parseChannel, parseChannelChanges };

/** One entry of a permission list. */
export interface PermissionEntry {
  /**
   * The permission the entry sets, named the way the server sent it — by id,
   * unless a row carries the name. It can be passed straight back to the
   * matching delete function.
   */
  readonly permission: Permission;
  /** The permission's value. */
  readonly value: number;
  /** Whether the value is negated, taking the lowest value instead of the highest. */
  readonly negated: boolean;
  /** Whether the permission skips channel and client overrides. */
  readonly skip: boolean;
}

/**
 * Parse one permission row.
 *
 * A permission is addressable by id or by name, and the server answers in
 * whichever form the request used, so a row carries one or the other.
 */
export function parsePermission(row: Record<string, string>): PermissionEntry {
  const name = str(row, "permsid");
  return {
    permission:
      name === ""
        ? permissionByID(asPermissionID(uint(row, "permid", U32)))
        : permissionByName(name),
    value: num(row, "permvalue"),
    negated: bool(row, "permnegated"),
    skip: bool(row, "permskip"),
  };
}
