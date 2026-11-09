/**
 * TeamSpeak 6 S3 file transfer.
 *
 * A TeamSpeak 6 server started with S3 file transfer keeps channel files in an
 * S3-compatible bucket, and says so: its `extensions`
 * (`client.serverCapabilities.extensions`) name `"s3"`. A client asks the
 * server for a presigned URL over the voice connection and moves the bytes
 * with a plain HTTPS request to the storage; nothing goes through the server's
 * file transfer port.
 *
 * TeamSpeak does not document these commands. Everything here was measured on
 * TeamSpeak 6 6.0.0-beta13.1 with an S3-compatible storage behind TLS:
 *
 * - They run on the voice connection, which is why they take a `Client`:
 *   WebQuery refuses them as unknown commands.
 * - The server keeps each channel's file list in memory, takes a file out of it
 *   when it deletes one, and reads it from the storage again when told an
 *   upload is done: a file stored without {@link completeS3FileUpload} is not
 *   listed.
 * - Other clients are told nothing when a file is uploaded or deleted.
 * - The classic file commands (`ftinitupload`, `ftgetfilelist`, …) still work
 *   on such a server, and reach a separate store: a file uploaded one way is
 *   not listed the other.
 * - A rename is a copy the server makes in the storage, and its copy request
 *   leaves a header unsigned that a storage checking signatures refuses: see
 *   {@link renameS3File}.
 *
 * Every function takes the channel password as `password`, in cleartext, and
 * sends it the way every file command does.
 */

import { Readable, Transform, Writable, pipeline } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NoDataError } from "@honeybbq/teamspeak";
import type { ChannelID, CommandOptions, CommandRequest } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import { FileTransferError, S3TransferError, S3UnsupportedError } from "../errors.js";
import { exactSize, intoStream } from "../transfer.js";
import { parseFileList } from "./s3-list.js";

/** The extension a server names when it does S3 file transfer. */
const S3_EXTENSION = "s3";

/** The channel password an S3 file command needs, and the command's own options. */
export interface S3FileOptions extends CommandOptions {
  /** The channel's password, in cleartext; "" by default (`chpw`). */
  readonly password?: string | undefined;
}

/**
 * An upload the server signed: where to send the file, and what to tell the
 * server once it is stored.
 *
 * `url` is a credential: whoever holds it can write the file until it expires,
 * after the server's `s3ft-presigned-url-expiration` (300 seconds by default).
 * Keep it out of logs.
 */
export interface S3FileUploadInfo {
  /** The channel whose file area the file goes to. */
  readonly channelID: ChannelID;
  /** The file's path from the channel's root, as the server confirmed it. */
  readonly path: string;
  /** The size in bytes the URL is signed for. The upload must send exactly this many. */
  readonly size: bigint;
  /** The presigned URL to `PUT` the file to. */
  readonly url: string;
}

/**
 * A download the server signed. `url` is a credential as an upload's is: whoever
 * holds it can read the file until it expires.
 */
export interface S3FileDownloadInfo {
  /** The channel whose file area the file is in. */
  readonly channelID: ChannelID;
  /** The file's path from the channel's root, as the server confirmed it. */
  readonly path: string;
  /** The presigned URL to `GET` the file from. */
  readonly url: string;
}

/** One file in a channel's S3 file area. */
export interface S3FileEntry {
  /** The file's path from the channel's root, with a leading slash: `/docs/a.txt`. */
  readonly path: string;
  /** The size in bytes. */
  readonly size: bigint;
  /** When the storage last wrote it; undefined when the server sent no time it could read. */
  readonly modifiedAt: Date | undefined;
}

