import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket as UdpSocket } from "node:dgram";
import { PacketHandler } from "./handler.js";
import { Crypt } from "../crypto/crypt.js";
import { generateIdentitySync } from "../crypto/identity.js";
import { type Packet, PacketType, PacketFlags, packetType, packetFlags } from "./packet.js";

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

describe("sendWhisperPacket", () => {
  it("frames a whisper as VoiceWhisper with 0 channel targets and N client targets", () => {
    const { handler, sent } = newHandler();
    const audio = new Uint8Array([0xaa, 0xbb, 0xcc]);

    handler.sendWhisperPacket(audio, [0x0102, 0x0304], 5);

    expect(sent).toHaveLength(1);
    const datagram = sent[0]!;
    const header = datagram.subarray(TAG_SIZE, TAG_SIZE + HEADER_SIZE);
    const payload = datagram.subarray(TAG_SIZE + HEADER_SIZE);

    // The type byte is the last header byte: low 4 bits type, high 4 bits flags.
    const packet = { typeFlagged: header[HEADER_SIZE - 1]! } as Packet;
    expect(packetType(packet)).toBe(PacketType.VoiceWhisper);
    expect(packetFlags(packet) & PacketFlags.Unencrypted).toBe(PacketFlags.Unencrypted);

    // Payload layout: u16 voiceID, u8 codec, u8 channelCount, u8 clientCount,
    // then clientCount * u16 client IDs, then the Opus frame.
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    expect(view.getUint16(0, false)).toBe(0); // first voice packet of the session
    expect(payload[2]).toBe(5); // codec
    expect(payload[3]).toBe(0); // no channel targets
    expect(payload[4]).toBe(2); // two client targets
    expect(view.getUint16(5, false)).toBe(0x0102);
    expect(view.getUint16(7, false)).toBe(0x0304);
    expect([...payload.subarray(9)]).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it("increments the voice ID per whisper independently of the counter start", () => {
    const { handler, sent } = newHandler();
    const audio = new Uint8Array([1]);

    handler.sendWhisperPacket(audio, [7], 5);
    handler.sendWhisperPacket(audio, [7], 5);

    const voiceID = (d: Uint8Array): number => {
      const p = d.subarray(TAG_SIZE + HEADER_SIZE);
      return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(0, false);
    };
    expect(voiceID(sent[1]!) - voiceID(sent[0]!)).toBe(1);
  });

  it("rejects target lists that TeamSpeak cannot encode", () => {
    const { handler } = newHandler();
    const audio = new Uint8Array([1]);

    expect(() => handler.sendWhisperPacket(audio, [], 5)).toThrow(/at least one target/);
    expect(() =>
      handler.sendWhisperPacket(
        audio,
        Array.from({ length: 33 }, (_, i) => i + 1),
        5,
      ),
    ).toThrow(/at most 32 client targets/);
    expect(() => handler.sendWhisperPacket(audio, [0x10000], 5)).toThrow(RangeError);
    expect(() => handler.sendWhisperPacket(audio, [-1], 5)).toThrow(RangeError);
  });
});

describe("sendWhisperPacket with channels", () => {
  it("writes the channel ids as u64 before the client ids, with the new-protocol flag unset", () => {
    const { handler, sent } = newHandler();
    handler.sendWhisperPacket(new Uint8Array([0xaa]), [0x0102], 5, [0x1122334455667788n, 9n]);

    const datagram = sent[0]!;
    const header = datagram.subarray(TAG_SIZE, TAG_SIZE + HEADER_SIZE);
    const payload = datagram.subarray(TAG_SIZE + HEADER_SIZE);
    expect(header[HEADER_SIZE - 1]).toBe(PacketType.VoiceWhisper | PacketFlags.Unencrypted);
    expect([...payload]).toEqual([
      0,
      0, // voice id
      5, // codec
      2, // channels
      1, // clients
      0x11,
      0x22,
      0x33,
      0x44,
      0x55,
      0x66,
      0x77,
      0x88,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      9,
      0x01,
      0x02,
      0xaa,
    ]);
  });

  it("accepts channels alone and rejects counts a byte cannot hold", () => {
    const { handler, sent } = newHandler();
    const audio = new Uint8Array([1]);
    handler.sendWhisperPacket(audio, [], 5, [3n]);
    expect(sent).toHaveLength(1);
    expect(() => handler.sendWhisperPacket(audio, [], 5, [])).toThrow(/at least one target/);
    expect(() =>
      handler.sendWhisperPacket(
        audio,
        [],
        5,
        Array.from({ length: 256 }, (_, i) => BigInt(i)),
      ),
    ).toThrow(/at most 255 channel targets/);
    expect(() => handler.sendWhisperPacket(audio, [], 5, [-1n])).toThrow(RangeError);
    expect(() => handler.sendWhisperPacket(audio, [], 5, [1n << 64n])).toThrow(RangeError);
  });
});

describe("sendGroupWhisperPacket", () => {
  it("frames the group form with the new-protocol flag set", () => {
    const { handler, sent } = newHandler();
    handler.sendGroupWhisperPacket(new Uint8Array([0xaa, 0xbb]), 0, 4, 0x0102030405060708n, 5);

    const datagram = sent[0]!;
    const header = datagram.subarray(TAG_SIZE, TAG_SIZE + HEADER_SIZE);
    const payload = datagram.subarray(TAG_SIZE + HEADER_SIZE);
    expect(header[HEADER_SIZE - 1]).toBe(
      PacketType.VoiceWhisper | PacketFlags.Unencrypted | PacketFlags.NewProtocol,
    );
    expect(header[HEADER_SIZE - 1]).toBe(0xa1);
    expect([...payload]).toEqual([
      0,
      0, // voice id
      5, // codec
      0, // GroupWhisperType: server group
      4, // GroupWhisperTarget: channel family
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8, // u64 id
      0xaa,
      0xbb,
    ]);
  });

  it("numbers the group form from the same counter as the direct form", () => {
    const { handler, sent } = newHandler();
    handler.sendWhisperPacket(new Uint8Array([1]), [7], 5);
    handler.sendGroupWhisperPacket(new Uint8Array([1]), 3, 0, 0n, 5);
    const id = (d: Uint8Array): number =>
      new DataView(d.buffer, d.byteOffset).getUint16(TAG_SIZE + HEADER_SIZE, false);
    expect(id(sent[1]!) - id(sent[0]!)).toBe(1);
  });

  it("rejects values the packet cannot hold", () => {
    const { handler } = newHandler();
    const a = new Uint8Array([1]);
    expect(() => handler.sendGroupWhisperPacket(a, 256, 0, 0n, 5)).toThrow(RangeError);
    expect(() => handler.sendGroupWhisperPacket(a, 0, -1, 0n, 5)).toThrow(RangeError);
    expect(() => handler.sendGroupWhisperPacket(a, 0, 0, -1n, 5)).toThrow(RangeError);
    expect(() => handler.sendGroupWhisperPacket(a, 0, 0, 1n << 64n, 5)).toThrow(RangeError);
  });
});
