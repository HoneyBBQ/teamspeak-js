/**
 * Avatars and icons: the file transfers behind them.
 *
 * Both live in channel 0's file area, so each helper negotiates a transfer
 * (`ftinitupload`, `ftinitdownload`) and moves the bytes over the client's own
 * file transfer connection, as `Client.uploadFileData` does.
 */

import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import {
  ErrorCode,
  ServerError,
  asChannelID,
  avatarFileName,
  deleteFile,
  iconFileName,
  iconIDOf,
  initFileDownload,
  initFileUpload,
  updateClient,
} from "@honeybbq/teamspeak";
import type { IconID, UID } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import type { FileTransferOptions } from "../transfer.js";

/** Options for the avatar and icon transfers. */
export type AvatarTransferOptions = Pick<FileTransferOptions, "signal" | "trace">;

const CHANNEL_ZERO = asChannelID(0n);

async function download(
  client: Client,
  name: string,
  options: AvatarTransferOptions,
): Promise<Uint8Array | undefined> {
  let info;
  try {
    info = await initFileDownload(client, CHANNEL_ZERO, name, options);
  } catch (error) {
    // TeamSpeak 6 answers 2051 for a file that is not there, TeamSpeak 3 2054.
    if (
      error instanceof ServerError &&
      (error.code === ErrorCode.FileNotFound || error.code === ErrorCode.FileInvalidPath)
    ) {
      return undefined;
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  await client.downloadFileData(client.host, info, sink, options);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Upload `data` as this client's avatar and set `client_flag_avatar` to its
 * MD5, so that other clients see the change in a `clientUpdated` event.
 *
 * On the wire: `ftinitupload cid=0 name=/avatar_<md5 hex>` with `overwrite=1`,
 * the bytes over the file transfer port, then
 * `clientupdate client_flag_avatar=<md5>`. The server does not keep the file under the MD5
 * name: it stores it as {@link avatarFileName} of the client's unique id (20
 * bytes of SHA-1 on TeamSpeak 3, 32 of SHA-256 on TeamSpeak 6). Returns the
 * MD5, lower-case hex.
 *
 * The size limit is the permission `i_client_max_avatar_filesize`, 200000
 * bytes for a Server Admin; over it, the negotiation fails with a ServerError
 * 2565 (invalid size) and nothing is sent or changed. A file of exactly the
 * limit passes.
 */
export async function uploadAvatar(
  client: Client,
  data: Uint8Array,
  options: AvatarTransferOptions = {},
): Promise<string> {
  const md5 = createHash("md5").update(data).digest("hex");
  const info = await initFileUpload(client, CHANNEL_ZERO, `/avatar_${md5}`, BigInt(data.length), {
    overwrite: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await client.uploadFileData(client.host, info, Readable.from([data]), options);
  await updateClient(client, { avatar: md5 });
  return md5;
}

/**
 * The bytes of the avatar of the client with this unique id, or undefined when
 * the server has no avatar file for it (`ftinitdownload cid=0` with the name
 * from {@link avatarFileName}; error 2051 on TeamSpeak 6, 2054 on
 * TeamSpeak 3). Setting the flag empty alone leaves the file in place;
 * `removeAvatar` deletes it.
 */
export function downloadAvatar(
  client: Client,
  uid: UID | string,
  options: AvatarTransferOptions = {},
): Promise<Uint8Array | undefined> {
  return download(client, `/${avatarFileName(uid)}`, options);
}

/**
 * Remove this client's own avatar: `ftdeletefile cid=0 name=/avatar_`, which,
 * as measured on both servers, deletes the caller's stored avatar file and
 * empties `client_flag_avatar`. Deleting the file by its stored name was
 * refused with 1540, and TS6's `clientavatardeleted` (given `cluid`) answered
 * OK without removing it; this is the removal that worked.
 * Resolves with true when an avatar was removed, false when there was none
 * (error 2054).
 */
export async function removeAvatar(
  client: Client,
  options: AvatarTransferOptions = {},
): Promise<boolean> {
  try {
    await deleteFile(client, CHANNEL_ZERO, "/avatar_", options);
    return true;
  } catch (error) {
    if (error instanceof ServerError && error.code === ErrorCode.FileInvalidPath) return false;
    throw error;
  }
}

/**
 * Upload `data` as an icon and return its id, the CRC-32 of the bytes
 * ({@link iconIDOf}).
 *
 * On the wire: `ftinitupload cid=0 name=/icon_<id>` with `overwrite=1`, then
 * the bytes; the server keeps it in channel 0's `icons` directory. The id is
 * not checked by the server against the bytes, and the file does not
 * reference anything by itself: pass the id to `setChannelIcon`, `setServerGroupIcon`,
 * `setChannelGroupIcon`, `setClientIcon` or `setServerIcon`.
 *
 * Needs `b_icon_manage` (error 2568 without it). The size limit is
 * `i_max_icon_filesize`, 8192 bytes for a Server Admin; over it, the
 * negotiation fails with a ServerError 2565 (invalid size).
 */
export async function uploadIcon(
  client: Client,
  data: Uint8Array,
  options: AvatarTransferOptions = {},
): Promise<IconID> {
  const id = iconIDOf(data);
  const info = await initFileUpload(client, CHANNEL_ZERO, iconFileName(id), BigInt(data.length), {
    overwrite: true,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await client.uploadFileData(client.host, info, Readable.from([data]), options);
  return id;
}

/** The bytes of an icon, or undefined when the server has no file for the id. */
export function downloadIcon(
  client: Client,
  id: IconID,
  options: AvatarTransferOptions = {},
): Promise<Uint8Array | undefined> {
  return download(client, iconFileName(id), options);
}
