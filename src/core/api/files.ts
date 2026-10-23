/**
 * File transfer commands.
 *
 * These are the control-plane half: they list, move and delete files, and they
 * negotiate an upload or download. The actual bytes travel over a separate TCP
 * connection to the file transfer port, which the voice client's
 * `uploadFileData` and `downloadFileData` handle.
 *
 * Every command here takes a channel password as its `password` option, in
 * cleartext: the voice client sends it as `base64(sha1(password))`, the same
 * encoding `clientmove` uses, and ServerQuery as it is. Unset, it is sent
 * empty, which is right for a channel with no password.
 */

import {
  uint,
  U16,
  firstRow,
  commandOptions,
  exec,
  query,
  list,
  str,
  big,
  num,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type {
  ChannelID,
  ClientFileTransferID,
  ClientID,
  ServerFileTransferID,
} from "../command/ids.js";
import { asClientFileTransferID, asClientID, asServerFileTransferID } from "../command/ids.js";
import type { FileDownloadInfo, FileUploadInfo } from "../types.js";

const asPath = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/** One entry of a directory listing, or one file's details. */
export interface FileEntry {
  /** The file or directory name. */
  readonly name: string;
  /** The size in bytes; 0 for a directory. */
  readonly size: bigint;
  /**
   * When it was last modified. TS3 sends seconds, TS6 milliseconds in a
   * listing and nanoseconds in `getFileInfo`; all are read as the same time.
   */
  readonly modifiedAt: Date | undefined;
  /**
   * Whether this is a directory. The listing sends `type=0` for a directory
   * and `type=1` for a file; `getFileInfo`'s answer carries no type, so there
   * it is always false.
   */
  readonly isDirectory: boolean;
}

/** The channel password a file command needs. */
export interface FileOptions extends CommandOptions {
  /** The channel's password, in cleartext; "" by default (`cpw`). */
  readonly password?: string | undefined;
}

const parseFileEntry = (row: Record<string, string>): FileEntry => ({
  name: str(row, "name"),
  size: big(row, "size"),
  modifiedAt: date(row, "datetime"),
  isDirectory: row["type"] === "0",
});

/** Directory listing for one path in a channel's file area. */
export async function listFiles(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  options: FileOptions = {},
): Promise<FileEntry[]> {
  const rows = await list(
    client,
    "ftgetfilelist",
    [
      ["cid", cid],
      ["path", asPath(path)],
      ["cpw", options.password ?? ""],
    ],
    options,
    { passwords: ["cpw"] },
  );
  return rows.map(parseFileEntry);
}

/** One entry of a recursive listing: what {@link listFiles} reports, with where it is. */
export interface FileTreeEntry extends FileEntry {
  /**
   * The entry's full path in the channel's file area, from its root: `/a/b.txt`
   * for the file `b.txt` in the directory `a`. A directory's path has no
   * trailing slash.
   */
  readonly path: string;
}

/** How {@link listFilesRecursive} walks the file area. */
export interface FileTreeOptions extends FileOptions {
  /**
   * How many directory levels to list, counted as `find -maxdepth` counts: 1
   * lists the starting directory only, as {@link listFiles} does; 2 also lists
   * the directories in it; and so on. 16 by default; there is no unbounded
   * walk, since every level is a round trip. A positive integer.
   */
  readonly maxDepth?: number | undefined;
}

/** A path without the slashes at its end; "/" becomes "". */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/** How far {@link listFilesRecursive} goes down unless told otherwise. */
const DEFAULT_MAX_DEPTH = 16;

/**
 * Every file and directory under a path in a channel's file area, in one list:
 * the entries of the directory in the order {@link listFiles} gives them, each
 * directory followed by what it holds.
 *
 * It lists one directory at a time, one command each, so a large tree costs
 * that many round trips. `maxDepth` bounds how far it goes down; a directory
 * at the bound is listed, but not entered. The options (password, signal,
 * timeoutMs) reach every command, and the first error ends the walk. An empty
 * directory has no entries, and a path that is not a directory fails as
 * {@link listFiles} does: TS3 3.13.8 answers 2052 and TS6 beta13.1 2051 for a
 * path that does not exist.
 *
 * File commands are not served over WebQuery (error 5120).
 */
export async function listFilesRecursive(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  options: FileTreeOptions = {},
): Promise<FileTreeEntry[]> {
  const { maxDepth = DEFAULT_MAX_DEPTH, ...listOptions } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new RangeError(`maxDepth is a positive integer, not ${String(maxDepth)}`);
  }
  const found: FileTreeEntry[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    for (const entry of await listFiles(client, cid, directory, listOptions)) {
      const entryPath = `${withoutTrailingSlashes(directory)}/${entry.name}`;
      found.push({ ...entry, path: entryPath });
      if (entry.isDirectory && depth < maxDepth) await walk(entryPath, depth + 1);
    }
  };
  await walk(asPath(path), 1);
  return found;
}

