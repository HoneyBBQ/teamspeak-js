import { createHash } from "node:crypto";
import { buildCommandOrdered, buildCommand } from "../core/internal.js";
import { sign, generateTemporaryKey } from "./crypto/primitives.js";
import { identityPrivateKey } from "./crypto/identity.js";
import { parseServerCapabilities } from "./capabilities.js";
import { cryptoInit2 } from "./handshake/crypt-init2.js";
import { PacketType } from "./transport/packet.js";
import type { ClientVersion } from "@honeybbq/teamspeak";
import type { ClientInternals } from "./client.js";

/** Handle the `clientinitiv` message (P-256 based crypto path). */
export function handleHandshakeInitIV(
  client: ClientInternals,
  params: Record<string, string>,
): void {
  const alpha = params["alpha"] ?? "";
  const beta = params["beta"] ?? "";
  const omega = params["omega"] ?? "";

  client.handler.receivedFinalInitAck();
  client.crypt.initCrypto(alpha, beta, omega);
  client.markHandshakeDone(omega);
  client.logger.info("crypto initialized (P-256 path), sending clientinit");
  sendClientInit(client);
}

/** Handle the `initivexpand2` message (Ed25519 / TS3 crypto path). */
export function handleHandshakeExpand2(
  client: ClientInternals,
  params: Record<string, string>,
): void {
  client.logger.info("received initivexpand2");
  client.handler.receivedFinalInitAck();

  const license = params["l"] ?? "";
  const omega = params["omega"] ?? "";
  const proof = params["proof"] ?? "";
  const beta = params["beta"] ?? "";

  const privateKey = sendClientEkPacket(client, beta);
  cryptoInit2(client.crypt, license, omega, proof, beta, privateKey);
  client.markHandshakeDone(omega);
  sendClientInit(client);
}

/** Handle `initserver` — marks the client as connected. */
export function handleInitServer(client: ClientInternals, params: Record<string, string>): void {
  const idStr = params["aclid"] ?? params["clid"] ?? "";
  const clid = idStr ? parseInt(idStr, 10) : 0;

  if (clid > 0) {
    client.clid = clid;
    client.handler.setClientID(clid);
  }

  // initserver is the only place the server names itself, and it determines how
  // the server hashes our public key into client_unique_identifier: SHA-1 on
  // TS3, SHA-256 on TS6. Recording the whole capability set here keeps callers
  // from re-deriving it, or assuming one server generation.
  client.capabilities = parseServerCapabilities(params);

  client.logger.info("connected to server", { selfId: client.clid });
  client.markConnected(params);

  // Inform the server about mute state
  setImmediate(() => {
    const updateCmd = buildCommand("clientupdate", {
      client_input_muted: "0",
      client_output_muted: "0",
    });
    client.execNoWait(updateCmd).catch(() => {});
  });
}

function sendClientEkPacket(client: ClientInternals, beta: string): Uint8Array {
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

function buildClientEkProof(client: ClientInternals, publicKey: Uint8Array, beta: string): string {
  const betaBytes = Buffer.from(beta, "base64");
  const toSign = new Uint8Array(86);
  toSign.set(publicKey.subarray(0, 32));
  toSign.set(betaBytes.subarray(0, Math.min(54, betaBytes.length)), 32);
  const sig = sign(identityPrivateKey(client.crypt.identity), toSign);
  return Buffer.from(sig).toString("base64");
}

/**
 * Encode a password field for the command protocol.
 *
 * TeamSpeak expects password fields as base64(sha1(password)) — server and
 * channel passwords during the handshake, the `clientmove` channel password,
 * and the `cpw` field of the file transfer commands. Sending the plain text
 * instead makes the server reject correct passwords with error 781.
 */
export function prepareClientPassword(password: string): string {
  if (password === "") return "";
  return createHash("sha1").update(password).digest().toString("base64");
}

/**
 * The version `clientinit` sends unless the `version` option says otherwise.
 *
 * A literal on purpose: `@honeybbq/teamspeak/versions` holds over a thousand
 * constants, and the client must not load them. A test holds this equal to the
 * table's `Windows_3_X_X_5680278000`.
 */
export const defaultClientVersion: ClientVersion = {
  platform: "Windows",
  version: "3.?.? [Build: 5680278000]",
  sign: "DX5NIYLvfJEUjuIbCidnoeozxIDRRkpq3I9vVMBmE9L2qnekOoBzSenkzsg2lC9CMv8K5hkEzhr2TYUYSwUXCg==",
};

export function sendClientInit(client: ClientInternals): void {
  const cmd = buildClientInitCommand(client);
  client.handler.sendPacket(PacketType.Command, Buffer.from(cmd), 0);
}

function buildClientInitCommand(client: ClientInternals): string {
  const pubKeyBase64 = client.crypt.identity.publicKey();
  const initOptions = client.initOptions;
  // HWID should match TS3 client UID format: base64(SHA1(publicKey()))
  const hwid = createHash("sha1").update(pubKeyBase64).digest().toString("base64");

  return buildCommandOrdered("clientinit", [
    ["client_nickname", client.requestedNickname],
    ["client_version", initOptions.version.version],
    ["client_platform", initOptions.version.platform],
    ["client_input_hardware", "1"],
    ["client_output_hardware", "1"],
    ["client_default_channel", initOptions.defaultChannel],
    ["client_default_channel_password", initOptions.defaultChannelPasswordHash],
    ["client_server_password", initOptions.serverPasswordHash],
    ["client_meta_data", initOptions.metaData],
    ["client_version_sign", initOptions.version.sign],
    ["client_key_offset", String(client.crypt.identity.offset)],
    ["client_nickname_phonetic", ""],
    ["client_default_token", initOptions.privilegeKey],
    ["hwid", hwid],
  ]);
}
