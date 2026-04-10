import { createHash } from "node:crypto";
import { buildCommandOrdered, buildCommand } from "./command/command.js";
import { sign, generateTemporaryKey } from "./crypto/primitives.js";
import { cryptoInit2 } from "./handshake/crypt-init2.js";
import { PacketType } from "./transport/packet.js";
import type { Client } from "./client.js";

/** Handle the `clientinitiv` message (P-256 based crypto path). */
export function handleHandshakeInitIV(client: Client, params: Record<string, string>): void {
  const alpha = params["alpha"] ?? "";
  const beta = params["beta"] ?? "";
  const omega = params["omega"] ?? "";

  client.crypt.initCrypto(alpha, beta, omega);
  client.logger.info("crypto initialized (P-256 path), sending clientinit");
  sendClientInit(client);
}

/** Handle the `initivexpand2` message (Ed25519 / TS3 crypto path). */
export function handleHandshakeExpand2(client: Client, params: Record<string, string>): void {
  client.logger.info("received initivexpand2");
  client.handler.receivedFinalInitAck();

  const license = params["l"] ?? "";
  const omega = params["omega"] ?? "";
  const proof = params["proof"] ?? "";
  const beta = params["beta"] ?? "";

  const privateKey = sendClientEkPacket(client, beta);
  cryptoInit2(client.crypt, license, omega, proof, beta, privateKey);
  sendClientInit(client);
}

/** Handle `initserver` — marks the client as connected. */
export function handleInitServer(client: Client, params: Record<string, string>): void {
  const idStr = params["aclid"] ?? params["clid"] ?? "";
  const clid = idStr ? parseInt(idStr, 10) : 0;

  if (clid > 0) {
    client.clid = clid;
    client.handler.setClientID(clid);
  }

  client.logger.info("connected to server", { selfId: client.clid });
  client._markConnected();

  // Inform the server about mute state
  setImmediate(() => {
    const updateCmd = buildCommand("clientupdate", {
      client_input_muted: "0",
      client_output_muted: "0",
    });
    client.sendCommandNoWait(updateCmd).catch(() => {});
  });
}

function sendClientEkPacket(client: Client, beta: string): Uint8Array {
  const [publicKey, privateKey] = generateTemporaryKey();
  const ekBase64 = Buffer.from(publicKey).toString("base64");
  const clientProof = buildClientEkProof(client, publicKey, beta);

  const clientEk = buildCommandOrdered("clientek", [
    ["ek", ekBase64],
    ["proof", clientProof],
  ]);
  client.handler.sendPacket(PacketType.Command, Buffer.from(clientEk), 0);
  return privateKey;
}

function buildClientEkProof(client: Client, publicKey: Uint8Array, beta: string): string {
  const betaBytes = Buffer.from(beta, "base64");
  const toSign = new Uint8Array(86);
  toSign.set(publicKey.slice(0, 32));
  toSign.set(betaBytes.slice(0, Math.min(54, betaBytes.length)), 32);
  const sig = sign(client.crypt.identity.privateKey, toSign);
  return Buffer.from(sig).toString("base64");
}

export function sendClientInit(client: Client): void {
  const cmd = buildClientInitCommand(client);
  client.handler.sendPacket(PacketType.Command, Buffer.from(cmd), 0);
}

function buildClientInitCommand(client: Client): string {
  const pubKeyBase64 = client.crypt.identity.publicKeyBase64();
  const initOptions = client.getClientInitOptions();
  // HWID should match TS3 client UID format: base64(SHA1(publicKeyBase64))
  const hwid = createHash("sha1").update(pubKeyBase64).digest().toString("base64");

  return buildCommandOrdered("clientinit", [
    ["client_nickname", client.nickname],
    ["client_version", "3.?.? [Build: 5680278000]"],
    ["client_platform", "Windows"],
    ["client_input_hardware", "1"],
    ["client_output_hardware", "1"],
    ["client_default_channel", initOptions.defaultChannel],
    ["client_default_channel_password", initOptions.defaultChannelPassword],
    ["client_server_password", initOptions.serverPassword],
    ["client_meta_data", ""],
    [
      "client_version_sign",
      "DX5NIYLvfJEUjuIbCidnoeozxIDRRkpq3I9vVMBmE9L2qnekOoBzSenkzsg2lC9CMv8K5hkEzhr2TYUYSwUXCg==",
    ],
    ["client_key_offset", String(client.crypt.identity.offset)],
    ["client_nickname_phonetic", ""],
    ["client_default_token", ""],
    ["hwid", hwid],
  ]);
}