/** How an S3 transfer reaches the storage. */
export interface S3TransferOptions {
  /** Abandons the request; it then rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
  /**
   * The `fetch` the request goes through; the global `fetch` by default. Pass
   * one to route through a proxy, trust another certificate authority, time
   * or watch the request, or to test.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** How {@link downloadS3FileData} reads the file. */
export interface S3DownloadDataOptions extends S3TransferOptions {
  /**
   * The byte offset to start from, to resume; 0 by default. The bytes written
   * are the file's from here to its end. The storage answers an offset at or
   * past the end with 416, as an {@link S3TransferError}.
   */
  readonly seekPosition?: bigint | undefined;
}

/** Refuse before sending unless the server names the S3 extension. */
function assertS3(client: Client): void {
  const { family, version, extensions } = client.serverCapabilities;
  if (!extensions.includes(S3_EXTENSION)) {
    throw new S3UnsupportedError(family, version, extensions);
  }
}

/**
 * The path as the server takes it: from the channel's root, with a leading
 * slash added when missing.
 *
 * The server signs the URL for the path exactly as it is given, so only a
 * plain path to a file is taken: a URL parser resolves a `.` or `..` segment
 * away, and the request would not be the one signed; an empty segment
 * (`a//b`, or a slash at the end) names no directory or no file, and a storage
 * may refuse it outright; and no file name has a control character in it.
 */
function s3Path(path: string): string {
  const full = path.startsWith("/") ? path : `/${path}`;
  for (let i = 0; i < full.length; i++) {
    const code = full.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError(`the S3 file path ${JSON.stringify(path)} has a control character`);
    }
  }
  for (const segment of full.slice(1).split("/")) {
    if (segment === "") {
      throw new TypeError(
        `the S3 file path ${JSON.stringify(path)} has an empty segment, or names no file`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new TypeError(
        `the S3 file path ${JSON.stringify(path)} has a ${JSON.stringify(segment)} segment`,
      );
    }
  }
  return full;
}

/** The part of the options a command reads. */
function commandOptions(options: CommandOptions): CommandOptions {
  return { signal: options.signal, timeoutMs: options.timeoutMs };
}

/** Ask for one presigned URL. */
async function presign(
  client: Client,
  channelID: ChannelID,
  path: string,
  verb: "PUT" | "GET",
  length: bigint,
  options: S3FileOptions,
): Promise<{ path: string; url: string }> {
  assertS3(client);
  const key = s3Path(path);
  // The channel goes on the first row and each file on a row of its own: the
  // server answers a file named on the first row with no URL.
  const rows = await client.send(
    {
      command: "s3ft_getpresignedurl",
      params: [
        ["chid", channelID],
        ["chpw", options.password ?? ""],
      ],
      rows: [
        [],
        [
          ["key", key],
          ["verb", verb],
          ["length", length],
        ],
      ],
      passwords: ["chpw"],
    },
    commandOptions(options),
  );
  const row = rows.find((r) => typeof r["url"] === "string" && r["url"] !== "");
  if (row === undefined) throw new NoDataError("s3ft_getpresignedurl");
  return { path: row["key"] || key, url: row["url"]! };
}

/**
 * Ask the server to sign an upload of `size` bytes to `path` in a channel's S3
 * file area. Pass the result to {@link uploadS3FileData} to send the file, then
 * to {@link completeS3FileUpload}; {@link uploadS3File} does all three.
 *
 * The upload replaces a file already at the path: the storage keeps no other
 * copy, and nothing asks first. A client without upload power is refused with
 * 2049 (invalid file permissions). A path into a directory the channel's file
 * list does not have yet needs directory create power as well, and is refused
 * with 2049 without it; an area with no files at all takes any path. The
 * directory is no object of its own: it is there while a file is in it.
 *
 * Rejects with an {@link S3UnsupportedError} unless the server names `"s3"`
 * among its extensions, and with a `TypeError` for a path that cannot be sent
 * (see {@link uploadS3File}).
 */
export async function initS3FileUpload(
  client: Client,
  channelID: ChannelID,
  path: string,
  size: bigint,
  options: S3FileOptions = {},
): Promise<S3FileUploadInfo> {
  if (size < 0n) throw new RangeError(`size is a non-negative number of bytes, not ${size}`);
  const signed = await presign(client, channelID, path, "PUT", size, options);
  return { channelID, path: signed.path, size, url: signed.url };
}

/**
 * Ask the server to sign a download of `path` from a channel's S3 file area.
 * Pass the result to {@link downloadS3FileData}; {@link downloadS3File} does
 * both.
 *
 * The server signs a download whether or not the file is there: a missing one
 * is the 404 of the download itself. A client without download power is
 * refused with 2049 (invalid file permissions), as is a channel that does not
 * exist.
 */
export async function initS3FileDownload(
  client: Client,
  channelID: ChannelID,
  path: string,
  options: S3FileOptions = {},
): Promise<S3FileDownloadInfo> {
  const signed = await presign(client, channelID, path, "GET", 0n, options);
  return { channelID, path: signed.path, url: signed.url };
}

/** The `success` of an answer that reports one, or a NoDataError for an answer without it. */
function succeeded(rows: ReadonlyArray<Record<string, string>>, command: string): boolean {
  const row = rows.find((r) => r["success"] !== undefined);
  if (row === undefined) throw new NoDataError(command);
  return row["success"] === "1";
}

/**
 * Tell the server an upload is stored, after {@link uploadS3FileData}. The
 * server then reads the channel's file list from the storage again, and lists
 * the file; without this it does not.
 *
 * Rejects with an {@link S3TransferError} when the server reports that its own
 * request to the storage failed.
 */
export async function completeS3FileUpload(
  client: Client,
  info: S3FileUploadInfo,
  options: S3FileOptions = {},
): Promise<void> {
  assertS3(client);
  // The server reads the channel and nothing else: measured on TeamSpeak 6
  // 6.0.0-beta13.1, it lists the channel again whatever else the command says.
  const rows = await client.send(
    {
      command: "s3ft_upload_done_notification",
      params: [
        ["chid", info.channelID],
        ["chpw", options.password ?? ""],
      ],
      passwords: ["chpw"],
    },
    commandOptions(options),
  );
  if (!succeeded(rows, "s3ft_upload_done_notification")) {
    throw new S3TransferError(
      `the server could not read the file list of channel ${info.channelID} from its storage`,
    );
  }
}

/**
 * Every file in a channel's S3 file area, in the storage's order (by path), as
 * the server last read them from the storage.
 *
 * The list is the whole area, files in directories included: there are no
 * directories, only paths. A file uploaded without
 * {@link completeS3FileUpload} is missing from it until the server reads the
 * list again. A channel that does not exist has no files.
 */
export async function listS3Files(
  client: Client,
  channelID: ChannelID,
  options: S3FileOptions = {},
): Promise<S3FileEntry[]> {
  assertS3(client);
  const rows = await client.send(
    {
      command: "s3ft_list_files",
      params: [
        ["chid", channelID],
        ["chpw", options.password ?? ""],
      ],
      passwords: ["chpw"],
    },
    commandOptions(options),
  );
  const row = rows.find((r) => r["b64_json"] !== undefined);
  if (row === undefined) throw new NoDataError("s3ft_list_files");
  return parseFileList(row["b64_json"]!);
}

/**
 * Delete files from a channel's S3 file area: one path, or several in one
 * command (`s3ft_deletefiles`, each file on a row of its own). The server
 * deletes them from the storage and from the file list it keeps; an empty list
 * sends nothing.
 *
 * Deleting a file that is not there succeeds, as the storage's delete does. A
 * client without delete power is refused with 2568 (insufficient client
 * permissions), and then nothing is deleted. Rejects with an
 * {@link S3TransferError} when the server reports that its own request to the
 * storage failed.
 */
export async function deleteS3File(
  client: Client,
  channelID: ChannelID,
  paths: string | readonly string[],
  options: S3FileOptions = {},
): Promise<void> {
  assertS3(client);
  const keys = (typeof paths === "string" ? [paths] : paths).map(s3Path);
  if (keys.length === 0) return;
  // The single command deletes the file of its first row and passes over any
  // further row; the batch reads the channel from each file's own row, the
  // first row carrying the channel and its password only.
  const command: CommandRequest =
    keys.length === 1
      ? {
          command: "s3ft_deletefile",
          params: [
            ["chid", channelID],
            ["chpw", options.password ?? ""],
            ["key", keys[0]!],
          ],
          passwords: ["chpw"],
        }
      : {
          command: "s3ft_deletefiles",
          params: [
            ["chid", channelID],
            ["chpw", options.password ?? ""],
          ],
          rows: [
            [],
            ...keys.map(
              (key) =>
                [
                  ["chid", channelID],
                  ["key", key],
                ] as const,
            ),
          ],
          passwords: ["chpw"],
        };
  const rows = await client.send(command, commandOptions(options));
  if (!succeeded(rows, command.command)) {
    throw new S3TransferError(
      keys.length === 1
        ? `the server could not delete ${keys[0]!} from its storage`
        : `the server could not delete the ${keys.length} files from its storage`,
    );
  }
}

/** One file of a {@link renameS3Files} batch: its path now, and the one it moves to. */
export interface S3FileRename {
  /** The file's path now, from the channel's root. */
  readonly oldPath: string;
  /** The path it moves to, in the same channel. */
  readonly newPath: string;
}

/**
 * Rename or move one file within a channel's S3 file area (`s3ft_renamefile`).
 * The server copies the file in the storage to the new path, deletes the old
 * one, and updates the file list it keeps. A file already at the new path is
 * replaced. There is no move to another channel.
 *
 * A client without rename power is refused with 2568 (insufficient client
 * permissions). Rejects with an {@link S3TransferError} when the server
 * reports that it did not rename the file: there is none at the old path, the
 * new path is the old one, or the storage refused the server's copy.
 *
 * Measured on TeamSpeak 6 6.0.0-beta13.1: the server's copy carries an
 * `x-amz-copy-source` header it does not sign, which a storage that checks
 * every request's signature refuses (RustFS, versitygw, SeaweedFS and
 * CloudServer did, as S3's signing rules have it), so the rename fails there
 * and the file stays where it was.
 */
export async function renameS3File(
  client: Client,
  channelID: ChannelID,
  oldPath: string,
  newPath: string,
  options: S3FileOptions = {},
): Promise<void> {
  assertS3(client);
  const from = s3Path(oldPath);
  const to = s3Path(newPath);
  const rows = await client.send(
    {
      command: "s3ft_renamefile",
      params: [
        ["chid", channelID],
        ["chpw", options.password ?? ""],
        ["key_old", from],
        ["key_new", to],
      ],
      passwords: ["chpw"],
    },
    commandOptions(options),
  );
  if (!succeeded(rows, "s3ft_renamefile")) {
    throw new S3TransferError(`the server did not rename ${from} to ${to}`);
  }
}

/**
 * Rename several files within a channel's S3 file area in one command
 * (`s3ft_renamefiles`, each file on a row of its own). Each is renamed as by
 * {@link renameS3File}; an empty list sends nothing.
 *
 * The server tries every rename, and answers once: whether the batch's last
 * rename was done, and nothing about the others. So this rejects with an
 * {@link S3TransferError} when the last one failed, whatever became of the
 * rest, and resolves when it succeeded even if an earlier one failed. List the
 * files, or rename them one at a time, to know each outcome. After a batch
 * whose last rename failed, the list the server keeps shows the others a
 * moment later rather than at once.
 */
export async function renameS3Files(
  client: Client,
  channelID: ChannelID,
  renames: readonly S3FileRename[],
  options: S3FileOptions = {},
): Promise<void> {
  assertS3(client);
  const pairs = renames.map(({ oldPath, newPath }) => [s3Path(oldPath), s3Path(newPath)] as const);
  if (pairs.length === 0) return;
  const rows = await client.send(
    {
      command: "s3ft_renamefiles",
      params: [
        ["chid", channelID],
        ["chpw", options.password ?? ""],
      ],
      rows: [
        [],
        ...pairs.map(
          ([from, to]) =>
            [
              ["chid", channelID],
              ["key_old", from],
              ["key_new", to],
            ] as const,
        ),
      ],
      passwords: ["chpw"],
    },
    commandOptions(options),
  );
  if (!succeeded(rows, "s3ft_renamefiles")) {
    const [from, to] = pairs[pairs.length - 1]!;
    throw new S3TransferError(
      `the server reports that the last rename of the batch, ${from} to ${to}, was not done`,
    );
  }
}

/** How much of a storage's error answer is read for its code. */
const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * The storage's answer to a request that failed, as an S3TransferError. The
 * body is read only for its `<Code>`, and only so far.
 */
async function storageRefused(what: string, response: Response): Promise<S3TransferError> {
  let code: string | undefined;
  try {
    const body = await readAtMost(response, ERROR_BODY_LIMIT);
    code = /<Code>([^<]{1,128})<\/Code>/.exec(body)?.[1];
  } catch {
    // No body to read: the status says enough.
  }
  return new S3TransferError(
    `the storage refused ${what}: HTTP ${response.status}${code === undefined ? "" : ` ${code}`}`,
    { status: response.status, code },
  );
}

/** Up to `limit` bytes of a response's body, as text; the rest is not read. */
async function readAtMost(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/**
 * Send one request to the storage. A request that gets no answer rejects with
 * an S3TransferError whose `cause` says why; an abort rejects with the
 * signal's reason. The URL is never in a message.
 */
async function request(
  what: string,
  url: string,
  init: RequestInit,
  options: S3TransferOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    return await fetchImpl(url, { ...init, signal: options.signal ?? null });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    // A body that broke the request said why itself; fetch reports it as the
    // cause of its own error.
    if (error instanceof FileTransferError) throw error;
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (cause instanceof FileTransferError) throw cause;
    throw new S3TransferError(`${what} got no answer from the storage`, { cause: error });
  }
}

/**
 * Send a file to the storage, over an upload {@link initS3FileUpload} signed.
 * `data` must be exactly `info.size` bytes: bytes or a `Blob` of another size
 * are refused before anything is sent, and a stream that gives fewer or more
 * fails the upload.
 *
 * Resolves once the storage has answered that it stored the file. Then call
 * {@link completeS3FileUpload}, or the server does not list it. A failure is an
 * {@link S3TransferError}: 403 for a URL that expired.
 */
export async function uploadS3FileData(
  info: S3FileUploadInfo,
  data: Uint8Array | Blob | Readable,
  options: S3TransferOptions = {},
): Promise<void> {
  const what = `the upload of ${info.path}`;
  // Signed with the URL: the storage refuses a body of another length.
  const init: RequestInit = { method: "PUT", headers: { "content-length": String(info.size) } };
  if (data instanceof Uint8Array || data instanceof Blob) {
    const length = data instanceof Uint8Array ? data.length : data.size;
    if (BigInt(length) !== info.size) {
      throw new TypeError(`the upload is signed for ${info.size} bytes and the data is ${length}`);
    }
    init.body = data;
  } else {
    // A stream goes out with the length the URL is signed for, so one that
    // gives fewer or more bytes is cut off here, with a message that says so.
    const exact = pipeline(data, exactSize(Number(info.size), "declared"), () => {});
    init.body = Readable.toWeb(exact) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const response = await request(what, info.url, init, options);
  if (!response.ok) throw await storageRefused(what, response);
  await response.body?.cancel().catch(() => {});
}

/**
 * Read a file from the storage into `dest`, over a download
 * {@link initS3FileDownload} signed. Resolves once the file is written; `dest`
 * is not ended, so it may take another download.
 *
 * A file that is not there is an {@link S3TransferError} with status 404; a URL
 * that expired, one with 403.
 */
export async function downloadS3FileData(
  info: S3FileDownloadInfo,
  dest: Writable,
  options: S3DownloadDataOptions = {},
): Promise<void> {
  const response = await openDownload(info, options);
  await writeBody(
    `the download of ${info.path}`,
    response,
    dest,
    skipFor(response, options),
    options,
  );
}

/** The bytes to drop from the start of a download: those a storage that ignored the range sent. */
function skipFor(response: Response, options: S3DownloadDataOptions): number {
  const seek = options.seekPosition ?? 0n;
  return seek > 0n && response.status === 200 ? Number(seek) : 0;
}

/** Ask the storage for the file, from `seekPosition` on, and check that it answered with it. */
async function openDownload(
  info: S3FileDownloadInfo,
  options: S3DownloadDataOptions,
): Promise<Response> {
  const seek = options.seekPosition ?? 0n;
  if (seek < 0n) throw new RangeError(`seekPosition is a non-negative offset, not ${seek}`);
  const what = `the download of ${info.path}`;
  const response = await request(
    what,
    info.url,
    seek > 0n ? { headers: { range: `bytes=${seek}-` } } : {},
    options,
  );
  // 206 is the part asked for; a storage that ignores the range sends the
  // whole file with 200, and the bytes before the offset are dropped.
  if (response.status !== 200 && !(seek > 0n && response.status === 206)) {
    throw await storageRefused(what, response);
  }
  return response;
}

/** Drops the first `count` bytes of a stream. */
function skipBytes(count: number): Transform {
  let left = count;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (left >= chunk.length) {
        left -= chunk.length;
        callback();
        return;
      }
      const rest = left === 0 ? chunk : chunk.subarray(left);
      left = 0;
      callback(null, rest);
    },
  });
}

