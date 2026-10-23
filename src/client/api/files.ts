/**
 * One-call file transfers: negotiate the transfer, move the bytes, and return.
 *
 * `initFileUpload` and `uploadFileData` (and the download twins) are the two
 * halves of a transfer; these run both, over the connection that sends the
 * commands. That is a voice `Client`, or a `QueryClient` over raw TCP or SSH:
 * measured on TeamSpeak 3 3.13.8 (raw TCP, SSH, voice) and TeamSpeak 6
 * beta13.1 (SSH, voice), the key a query connection negotiates opens the same
 * file transfer port a voice client's does. WebQuery refuses every file command
 * (error 5120), on both servers.
 */

import { Readable, Transform, Writable, pipeline } from "node:stream";
import {
  ErrorCode,
  ServerError,
  getFileInfo,
  initFileDownload,
  initFileUpload,
  stopFileTransfer,
} from "@honeybbq/teamspeak";
import type {
  ChannelID,
  CommandExecutor,
  FileDownloadInfo,
  FileDownloadOptions,
  FileUploadInfo,
  FileUploadOptions,
} from "@honeybbq/teamspeak";
import { FileTransferError } from "../errors.js";
import { downloadFileData, failedToConnect, uploadFileData } from "../transfer.js";
import type { FileTransferOptions } from "../transfer.js";

/**
 * How {@link uploadFile} negotiates and moves the file: the options of
 * `initFileUpload` and those of `uploadFileData`. `signal` and `timeoutMs`
 * apply to the negotiation, and the signal to the transfer too.
 */
export interface UploadFileOptions extends FileUploadOptions, FileTransferOptions {
  /**
   * The host of the file transfer port. A voice client sends to the host it
   * connected to, so it needs none; any other connection must name it. A host
   * given here wins over the client's own, and so does `socketFactory`.
   */
  readonly host?: string | undefined;
  /**
   * The size in bytes of a stream passed as the data, which the server needs
   * before it takes the file. Required for a `Readable`; for bytes it is their
   * length, and a different value here is refused. A stream that gives fewer
   * or more bytes fails the upload.
   */
  readonly size?: bigint | number | undefined;
}

/**
 * How {@link downloadFile} negotiates and moves the file. With a
 * `seekPosition` the bytes are the file's from there to its end.
 */
export interface DownloadFileOptions extends FileDownloadOptions, FileTransferOptions {
  /** The host of the file transfer port, as for {@link UploadFileOptions}. */
  readonly host?: string | undefined;
  /**
   * Write the file into this stream instead of returning its bytes. The stream
   * is neither ended nor destroyed, as for `downloadFileData`, so it may take
   * several downloads; a failed transfer still rejects the call.
   */
  readonly dest?: Writable | undefined;
  /**
   * The most bytes to hold in memory when no `dest` is given; 268435456
   * (256 MiB) by default. A larger download is refused with a
   * {@link FileTransferError} before any byte is read, and the transfer the
   * server negotiated is stopped.
   */
  readonly maxSize?: number | undefined;
}

/** What a voice client can do beyond a bare executor: its host and its own transfer sockets. */
interface TransferCapable {
  readonly host: string;
  uploadFileData(
    host: string,
    info: FileUploadInfo,
    data: Readable,
    options: Pick<FileTransferOptions, "signal" | "trace" | "idleTimeoutMs">,
  ): Promise<void>;
  downloadFileData(
    host: string,
    info: FileDownloadInfo,
    dest: Writable,
    options: Pick<FileTransferOptions, "signal" | "trace" | "idleTimeoutMs">,
  ): Promise<void>;
}

function isTransferCapable(client: CommandExecutor): client is CommandExecutor & TransferCapable {
  const candidate = client as Partial<TransferCapable>;
  return (
    typeof candidate.host === "string" &&
    typeof candidate.uploadFileData === "function" &&
    typeof candidate.downloadFileData === "function"
  );
}

/**
 * How to move the bytes over this connection: through the client's own
 * transfer sockets when it has them and the caller named neither a host nor a
 * socket factory, else by dialling `options.host`.
 */
function routeFor(
  client: CommandExecutor,
  options: { readonly host?: string | undefined } & Pick<FileTransferOptions, "socketFactory">,
): {
  upload(info: FileUploadInfo, data: Readable, options: FileTransferOptions): Promise<void>;
  download(info: FileDownloadInfo, dest: Writable, options: FileTransferOptions): Promise<void>;
} {
  if (isTransferCapable(client) && options.host === undefined && !options.socketFactory) {
    return {
      upload: (info, data, o) => client.uploadFileData(client.host, info, data, o),
      download: (info, dest, o) => client.downloadFileData(client.host, info, dest, o),
    };
  }
  const host = options.host ?? (isTransferCapable(client) ? client.host : undefined);
  if (host === undefined || host === "") {
    throw new TypeError(
      "the file transfer port is on a host this connection does not name: pass it as options.host",
    );
  }
  return {
    upload: (info, data, o) => uploadFileData(host, info, data, o),
    download: (info, dest, o) => downloadFileData(host, info, dest, o),
  };
}

