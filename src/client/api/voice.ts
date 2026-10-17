/**
 * Commands only the voice protocol has.
 *
 * ServerQuery has no subscriptions — a query client hears every channel's
 * events once it registers for them — and no `channelgetdescription`, since its
 * `channelinfo` already carries the description. These run on the voice
 * client alone, which is why they take one rather than any CommandExecutor.
 */

import type { Client } from "../client.js";
import { ErrorCode, ServerError } from "@honeybbq/teamspeak";
import type { ChannelID, CommandOptions } from "@honeybbq/teamspeak";

/** The channel's description, which `listChannels` omits for bandwidth. */
export async function getChannelDescription(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<string> {
  const rows = await client.send(
    { command: "channelgetdescription", params: [["cid", cid]] },
    options,
  );
  return rows[0]?.["channel_description"] ?? "";
}

/**
 * Subscribe to a channel: receive its clients' events and voice without
 * joining it.
 */
export async function subscribeChannel(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelsubscribe", params: [["cid", cid]] }, options);
}

/** Stop receiving a subscribed channel's events and voice. */
export async function unsubscribeChannel(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelunsubscribe", params: [["cid", cid]] }, options);
}

/** Subscribe to every channel on the server. */
export async function subscribeAllChannels(
  client: Client,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelsubscribeall" }, options);
}

/** Unsubscribe from every channel on the server. */
export async function unsubscribeAllChannels(
  client: Client,
  options?: CommandOptions,
): Promise<void> {
  await client.send({ command: "channelunsubscribeall" }, options);
}

/** Answers a password check: true for a match, false for the mismatch error, any other error rethrown. */
async function passwordMatches(run: () => Promise<unknown>, mismatch: number): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof ServerError && error.code === mismatch) return false;
    throw error;
  }
}

/**
 * Whether `password` is the server's password (`verifyserverpassword`),
 * without joining. The password is given in cleartext; the client hashes it
 * on the wire. The server answers a match with plain success and a mismatch
 * with error 1028 (`ErrorCode.ServerInvalidPassword`), which this turns into
 * `false`; any other error is thrown. Measured on TeamSpeak 3 and 6.
 */
export function verifyServerPassword(
  client: Client,
  password: string,
  options?: CommandOptions,
): Promise<boolean> {
  return passwordMatches(
    () =>
      client.send(
        {
          command: "verifyserverpassword",
          params: [["password", password]],
          passwords: ["password"],
        },
        options,
      ),
    ErrorCode.ServerInvalidPassword,
  );
}

/**
 * Whether `password` is channel `cid`'s password (`verifychannelpassword`),
 * without moving. The password is given in cleartext; the client hashes it
 * on the wire, as `moveClient` does. A mismatch is error 781
 * (`ErrorCode.ChannelInvalidPassword`) and answers `false`; a channel without
 * a password accepts any value and answers `true`; an unknown channel is
 * error 768, thrown. Measured on TeamSpeak 3 and 6.
 */
export function verifyChannelPassword(
  client: Client,
  cid: ChannelID,
  password: string,
  options?: CommandOptions,
): Promise<boolean> {
  return passwordMatches(
    () =>
      client.send(
        {
          command: "verifychannelpassword",
          params: [
            ["cid", cid],
            ["password", password],
          ],
          passwords: ["password"],
        },
        options,
      ),
    ErrorCode.ChannelInvalidPassword,
  );
}