/** Write a response's body into `dest`, less its first `skip` bytes. */
async function writeBody(
  what: string,
  response: Response,
  dest: Writable,
  skip: number,
  options: S3TransferOptions,
): Promise<void> {
  const body = response.body;
  if (body === null) return;
  try {
    await pipelineAsync(
      Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
      skipBytes(skip),
      intoStream(dest),
    );
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    // The caller's stream failing is its own error, not the storage's.
    if (error instanceof FileTransferError || dest.errored === error) throw error;
    throw new S3TransferError(`${what} broke off`, { cause: error });
  }
}

/**
 * How {@link uploadS3File} signs and sends the file: the options of the
 * commands and those of the request. `signal` applies to both.
 */
export interface UploadS3FileOptions extends S3FileOptions, S3TransferOptions {
  /**
   * The size in bytes of a stream passed as the data, which the server signs
   * the upload for. Required for a `Readable`; for bytes or a `Blob` it is
   * their size, and a different value here is refused.
   */
  readonly size?: bigint | number | undefined;
}

/**
 * Upload a file into a channel's S3 file area: sign the upload
 * ({@link initS3FileUpload}), send the file to the storage
 * ({@link uploadS3FileData}) and tell the server it is stored
 * ({@link completeS3FileUpload}), in one call.
 *
 * `data` is the bytes, a `Blob` (such as `fs.openAsBlob(file)`), or a
 * `Readable` with `options.size` the number of bytes it will give. Resolves
 * once the storage has stored the file and the server lists it. The file
 * replaces one already at the path.
 *
 * `path` runs from the channel's root; a leading slash is added when missing,
 * and the directories in it need not exist. A path is refused with a
 * `TypeError` when an HTTP client would not send the URL the server signs for
 * it: one with an empty, `.` or `..` segment, a control character, or a slash
 * at its end.
 *
 * A refusal by the server is the ServerError it sends (2049 for a client
 * without upload power); a failure of the storage request, or a server that
 * reports its own request to the storage failed, is an {@link S3TransferError}. A
 * server that does not name `"s3"` among its extensions is refused with an
 * {@link S3UnsupportedError} before anything is sent.
 */