/** The part of the options a transfer's data phase reads. */
function transferOptions(options: FileTransferOptions): FileTransferOptions {
  return {
    signal: options.signal,
    socketFactory: options.socketFactory,
    trace: options.trace,
    idleTimeoutMs: options.idleTimeoutMs,
  };
}

function sizeOf(data: Uint8Array | Readable, declared: bigint | number | undefined): bigint {
  const size = declared === undefined ? undefined : BigInt(declared);
  if (size !== undefined && (size < 0n || !Number.isInteger(Number(declared)))) {
    throw new RangeError(`size is a non-negative whole number of bytes, not ${String(declared)}`);
  }
  if (data instanceof Uint8Array) {
    if (size !== undefined && size !== BigInt(data.length)) {
      throw new TypeError(`size says ${size} bytes and the data is ${data.length}`);
    }
    return BigInt(data.length);
  }
  if (size === undefined) {
    throw new TypeError("a stream has no known length: pass options.size, in bytes");
  }
  return size;
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
      const rest = chunk.subarray(left);
      left = 0;
      callback(null, rest);
    },
  });
}

/**
 * Upload a file into a channel's file area: negotiate the transfer
 * (`initFileUpload`) and send the bytes (`uploadFileData`), in one call.
 *
 * `data` is the bytes, or a `Readable` with `options.size` the number of bytes
 * it will give. It resolves once the server has closed the transfer
 * connection and, by `ftgetfileinfo` (one more command), holds a file of
 * exactly that size: the server does not say whether it stored a file, so a
 * close alone could be a transfer someone stopped. A size that differs, or a
 * file that is not there, fails the call with a {@link FileTransferError}; a
 * client with no browse power cannot ask (2568) and resolves on the close. A
 * stream that gives fewer or more bytes than `size` fails the call, and the
 * connection is closed. When the connection to the file transfer port is
 * refused or times out, the negotiated transfer is stopped on the server (else
 * it lingers in `ftlist` for about 10 seconds), as it is for `downloadFile`.
 *
 * With `resume`, `data` is still the whole file: the server says how much it
 * already holds from an interrupted upload (a file that is not there is
 * refused with 2054), and only the rest is sent; `overwrite` cannot go with it
 * (2056). An existing file is not replaced unless `overwrite` is set, and
 * the directory the file goes in must exist (a missing one is refused with
 * 2054, invalid file path): make it with `createDirectory` first. A refusal of
 * the negotiation is thrown as the ServerError it is, before anything is sent;
 * a failure of the connection to the file transfer port is a
 * {@link FileTransferError}.
 *
 * Over a voice `Client` the bytes go through its own transfer sockets and to the
 * host it connected to. Over any other connection, such as a `QueryClient`,
 * name the host of the file transfer port in `options.host`.
 */
