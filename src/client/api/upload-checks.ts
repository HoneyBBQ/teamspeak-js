/**
 * What an upload does around its data phase: stop a transfer whose connection
 * was never made, and check what the server stored once it closed the
 * connection. Shared by the file and avatar helpers; not exported from the
 * package.
 */

import { ErrorCode, ServerError, getFileInfo, stopFileTransfer } from "@honeybbq/teamspeak";
import type { ChannelID, CommandExecutor, FileUploadInfo } from "@honeybbq/teamspeak";
import { FileTransferError } from "../errors.js";
import { failedToConnect } from "../transfer.js";

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
export async function withDialCleanup(
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
export async function verifyStored(
  client: CommandExecutor,
  channelID: ChannelID,
  path: string,
  size: bigint,
  options: {
    readonly password?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly timeoutMs?: number | undefined;
  },
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