export async function uploadS3File(
  client: Client,
  channelID: ChannelID,
  path: string,
  data: Uint8Array | Blob | Readable,
  options: UploadS3FileOptions = {},
): Promise<void> {
  const size = sizeOf(data, options.size);
  const info = await initS3FileUpload(client, channelID, path, size, options);
  await uploadS3FileData(info, data, options);
  await completeS3FileUpload(client, info, options);
}

function sizeOf(data: Uint8Array | Blob | Readable, declared: bigint | number | undefined): bigint {
  if (
    declared !== undefined &&
    (typeof declared === "number" ? !Number.isSafeInteger(declared) || declared < 0 : declared < 0n)
  ) {
    throw new RangeError(`size is a non-negative whole number of bytes, not ${String(declared)}`);
  }
  const size = declared === undefined ? undefined : BigInt(declared);
  if (data instanceof Uint8Array || data instanceof Blob) {
    const length = BigInt(data instanceof Uint8Array ? data.length : data.size);
    if (size !== undefined && size !== length) {
      throw new TypeError(`size says ${size} bytes and the data is ${length}`);
    }
    return length;
  }
  if (size === undefined) {
    throw new TypeError("a stream has no known length: pass options.size, in bytes");
  }
  return size;
}

/**
 * How {@link downloadS3File} signs and reads the file. With a `seekPosition`
 * the bytes are the file's from there to its end.
 */