export async function uploadFile(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  data: Uint8Array | Readable,
  options: UploadFileOptions = {},
): Promise<void> {
  const size = sizeOf(data, options.size);
  const route = routeFor(client, options);
  const info = await initFileUpload(client, channelID, path, size, {
    password: options.password,
    overwrite: options.overwrite,
    resume: options.resume,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  // What the server holds is not sent again; a position past the end is for
  // the transfer to refuse.
  const skip = Number(info.seekPosition);
  let source: Readable;
  if (data instanceof Uint8Array) source = Readable.from([data.subarray(skip)]);
  else if (skip === 0) source = data;
  else source = pipeline(data, skipBytes(skip), () => {});
  await withDialCleanup(client, info.serverFileTransferID, () =>
    route.upload(info, source, transferOptions(options)),
  );
  await verifyStored(client, channelID, path, size, options);
}

/**
 * The server drops a transfer nobody dialled after about 10 seconds (measured
 * on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0: it is gone from `ftlist` at
 * 10.05 s, and the voice client hears 2059). `ftstop` of a transfer the server
 * no longer has crashes TeamSpeak 6, so a stop is only sent well inside that.
 */
const STOP_WITHIN_MS = 5_000;

/**
 * Runs the data phase of a transfer the server has negotiated. When it fails
 * because the connection to the file transfer port was refused or timed out,
 * nothing has reached the server, and the transfer would sit in its list until
 * it expires: stop it, as a refused `maxSize` download does. The stop is best
 * effort and never replaces the dial's error. Not sent once the connection
 * opened (the key may be written and the server may have dropped the transfer),
 * nor after `STOP_WITHIN_MS`.
 */
async function withDialCleanup(
  client: CommandExecutor,
  serverFileTransferID: FileUploadInfo["serverFileTransferID"],
  move: () => Promise<void>,
): Promise<void> {
  const negotiatedAt = performance.now();
  try {
    await move();
  } catch (error) {
    if (failedToConnect(error) && performance.now() - negotiatedAt < STOP_WITHIN_MS) {
      await stopFileTransfer(client, serverFileTransferID).catch(() => {});
    }
    throw error;
  }
}

/**
 * Checks that the server holds the whole file after an upload's connection
 * closed. Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0: a completed
 * upload gets no status from the server, so a close after the last byte looks
 * the same whether the file was stored or the transfer was stopped (the voice
 * protocol reports that, 2066, only after the close), and `ftgetfileinfo`
 * already answers the final size 6 to 45 ms after the close, in every case.
 * Permissions are checked at the negotiation only, so no refusal comes later.
 *
 * A client without browse power gets 2568 for `ftgetfileinfo`: the file cannot
 * be checked, and the upload resolves on the close. Any other failure of the
 * command is thrown as it is.
 */
async function verifyStored(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  size: bigint,
  options: UploadFileOptions,
): Promise<void> {
  let stored: bigint;
  try {
    stored = (
      await getFileInfo(client, channelID, path, {
        password: options.password,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      })
    ).size;
  } catch (error) {
    if (error instanceof ServerError) {
      if (error.code === ErrorCode.PermissionsClientInsufficient) return;
      // 2051 on TeamSpeak 6, 2052 on TeamSpeak 3 for a file that is not there.
      if (error.code === ErrorCode.FileNotFound || error.code === ErrorCode.FileIOError) {
        throw new FileTransferError(`the server closed the upload but has no file ${path}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
  if (stored !== size) {
    throw new FileTransferError(
      `the server closed the upload but holds ${stored} of the ${size} bytes of ${path}`,
    );
  }
}

/**
 * Download a file from a channel's file area into memory: negotiate the
 * transfer (`initFileDownload`) and read the bytes (`downloadFileData`), in one
 * call. With `options.dest` the bytes go into that stream instead and nothing
 * is held, which is the way to fetch a large file.
 *
 * With `seekPosition` the bytes are the file's from there to its end, which is
 * how to resume a partial download: append them to what was already fetched.
 *
 * More than `maxSize` bytes (256 MiB unless set) is refused when no `dest` is
 * given, and the transfer the server negotiated is stopped.
 * A file that is not there is the ServerError of the negotiation: 2051 on TS3
 * 3.13.8 and TS6 beta13.1. A path that names a directory is not refused by the
 * server: it announces a size and sends nothing, so the call rejects with a
 * {@link FileTransferError} for the bytes that never came.
 *
 * Over a voice `Client` the bytes come through its own transfer sockets from
 * the host it connected to. Over any other connection, name the host of the
 * file transfer port in `options.host`.
 */
export function downloadFile(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  options: DownloadFileOptions & { readonly dest: Writable },
): Promise<void>;
export function downloadFile(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  options?: DownloadFileOptions,
): Promise<Uint8Array>;
export async function downloadFile(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  options: DownloadFileOptions = {},
): Promise<Uint8Array | void> {
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  if (!Number.isFinite(maxSize) || maxSize < 0) {
    throw new RangeError(`maxSize is a non-negative number of bytes, not ${String(maxSize)}`);
  }
  const route = routeFor(client, options);
  const info = await initFileDownload(client, channelID, path, {
    password: options.password,
    seekPosition: options.seekPosition,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (options.dest !== undefined) {
    const dest = options.dest;
    await withDialCleanup(client, info.serverFileTransferID, () =>
      route.download(info, dest, transferOptions(options)),
    );
    return;
  }
  const wanted = info.size - info.seekPosition;
  if (wanted > BigInt(maxSize)) {
    // The server holds the negotiated transfer, and lists it among the active
    // ones, until it is used or stopped. It is this connection's own, which is
    // the only kind `ftstop` is safe to send.
    await stopFileTransfer(client, info.serverFileTransferID).catch(() => {});
    throw new FileTransferError(
      `the download is ${wanted} bytes, over the ${maxSize} bytes maxSize allows in memory`,
    );
  }
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await withDialCleanup(client, info.serverFileTransferID, () =>
    route.download(info, sink, transferOptions(options)),
  );
  return Buffer.concat(chunks);
}

const DEFAULT_MAX_SIZE = 256 * 1024 * 1024;
