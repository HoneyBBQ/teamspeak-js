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
import type { ChannelID, ClientID, CommandOptions } from "@honeybbq/teamspeak";

/**
 * The channel's description, which `listChannels` omits for bandwidth. The
 * server answers with a `notifychanneledited` that the client does not report as
 * a `channelEdited` event, since it is no edit.
 */
export async function getChannelDescription(
  client: Client,
  cid: ChannelID,
  options?: CommandOptions,
): Promise<string> {
  const rows = await client.send(
    { command: "channelgetdescription", params: [["cid", cid]] },
    options,
  );
  // The answer is the row that holds the text. Another `notifychanneledited`
  // can arrive while the command waits, a real edit with other properties,
  // and the first row is then not the answer.
  const answer = rows.find((row) => row["cid"] === String(cid) && "channel_description" in row);
  return answer?.["channel_description"] ?? "";
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

/** The clients of a mute, one `clid` row each; an empty list sends nothing. */
async function sendMute(
  client: Client,
  command: "clientmute" | "clientunmute",
  clientIDs: readonly ClientID[],
  options?: CommandOptions,
): Promise<void> {
  if (clientIDs.length === 0) return;
  await client.send({ command, rows: clientIDs.map((clid) => [["clid", clid]]) }, options);
}

/**
 * Stop hearing the given clients (`clientmute`): the server no longer forwards
 * their voice to this client. It is per listener, so everyone else still hears
 * them, and it sends no notification and changes no client property. Several
 * clients go in one command. The server accepts this client's own id and ids
 * of clients that are not connected without an error. Undo it with
 * `unmuteClients`. Measured on TeamSpeak 3 and 6.
 */
export function muteClients(
  client: Client,
  clientIDs: readonly ClientID[],
  options?: CommandOptions,
): Promise<void> {
  return sendMute(client, "clientmute", clientIDs, options);
}

/**
 * Hear the given clients again (`clientunmute`): the server resumes forwarding
 * their voice to this client after `muteClients`. Measured on TeamSpeak 3 and 6.
 */
export function unmuteClients(
  client: Client,
  clientIDs: readonly ClientID[],
  options?: CommandOptions,
): Promise<void> {
  return sendMute(client, "clientunmute", clientIDs, options);
}
