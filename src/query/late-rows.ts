/** The row a command's answer carries, and whether it carries several. */
export interface LateRows {
  /** The keys the row is known by. */
  readonly keys: readonly string[];
  /**
   * The answer has one row for each of several things it made, and all, some or
   * none of them may follow the `error` line, so it is held until the rows stop.
   */
  readonly several?: boolean;
  /** Any row is the answer: a read, which has no one key. */
  readonly any?: boolean;
}

/**
 * Commands whose answer carries the row that names what they made, and the key
 * that row is known by.
 *
 * TeamSpeak 6 over SSH has been measured (6.0.0-beta13.1) to write that row
 * after the command's `error` line, a fraction of a millisecond later, in a
 * share of the answers. A client that takes the `error` line for the end of the
 * answer loses the row and, worse, hands it to whichever command is sent next.
 * Holding the answer briefly is harmless on a server that writes the row first.
 * See "Server behaviour the SDK works around" in `docs/serverquery-responses.md`.
 */
export const LATE_ROWS: ReadonlyMap<string, LateRows> = new Map<string, LateRows>([
  ["channelcreate", { keys: ["cid"] }],
  ["servergroupadd", { keys: ["sgid"] }],
  ["servergroupcopy", { keys: ["sgid"] }],
  ["channelgroupadd", { keys: ["cgid"] }],
  ["channelgroupcopy", { keys: ["cgid"] }],
  ["banadd", { keys: ["banid"] }],
  ["banclient", { keys: ["banid"], several: true }],
  ["privilegekeyadd", { keys: ["token"] }],
  ["tokenadd", { keys: ["token"] }],
  ["apikeyadd", { keys: ["apikey"] }],
  ["servercreate", { keys: ["sid"] }],
]);

/** How long a successful answer without its row is held open for the row to arrive. */
export const LATE_ROW_GRACE_MS = 250;

/** For an answer with several rows: how long without a new one counts as its end. */
export const LATE_ROW_QUIET_MS = 25;

/**
 * Commands that read something, by their names: a `list`, `info` or `find`, a
 * `get…`, `whoami`, `version`. A plain read has been measured to have its whole
 * answer after the `error` line too, much less often than a create (2 in 3000
 * `clientlist` calls, while clients were connecting), so one that is answered
 * with no row is held briefly as well. An empty success is rare for these: the
 * servers answer an empty list with error 1281.
 */
const READS = /(list|info|find|search)$|^(get\w+|whoami|version|permfind|permoverview|permget)$/;

/** What is known of where a command's answer rows may fall, or `undefined` for none. */
export function lateRowsOf(command: string): LateRows | undefined {
  const known = LATE_ROWS.get(command);
  if (known !== undefined) return known;
  return READS.test(command) ? { keys: [], any: true } : undefined;
}

/** Whether `rows` already hold what {@link lateRowsOf} says to wait for. */
export function hasLateRow(late: LateRows, rows: ReadonlyArray<Record<string, string>>): boolean {
  if (late.any === true) return rows.length > 0;
  return rows.some((row) => late.keys.some((k) => row[k] !== undefined));
}
