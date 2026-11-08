/**
 * Reading the file list a TeamSpeak 6 server sends for `s3ft_list_files`.
 */

import { NoDataError } from "@honeybbq/teamspeak";
import type { S3FileEntry } from "./s3.js";

/**
 * The file list the server sends: base64 of the JSON
 * `{"contents":[{"key":"dir/a.txt","last_modified":"…","size":2}]}`, each key
 * from the channel's root without a leading slash, and an empty field for no
 * files.
 */
export function parseFileList(field: string): S3FileEntry[] {
  if (field === "") return [];
  const malformed = (): NoDataError =>
    new NoDataError(
      "s3ft_list_files",
      "the server answered s3ft_list_files with a malformed file list",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(field, "base64").toString("utf8"));
  } catch {
    throw malformed();
  }
  const contents = (parsed as { contents?: unknown } | null)?.contents;
  if (!Array.isArray(contents)) throw malformed();
  return contents.map((item: unknown): S3FileEntry => {
    const entry = item as { key?: unknown; size?: unknown; last_modified?: unknown } | null;
    const key = entry?.key;
    const size = entry?.size;
    if (
      typeof key !== "string" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw malformed();
    }
    const time =
      typeof entry?.last_modified === "string" ? new Date(entry.last_modified) : undefined;
    return {
      path: key.startsWith("/") ? key : `/${key}`,
      size: BigInt(size),
      modifiedAt: time === undefined || Number.isNaN(time.getTime()) ? undefined : time,
    };
  });
}
