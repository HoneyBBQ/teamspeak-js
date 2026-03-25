import { describe, it, expect } from "vitest";
import {
  type Packet,
  PacketType,
  PacketFlags,
  packetType,
  packetFlags,
  buildC2SHeader,
  parseS2CHeader,
} from "./packet.js";

function makePacket(overrides: Partial<Packet> = {}): Packet {
  return {
    typeFlagged: PacketType.Command | PacketFlags.NewProtocol,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: new Uint8Array(0),
    receivedAt: 0,
    ...overrides,
  };
}

describe("packet helpers", () => {
  it("packetType extracts low nibble", () => {
    const p = makePacket({ typeFlagged: 0x22 }); // type=2, flags=0x20
    expect(packetType(p)).toBe(PacketType.Command);
  });

  it("packetFlags extracts high nibble", () => {
    const p = makePacket({ typeFlagged: 0x82 }); // type=2, flags=0x80
    expect(packetFlags(p) & PacketFlags.Unencrypted).toBeTruthy();
  });

  it("buildC2SHeader produces 5 bytes with correct fields", () => {
    const p = makePacket({ id: 0x0102, clientID: 0x0304, typeFlagged: 0x22 });
    const header = buildC2SHeader(p);
    expect(header).toHaveLength(5);
    expect(header[0]).toBe(0x01);
    expect(header[1]).toBe(0x02);
    expect(header[2]).toBe(0x03);
    expect(header[3]).toBe(0x04);
    expect(header[4]).toBe(0x22);
  });

  it("parseS2CHeader extracts id and typeFlagged", () => {
    // S2C header is 3 bytes: id(2) typeFlagged(1)
    const raw = new Uint8Array([0x00, 0x05, 0x22]);
    const { id, typeFlagged } = parseS2CHeader(raw);
    expect(id).toBe(5);
    expect(typeFlagged).toBe(0x22);
  });
});