/** Size and timestamp of one file. */
export async function getFileInfo(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  options: FileOptions = {},
): Promise<FileEntry> {
  const rows = await query(
    client,
    "ftgetfileinfo",
    [
      ["cid", cid],
      ["name", asPath(path)],
      ["cpw", options.password ?? ""],
    ],
    options,
    ["cpw"],
  );
  return parseFileEntry(firstRow(rows, "ftgetfileinfo"));
}

/**
 * Delete one or more files, in one command: each name is a row of it
 * (`name=/a|name=/b`).
 */
export async function deleteFile(
  client: CommandExecutor,
  cid: ChannelID,
  paths: string | readonly string[],
  options: FileOptions = {},
): Promise<void> {
  const names = (typeof paths === "string" ? [paths] : paths).map(asPath);
  if (names.length === 0) return;

  await client.send(
    {
      command: "ftdeletefile",
      params: [
        ["cid", cid],
        ["cpw", options.password ?? ""],
      ],
      rows: names.map((name) => [["name", name]]),
      passwords: ["cpw"],
    },
    commandOptions(options),
  );
}

/**
 * Create a directory. Its parent has to exist: measured on TS3 3.13.8 and TS6
 * beta13.1, a path whose parent is missing is refused with 2052 (file
 * input/output error), so nested directories are made one level at a time.
 */
export async function createDirectory(
  client: CommandExecutor,
  cid: ChannelID,
  dirname: string,
  options: FileOptions = {},
): Promise<void> {
  await exec(
    client,
    "ftcreatedir",
    [
      ["cid", cid],
      ["dirname", asPath(dirname)],
      ["cpw", options.password ?? ""],
    ],
    options,
    ["cpw"],
  );
}

/** Where {@link renameFile} moves a file, and the passwords it needs. */
export interface FileRenameOptions extends CommandOptions {
  /** The source channel's password, in cleartext; "" by default (`cpw`, always sent). */
  readonly password?: string | undefined;
  /**
   * Move the file into this channel's file area; unset or 0 keeps it in the
   * same channel, and omits `tcid` and `tcpw` both (`tcid`).
   */
  readonly targetChannelID?: ChannelID | undefined;
  /**
   * The target channel's password, in cleartext; "" by default. Sent, as
   * `tcpw`, only with a `targetChannelID`.
   */
  readonly targetChannelPassword?: string | undefined;
}

/**
 * Rename or move a file, optionally into another channel.
 *
 * `cpw` is always sent, as for every file command; `tcid` and `tcpw` go
 * together, and only when the file moves to another channel.
 */
export async function renameFile(
  client: CommandExecutor,
  cid: ChannelID,
  oldName: string,
  newName: string,
  options: FileRenameOptions = {},
): Promise<void> {
  await exec(
    client,
    "ftrenamefile",
    [
      ["cid", cid],
      ["oldname", asPath(oldName)],
      ["newname", asPath(newName)],
      ["cpw", options.password ?? ""],
      ...(options.targetChannelID === undefined || options.targetChannelID === 0n
        ? []
        : ([
            ["tcid", options.targetChannelID],
            ["tcpw", options.targetChannelPassword ?? ""],
          ] as const)),
    ],
    options,
    ["cpw", "tcpw"],
  );
}