export interface DownloadS3FileOptions extends S3FileOptions, S3DownloadDataOptions {
  /**
   * Write the file into this stream instead of returning its bytes. The stream
   * is neither ended nor destroyed, so it may take several downloads; a failed
   * download still rejects the call.
   */
  readonly dest?: Writable | undefined;
  /**
   * The most bytes to hold in memory when no `dest` is given; 268435456
   * (256 MiB) by default. A larger download is refused with a
   * {@link FileTransferError} before its body is read.
   */
  readonly maxSize?: number | undefined;
}

/**
 * Download a file from a channel's S3 file area into memory: sign the download
 * ({@link initS3FileDownload}) and read the file ({@link downloadS3FileData}),
 * in one call. With `options.dest` the bytes go into that stream instead and
 * nothing is held, which is the way to fetch a large file.
 *
 * A file that is not there is an {@link S3TransferError} with status 404. Paths
 * and refusals are as for {@link uploadS3File}.
 */
export function downloadS3File(
  client: Client,
  channelID: ChannelID,
  path: string,
  options: DownloadS3FileOptions & { readonly dest: Writable },
): Promise<void>;
export function downloadS3File(
  client: Client,
  channelID: ChannelID,
  path: string,
  options?: DownloadS3FileOptions,
): Promise<Uint8Array>;
export async function downloadS3File(
  client: Client,
  channelID: ChannelID,
  path: string,
  options: DownloadS3FileOptions = {},
): Promise<Uint8Array | void> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  if (!Number.isFinite(maxSize) || maxSize < 0) {
    throw new RangeError(`maxSize is a non-negative number of bytes, not ${String(maxSize)}`);
  }
  const info = await initS3FileDownload(client, channelID, path, options);
  if (options.dest !== undefined) {
    await downloadS3FileData(info, options.dest, options);
    return;
  }
  const response = await openDownload(info, options);
  const skip = skipFor(response, options);
  const announced = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(announced) && announced - skip > maxSize) {
    await response.body?.cancel().catch(() => {});
    throw new FileTransferError(
      `the download is ${announced - skip} bytes, over the ${maxSize} bytes maxSize allows in memory`,
    );
  }
  const chunks: Buffer[] = [];
  let held = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      held += chunk.length;
      // A storage that announced no length is held to the limit as it sends.
      if (held > maxSize) {
        done(
          new FileTransferError(
            `the download is over the ${maxSize} bytes maxSize allows in memory`,
          ),
        );
        return;
      }
      chunks.push(chunk);
      done();
    },
  });
  await writeBody(`the download of ${info.path}`, response, sink, skip, options);
  return Buffer.concat(chunks);
}

const DEFAULT_MAX_SIZE = 256 * 1024 * 1024;
