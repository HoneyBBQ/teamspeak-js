import { buildCommandOrdered, buildCommand, unescape } from "./command/command.js";
import type { ChannelInfo, ClientInfo } from "./types.js";
import type { Client } from "./client.js";

/** Send a text message to a client (targetMode=1), channel (2), or server (3). */
export async function sendTextMessage(
  client: Client,
  targetMode: number,
  targetID: bigint,
  message: string,
): Promise<void> {
  const cmd = buildCommandOrdered("sendtextmessage", [
    ["targetmode", String(targetMode)],
    ["target", String(targetID)],
    ["msg", message],
  ]);
  await client.sendCommandNoWait(cmd);
}

/** Move a client to a different channel. */
export async function clientMove(
  client: Client,
  clid: number,
  channelID: bigint,
  password = "",
): Promise<void> {
  const params: Array<readonly [string, string]> = [
    ["clid", String(clid)],
    ["cid", String(channelID)],
  ];
  if (password) params.push(["cpw", password]);
  const cmd = buildCommandOrdered("clientmove", params);
  await client.execCommand(cmd, 10_000);
}

/** Send a poke message to a client. */
export async function poke(client: Client, clid: number, message: string): Promise<void> {
  const cmd = buildCommandOrdered("clientpoke", [
    ["clid", String(clid)],
    ["msg", message],
  ]);
  await client.execCommand(cmd, 10_000);
}

/** Fetch raw clientinfo for a given clid. */
export async function getClientInfo(client: Client, clid: number): Promise<Record<string, string>> {
  const data = await client.execCommandWithResponse(`clientinfo clid=${clid}`, 5_000);
  const row = data[0];
  if (!row) throw new Error(`no data returned for client ${clid}`);
  return row;
}

/** List all channels on the server. */
export async function listChannels(client: Client): Promise<ChannelInfo[]> {
  const data = await client.execCommandWithResponse("channellist", 5_000);
  return data.map((item) => ({
    id: BigInt(item["cid"] ?? "0"),
    parentID: BigInt(item["pid"] ?? "0"),
    name: unescape(item["channel_name"] ?? ""),
    description: "",
  }));
}

/** List all clients currently connected to the server. */
export async function listClients(client: Client): Promise<ClientInfo[]> {
  const data = await client.execCommandWithResponse("clientlist -uid -away -voice -groups", 5_000);
  return data.map((item) => {
    const groupsStr = item["client_servergroups"] ?? "";
    return {
      id: parseInt(item["clid"] ?? "0", 10),
      nickname: unescape(item["client_nickname"] ?? ""),
      uid: item["client_unique_identifier"] ?? "",
      channelID: BigInt(item["cid"] ?? "0"),
      type: parseInt(item["client_type"] ?? "0", 10),
      serverGroups: groupsStr ? groupsStr.split(",") : [],
    };
  });
}

/** Delete a file on the server. */
export async function fileTransferDeleteFile(
  client: Client,
  channelID: bigint,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const pathStr = paths.join("|");
  const cmd = buildCommand("ftdeletefile", {
    cid: String(channelID),
    cpw: "",
    name: pathStr,
  });
  await client.execCommand(cmd, 10_000);
}