/** How {@link stopFileTransfer} cancels. */
export interface FileTransferStopOptions extends CommandOptions {
  /**
   * Remove the partial file as well, which is usually what you want after a
   * failed upload; false by default (`delete`, always sent).
   */
  readonly removePartialFile?: boolean | undefined;
}

/**
 * Cancel a running transfer.
 *
 * Stop only your own transfers: TeamSpeak 6 6.0.0-beta13.1 crashes on a
 * ServerQuery `ftstop` for a transfer that is not the connection's own (one
 * that does not exist, or another client's), and nothing here guards against
 * it. See "Server behaviour the SDK works around" in `docs/serverquery-responses.md`.
 */
export async function stopFileTransfer(
  client: CommandExecutor,
  serverFileTransferID: ServerFileTransferID,
  options: FileTransferStopOptions = {},
): Promise<void> {
  await exec(
    client,
    "ftstop",
    [
      ["serverftfid", serverFileTransferID],
      ["delete", options.removePartialFile ?? false],
    ],
    options,
  );
}

/** A running transfer, as `ftlist` reports it. */
export interface ActiveTransfer {
  /** The client transferring. */
  readonly clientID: ClientID;
  /** The directory in the channel's file area. */
  readonly path: string;
  /** The file name. */
  readonly name: string;
  /** The file's size in bytes. */
  readonly size: bigint;
  /** How many bytes have been transferred. */
  readonly sizeDone: bigint;
  /** The client's id for the transfer. */
  readonly clientFileTransferID: ClientFileTransferID;
  /** The server's id for the transfer, which {@link stopFileTransfer} takes. */
  readonly serverFileTransferID: ServerFileTransferID;
  /** Which side sends the data, as the server reports it (`sender`). */
  readonly sender: string;
  /**
   * The transfer's state, as the server reports it. A plain number: no table
   * of its values is known.
   */
  readonly status: number;
  /** The current speed, in bytes per second. */
  readonly currentSpeed: number;
  /** The average speed, in bytes per second. */
  readonly averageSpeed: number;
  /** How long the transfer has been running, in milliseconds. The server reports seconds. */
  readonly runtimeMs: number;
}

/**
 * File transfers in progress. Requires the file-transfer-info permission. None
 * is an empty list.
 */
export async function listActiveTransfers(
  client: CommandExecutor,
  options?: CommandOptions,
): Promise<ActiveTransfer[]> {
  const rows = await list(client, "ftlist", [], options);
  return rows.map((row) => ({
    clientID: asClientID(uint(row, "clid", U16)),
    path: str(row, "path"),
    name: str(row, "name"),
    size: big(row, "size"),
    sizeDone: big(row, "sizedone"),
    clientFileTransferID: asClientFileTransferID(uint(row, "clientftfid", U16)),
    serverFileTransferID: asServerFileTransferID(uint(row, "serverftfid", U16)),
    sender: str(row, "sender"),
    status: num(row, "status"),
    currentSpeed: num(row, "current_speed"),
    averageSpeed: num(row, "average_speed"),
    runtimeMs: durationMs(row, "runtime", SECOND),
  }));
}

/**
 * The `clientftfid` for the next negotiation.
 *
 * The server echoes it in the answer, and the echo is the only thing tying the
 * answer to the request — it arrives after the command has already returned —
 * so two transfers negotiated at once must not share one.
 */
let lastClientFileTransferID = 0;
function nextClientFileTransferID(): ClientFileTransferID {
  lastClientFileTransferID = (lastClientFileTransferID % 65535) + 1;
  return asClientFileTransferID(lastClientFileTransferID);
}

