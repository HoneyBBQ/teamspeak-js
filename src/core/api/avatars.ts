/**
 * Avatar file names.
 *
 * An avatar is a file in channel 0's file area, and the server does not keep it
 * under the name it was uploaded with: it renames the file after the client
 * that owns it. See `uploadAvatar` and `downloadAvatar` in the client entry
 * point for the transfer itself.
 */

import type { UID } from "../command/ids.js";

/** The letters a nibble is spelled with: `a` for 0 up to `p` for 15. */
const NIBBLE_LETTERS = "abcdefghijklmnop";

/**
 * The name the server stores a client's avatar under, in channel 0's file
 * area, without a leading slash: `avatar_` followed by the client's unique id
 * spelled in the letters `a` to `p`.
 *
 * The unique id is base64 of a hash of the client's public key, 20 bytes
 * (SHA-1) on TeamSpeak 3 and 32 bytes (SHA-256) on TeamSpeak 6. Each byte
 * becomes two letters, its high nibble first, each nibble `a` plus its value.
 * The name is therefore 40 letters on TeamSpeak 3 and 64 on TeamSpeak 6. It is
 * the same value the server reports as `client_base64HashClientUID`.
 *
 * It is never the MD5 name an avatar is uploaded under (`/avatar_<md5>`), so
 * downloading by that name fails: with 2051 on TeamSpeak 6, 2054 on
 * TeamSpeak 3. Throws a TypeError for a unique id that is not base64.
 */
export function avatarFileName(uid: UID | string): string {
  if (uid === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(uid)) {
    throw new TypeError("a unique id is base64 text");
  }
  let letters = "";
  for (const char of atob(uid)) {
    const byte = char.charCodeAt(0);
    letters += NIBBLE_LETTERS[byte >> 4]! + NIBBLE_LETTERS[byte & 15]!;
  }
  return `avatar_${letters}`;
}
