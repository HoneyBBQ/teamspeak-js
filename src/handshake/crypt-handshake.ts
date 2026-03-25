import { randomBytes } from "node:crypto";
import { buildCommandOrdered } from "../command/command.js";
import type { Crypt } from "../crypto/crypt.js";

export const INIT_VERSION = 1566914096; // 3.5.0 [Stable]

const INIT_VERSION_LEN = 4;
const INIT_TYPE_LEN = 1;
const INIT_STEP_LEN = 21;

/**
 * Handle the TS3INIT1 handshake steps.
 * Returns the response bytes to send, or null if nothing should be sent.
 */
export function processInit1(crypt: Crypt, data: Uint8Array | null): Uint8Array | null {
  if (data === null || (data.length >= 1 && data[0] === 0x7f)) {
    return buildInit1StartPacket();
  }

  switch (data[0]) {
    case 0:
      return buildInit1Step1Packet(data);
    case 1:
      return buildInit1Step2Packet(data);
    case 2:
      return buildInit1Step3Packet(data);
    case 3:
      return buildInit1Step4Packet(crypt, data);
    default:
      return null;
  }
}

function buildInit1StartPacket(): Uint8Array {
  const sendData = new Uint8Array(INIT_VERSION_LEN + INIT_TYPE_LEN + 4 + 4 + 8);
  const view = new DataView(sendData.buffer);

  view.setUint32(0, INIT_VERSION, false);
  sendData[4] = 0x00;

  const nowSec = Math.floor(Date.now() / 1000);
  const clampedNow = Math.max(0, Math.min(nowSec, 0xffff_ffff));
  view.setUint32(5, clampedNow, false);

  const rng = randomBytes(4);
  sendData.set(rng, 9);

  return sendData;
}

function buildInit1Step1Packet(data: Uint8Array): Uint8Array | null {
  if (data.length !== INIT_STEP_LEN) return null;

  const sendData = new Uint8Array(INIT_TYPE_LEN + 16 + 4);
  sendData[0] = 0x01;

  // TS rand: little-endian uint32 at offset [INIT_VERSION_LEN + INIT_TYPE_LEN + 4]
  const tsRandOffset = INIT_VERSION_LEN + INIT_TYPE_LEN + 4;
  const tsRand =
    data[tsRandOffset]! |
    (data[tsRandOffset + 1]! << 8) |
    (data[tsRandOffset + 2]! << 16) |
    (data[tsRandOffset + 3]! << 24);

  new DataView(sendData.buffer).setUint32(INIT_TYPE_LEN + 16, tsRand >>> 0, false);
  return sendData;
}

function buildInit1Step2Packet(data: Uint8Array): Uint8Array | null {
  if (data.length !== INIT_STEP_LEN) return null;

  const sendData = new Uint8Array(INIT_VERSION_LEN + INIT_TYPE_LEN + 16 + 4);
  new DataView(sendData.buffer).setUint32(0, INIT_VERSION, false);
  sendData[4] = 0x02;
  sendData.set(data.slice(1, 21), 5);
  return sendData;
}

function buildInit1Step3Packet(data: Uint8Array): Uint8Array | null {
  if (data.length !== INIT_VERSION_LEN + INIT_TYPE_LEN + 16 + 4) return null;

  const sendData = new Uint8Array(INIT_TYPE_LEN + 64 + 64 + 4 + 100);
  sendData[0] = 0x03;
  sendData[INIT_TYPE_LEN + 64 - 1] = 1;
  sendData[INIT_TYPE_LEN + 64 + 64 - 1] = 1;
  new DataView(sendData.buffer).setUint32(INIT_TYPE_LEN + 64 + 64, 1, false);
  return sendData;
}

function buildInit1Step4Packet(crypt: Crypt, data: Uint8Array): Uint8Array | null {
  if (data.length !== INIT_TYPE_LEN + 64 + 64 + 4 + 100) return null;

  const level = new DataView(data.buffer, data.byteOffset).getUint32(1 + 128, false);
  const y = crypt.solveRsaChallenge(data, 1, level);

  crypt.alphaTmp = new Uint8Array(randomBytes(10));

  const alphaB64 = Buffer.from(crypt.alphaTmp).toString("base64");
  const omegaB64 = crypt.identity.publicKeyBase64();

  const cmd = buildCommandOrdered("clientinitiv", [
    ["alpha", alphaB64],
    ["omega", omegaB64],
    ["ot", "1"],
    ["ip", ""],
  ]);
  const cmdBytes = Buffer.from(cmd);

  const sendData = new Uint8Array(INIT_VERSION_LEN + INIT_TYPE_LEN + 232 + 64 + cmdBytes.length);
  const view = new DataView(sendData.buffer);
  view.setUint32(0, INIT_VERSION, false);
  sendData[4] = 0x04;
  sendData.set(data.slice(1, 233), 5);
  sendData.set(y.slice(0, 64), 5 + 232);
  sendData.set(cmdBytes, 5 + 232 + 64);

  return sendData;
}