/** How {@link initFileUpload} negotiates an upload. */
export interface FileUploadOptions extends CommandOptions {
  /** The channel's password, in cleartext; "" by default (`cpw`). */
  readonly password?: string | undefined;
  /**
   * Replace a file already at the path; false by default, so an upload never
   * destroys a file unless asked to (`overwrite`, always sent).
   */
  readonly overwrite?: boolean | undefined;
  /**
   * Continue a partial upload; false by default (`resume`). The server keeps
   * what an interrupted upload had received, and `seekPosition` of the answer
   * is how much that is: send the file from there. Measured on TeamSpeak 3
   * 3.13.8 and TeamSpeak 6 6.0.0: resuming a file that is not there is refused
   * with 2054 (invalid file path), and `overwrite` together with `resume` with
   * 2056 (overwrite excludes resume).
   */
  readonly resume?: boolean | undefined;
}

/**
 * Negotiate an upload, returning the key and port to dial over TCP.
 *
 * Pass the result to the client's `uploadFileData` to send the data; it does
 * not go through this command. A refusal — no permission to upload, say — is
 * thrown as a ServerError, even though the voice protocol reports it in a
 * separate notification after the command itself has succeeded.
 */
export async function initFileUpload(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  size: bigint,
  options: FileUploadOptions = {},
): Promise<FileUploadInfo> {
  const rows = await query(
    client,
    "ftinitupload",
    [
      ["clientftfid", nextClientFileTransferID()],
      ["name", asPath(path)],
      ["cid", cid],
      ["cpw", options.password ?? ""],
      ["size", size],
      ["overwrite", options.overwrite ?? false],
      ["resume", options.resume ?? false],
      // proto is required: omitting it fails the whole call with 1539
      // (parameter not found) rather than defaulting.
      ["proto", 0],
    ],
    options,
    ["cpw"],
  );
  const row = firstRow(rows, "ftinitupload", "ftkey");
  return {
    fileTransferKey: str(row, "ftkey"),
    port: num(row, "port"),
    size,
    seekPosition: big(row, "seekpos"),
    clientFileTransferID: asClientFileTransferID(uint(row, "clientftfid", U16)),
    serverFileTransferID: asServerFileTransferID(uint(row, "serverftfid", U16)),
  };
}

/** How {@link initFileDownload} negotiates a download. */
export interface FileDownloadOptions extends CommandOptions {
  /** The channel's password, in cleartext; "" by default (`cpw`). */
  readonly password?: string | undefined;
  /**
   * The byte offset to start from, to resume; 0 by default (`seekpos`). The
   * answer's `size` stays the whole file's, and the bytes sent are those from
   * here to the end; an offset past the end is refused with 2057 (invalid file
   * size), measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0.
   */
  readonly seekPosition?: bigint | undefined;
}

/**
 * Negotiate a download, returning the key, port and size to dial over TCP.
 *
 * Pass the result to the client's `downloadFileData`. Refusals are thrown as
 * for {@link initFileUpload}.
 */
export async function initFileDownload(
  client: CommandExecutor,
  cid: ChannelID,
  path: string,
  options: FileDownloadOptions = {},
): Promise<FileDownloadInfo> {
  const seekPosition = options.seekPosition ?? 0n;
  const rows = await query(
    client,
    "ftinitdownload",
    [
      ["clientftfid", nextClientFileTransferID()],
      ["name", asPath(path)],
      ["cid", cid],
      ["cpw", options.password ?? ""],
      ["seekpos", seekPosition],
      ["proto", 0],
    ],
    options,
    ["cpw"],
  );
  const row = firstRow(rows, "ftinitdownload", "ftkey");
  return {
    fileTransferKey: str(row, "ftkey"),
    port: num(row, "port"),
    size: big(row, "size"),
    seekPosition,
    clientFileTransferID: asClientFileTransferID(uint(row, "clientftfid", U16)),
    serverFileTransferID: asServerFileTransferID(uint(row, "serverftfid", U16)),
  };
}
