import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { FileUploadInfo, FileDownloadInfo } from "./types.js";
import { FileTransferError, FileTransferTimeoutError } from "./errors.js";
import { buildCommand } from "./command/command.js";

type FtNotification =
  | FileUploadInfo
  | FileDownloadInfo
  | import("./types.js").FileTransferStatusInfo;

export class FileTransferTracker {
  readonly #pending = new Map<number, (v: FtNotification) => void>();
  #nextID = 0;

  register(): [cftid: number, promise: Promise<FtNotification>] {
    this.#nextID++;
    if (this.#nextID > 65535) this.#nextID = 1;
    const cftid = this.#nextID;
    const promise = new Promise<FtNotification>((resolve) => {
      this.#pending.set(cftid, resolve);
    });
    return [cftid, promise];
  }

  unregister(cftid: number): void {
    this.#pending.delete(cftid);
  }

  notify(cftid: number, value: FtNotification): void {
    const resolve = this.#pending.get(cftid);
    if (resolve) resolve(value);
  }

  reset(): void {
    this.#pending.clear();
    this.#nextID = 0;
  }
}

/**
 * Open a TCP connection to the TS3 file transfer port and perform the
 * ftkey handshake. The caller is responsible for closing the socket.
 */
export function dialFileTransfer(
  host: string,
  port: number,
  key: string,
): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      socket.write(key, (err) => {
        if (err) {
          socket.destroy();
          reject(new FileTransferError(`failed to send transfer key: ${err.message}`));
        } else {
          resolve(socket);
        }
      });
    });
    socket.setTimeout(10_000);
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new FileTransferError("connection timeout"));
    });
  });
}

/** Upload data via a TS3 file transfer connection. */
export async function uploadFileData(
  host: string,
  info: FileUploadInfo,
  data: Readable,
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey);
  await new Promise<void>((resolve, reject) => {
    data.pipe(socket);
    socket.on("finish", resolve);
    socket.on("error", reject);
  });
}

/** Download data via a TS3 file transfer connection. */
export async function downloadFileData(
  host: string,
  info: FileDownloadInfo,
  dest: Writable,
): Promise<void> {
  const socket = await dialFileTransfer(host, info.port, info.fileTransferKey);
  await new Promise<void>((resolve, reject) => {
    socket.pipe(dest);
    dest.on("finish", resolve);
    socket.on("error", reject);
    dest.on("error", reject);
  });
}

/**
 * Build a ftinitupload command string.
 */
export function buildFtInitUpload(
  channelID: bigint,
  path: string,
  password: string,
  size: bigint,
  cftid: number,
  overwrite: boolean,
): string {
  const targetPath = path.startsWith("/") ? path : `/${path}`;
  return buildCommand("ftinitupload", {
    cid: String(channelID),
    name: targetPath,
    cpw: password,
    size: String(size),
    clientftfid: String(cftid),
    overwrite: overwrite ? "1" : "0",
    resume: "0",
  });
}

/**
 * Build a ftinitdownload command string.
 */
export function buildFtInitDownload(
  channelID: bigint,
  path: string,
  password: string,
  cftid: number,
): string {
  const targetPath = path.startsWith("/") ? path : `/${path}`;
  return buildCommand("ftinitdownload", {
    cid: String(channelID),
    name: targetPath,
    cpw: password,
    clientftfid: String(cftid),
    seekpos: "0",
  });
}

export { FileTransferError, FileTransferTimeoutError };
