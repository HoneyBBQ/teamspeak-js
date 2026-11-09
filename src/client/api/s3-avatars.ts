/**
 * Avatars and icons on a TeamSpeak 6 server with S3 file transfer: the S3
 * transfers behind them, in channel 0's S3 file area.
 *
 * Measured on TeamSpeak 6 6.0.0-beta13.1. In channel 0 the server signs an
 * upload only for a name that starts with `avatar_` or `icon_`, and keeps the
 * file under the name it is given: unlike the classic upload, which the server
 * stores under the uploader's {@link avatarFileName} whatever it was asked,
 * an avatar here has to be uploaded under that name for others to find it.
 * The classic avatars and icons are a separate store: one uploaded one way is
 * not found the other.
 */

import { createHash } from "node:crypto";
import {
  asChannelID,
  avatarFileName,
  iconFileName,
  iconIDOf,
  updateClient,
} from "@honeybbq/teamspeak";
import type { CommandOptions, IconID, UID } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import { S3TransferError } from "../errors.js";
import { deleteS3File, downloadS3File, uploadS3File } from "./s3.js";
import type { S3TransferOptions } from "./s3.js";

/** Options for the S3 avatar and icon transfers: the commands' and the requests'. */
export interface S3AvatarOptions extends CommandOptions, S3TransferOptions {}

const CHANNEL_ZERO = asChannelID(0n);

/** The bytes at `path` in channel 0, or undefined when the storage has no file there. */
async function download(
  client: Client,
  path: string,
  options: S3AvatarOptions,
): Promise<Uint8Array | undefined> {
  try {
    return await downloadS3File(client, CHANNEL_ZERO, path, options);
  } catch (error) {
    if (error instanceof S3TransferError && error.status === 404) return undefined;
    throw error;
  }
}

/**
 * Upload `data` as this client's avatar over S3 and set `client_flag_avatar`
 * to its MD5, so that other clients see the change in a `clientUpdated` event.
 * Returns the MD5, lower-case hex.
 *
 * On the wire: an upload signed for `/<avatarFileName(uid)>` in channel 0, the
 * bytes to the storage, the server told the upload is done, then
 * `clientupdate client_flag_avatar=<md5>`. An avatar already there is replaced.
 *
 * The size limit is the permission `i_client_max_avatar_filesize`, 200000
 * bytes by default; over it, the signing is refused with 2049 (invalid file
 * permissions) and nothing is sent or changed. A file of exactly the limit
 * passes.
 */
export async function uploadS3Avatar(
  client: Client,
  data: Uint8Array,
  options: S3AvatarOptions = {},
): Promise<string> {
  const md5 = createHash("md5").update(data).digest("hex");
  await uploadS3File(client, CHANNEL_ZERO, `/${avatarFileName(client.uid)}`, data, options);
  await updateClient(client, { avatar: md5 }, options);
  return md5;
}

/**
 * The bytes of the S3 avatar of the client with this unique id, or undefined
 * when the storage has none for it (a download of `/<avatarFileName(uid)>` in
 * channel 0, answered 404).
 */
export function downloadS3Avatar(
  client: Client,
  uid: UID | string,
  options: S3AvatarOptions = {},
): Promise<Uint8Array | undefined> {
  return download(client, `/${avatarFileName(uid)}`, options);
}

/**
 * Remove this client's own S3 avatar: delete `/<avatarFileName(uid)>` in
 * channel 0, then empty `client_flag_avatar`, which the delete leaves as it
 * was. A client may delete its own avatar only: another's is refused with 2568.
 * Resolves whether or not there was an avatar, as the storage's delete does.
 */
export async function removeS3Avatar(client: Client, options: CommandOptions = {}): Promise<void> {
  await deleteS3File(client, CHANNEL_ZERO, `/${avatarFileName(client.uid)}`, options);
  await updateClient(client, { avatar: "" }, options);
}

/**
 * Upload `data` as an icon over S3 and return its id, the CRC-32 of the bytes
 * ({@link iconIDOf}): an upload signed for `/icon_<id>` in channel 0, the
 * bytes to the storage, and the server told the upload is done. Pass the id to
 * `setChannelIcon`, `setServerGroupIcon`, `setChannelGroupIcon`,
 * `setClientIcon` or `setServerIcon`.
 *
 * Needs `b_icon_manage`, and the size limit is `i_max_icon_filesize`, 8192
 * bytes for a Server Admin: without the one, or over the other, the signing is
 * refused with 2049 (invalid file permissions).
 */
export async function uploadS3Icon(
  client: Client,
  data: Uint8Array,
  options: S3AvatarOptions = {},
): Promise<IconID> {
  const id = iconIDOf(data);
  await uploadS3File(client, CHANNEL_ZERO, iconFileName(id), data, options);
  return id;
}

/** The bytes of an S3 icon, or undefined when the storage has no file for the id. */
export function downloadS3Icon(
  client: Client,
  id: IconID,
  options: S3AvatarOptions = {},
): Promise<Uint8Array | undefined> {
  return download(client, iconFileName(id), options);
}

/**
 * Delete an S3 icon's file (`/icon_<id>` in channel 0). Needs `b_icon_manage`
 * (2568 without it). A channel, group or client that still names the icon
 * keeps the id; deleting a file that is not there succeeds.
 */
export async function deleteS3Icon(
  client: Client,
  id: IconID,
  options: CommandOptions = {},
): Promise<void> {
  await deleteS3File(client, CHANNEL_ZERO, iconFileName(id), options);
}
