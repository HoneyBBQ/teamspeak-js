import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket as UdpSocket } from "node:dgram";
import { PacketHandler } from "./handler.js";
import { MAX_VOICE_FRAME_SIZE } from "../index.js";
import { Crypt } from "../crypto/crypt.js";
import { generateIdentitySync } from "../crypto/identity.js";

const TAG_SIZE = 8;
const HEADER_SIZE = 5;

/** A UDP socket stand-in that records every datagram the handler writes. */
function fakeSocket(): { socket: UdpSocket; sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  const emitter = new EventEmitter() as unknown as UdpSocket & { sent: Uint8Array[] };
  (emitter as unknown as { send: unknown }).send = (buf: Buffer) => {
    sent.push(new Uint8Array(buf));
  };
  (emitter as unknown as { close: unknown }).close = () => {};
  return { socket: emitter, sent };
}

function newHandler(): { handler: PacketHandler; sent: Uint8Array[] } {
  const { socket, sent } = fakeSocket();
  const handler = new PacketHandler(new Crypt(generateIdentitySync(1)));
  handler.start(socket);
  handler.setClientID(0x1234);
  sent.length = 0; // discard the init1 packet start() emits
  return { handler, sent };
}

const voiceID = (d: Uint8Array): number => {
  const p = d.subarray(TAG_SIZE + HEADER_SIZE);
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(0, false);
};

describe("sendVoicePacket", () => {
  it("exports MAX_VOICE_FRAME_SIZE as 500 minus tag, header and voice header", () => {
    expect(MAX_VOICE_FRAME_SIZE).toBe(500 - TAG_SIZE - HEADER_SIZE - 3);
    expect(MAX_VOICE_FRAME_SIZE).toBe(484);
  });

  it("sends a 484-byte frame as a 500-byte datagram, the largest a packet may be", () => {
    const { handler, sent } = newHandler();

    handler.sendVoicePacket(new Uint8Array(484), 5);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.length).toBe(500);
  });

  it("refuses a frame over 484 bytes, which the server would drop", () => {
    const { handler, sent } = newHandler();

    expect(() => handler.sendVoicePacket(new Uint8Array(485), 5)).toThrow(RangeError);
    expect(() => handler.sendVoicePacket(new Uint8Array(633), 5)).toThrow(/at most 484 bytes/);
    expect(sent).toHaveLength(0);
  });

  it("does not use up a voice id on a refused frame", () => {
    const { handler, sent } = newHandler();

    handler.sendVoicePacket(new Uint8Array(10), 5);
    expect(() => handler.sendVoicePacket(new Uint8Array(485), 5)).toThrow(RangeError);
    handler.sendVoicePacket(new Uint8Array(10), 5);

    // A skipped id would look like a lost packet to the server and to listeners.
    expect(voiceID(sent[1]!) - voiceID(sent[0]!)).toBe(1);
  });

  it("still sends the empty frame that ends speech", () => {
    const { handler, sent } = newHandler();

    handler.sendVoicePacket(new Uint8Array(0), 5);

    expect(sent).toHaveLength(1);
  });
});
