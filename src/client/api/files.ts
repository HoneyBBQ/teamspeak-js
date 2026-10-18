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

import { Readable, Writable } from "node:stream";
import { initFileDownload, initFileUpload } from "@honeybbq/teamspeak";
import type {
  ChannelID,
  CommandExecutor,
  FileDownloadInfo,
  FileDownloadOptions,
  FileUploadInfo,
  FileUploadOptions,
} from "@honeybbq/teamspeak";
import { FileTransferError } from "../errors.js";
import { downloadFileData, uploadFileData } from "../transfer.js";
import type { FileTransferOptions } from "../transfer.js";

/**
 * How {@link uploadFile} negotiates and moves the file: the options of
 * `initFileUpload`, without `resume` (the whole file is sent), and those of
 * `uploadFileData`. `signal` and `timeoutMs` apply to the negotiation, and the
 * signal to the transfer too.
 */
export interface UploadFileOptions extends Omit<FileUploadOptions, "resume">, FileTransferOptions {
  /**
   * The host of the file transfer port. A voice client sends to the host it
   * connected to, so it needs none; any other connection must name it. A host
   * given here wins over the client's own, and so does `socketFactory`.
   */
  readonly host?: string | undefined;
  /**
   * The size in bytes of a stream passed as the data, which the server needs
   * before it takes the file. Required for a `Readable`; for bytes it is their
   * length, and a different value here is refused.
   */
  readonly size?: bigint | number | undefined;
}

/** How {@link downloadFile} negotiates and moves the file. */
export interface DownloadFileOptions
  extends Omit<FileDownloadOptions, "seekPosition">, FileTransferOptions {
  /** The host of the file transfer port, as for {@link UploadFileOptions}. */
  readonly host?: string | undefined;
  /**
   * Write the file into this stream instead of returning its bytes. The stream
   * is not ended, as for `downloadFileData`.
   */
  readonly dest?: Writable | undefined;
  /**
   * The largest file, in bytes, to hold in memory when no `dest` is given;
   * 268435456 (256 MiB) by default. A larger file is refused with a
   * {@link FileTransferError} before any byte is read; the transfer the server
   * negotiated is left unused.
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

/**
 * Upload a file into a channel's file area: negotiate the transfer
 * (`initFileUpload`) and send the bytes (`uploadFileData`), in one call.
 *
 * `data` is the bytes, or a `Readable` with `options.size` the number of bytes
 * it will give. An existing file is not replaced unless `overwrite` is set, and
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
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  const source = data instanceof Uint8Array ? Readable.from([data]) : data;
  await route.upload(info, source, transferOptions(options));
}

/**
 * Download a file from a channel's file area into memory: negotiate the
 * transfer (`initFileDownload`) and read the bytes (`downloadFileData`), in one
 * call. With `options.dest` the bytes go into that stream instead and nothing
 * is held, which is the way to fetch a large file.
 *
 * A file over `maxSize` (256 MiB unless set) is refused when no `dest` is given.
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
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (options.dest !== undefined) {
    await route.download(info, options.dest, transferOptions(options));
    return;
  }
  if (info.size > BigInt(maxSize)) {
    throw new FileTransferError(
      `the file is ${info.size} bytes, over the ${maxSize} bytes maxSize allows in memory`,
    );
  }
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await route.download(info, sink, transferOptions(options));
  return Buffer.concat(chunks);
}

const DEFAULT_MAX_SIZE = 256 * 1024 * 1024;
