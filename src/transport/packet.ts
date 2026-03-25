export const enum PacketType {
  Voice = 0,
  VoiceWhisper = 1,
  Command = 2,
  CommandLow = 3,
  Ping = 4,
  Pong = 5,
  Ack = 6,
  AckLow = 7,
  Init1 = 8,
}

export const enum PacketFlags {
  Fragmented = 0x10,
  NewProtocol = 0x20,
  Compressed = 0x40,
  Unencrypted = 0x80,
}

export interface Packet {
  /** Type byte combined with flags (low nibble = type, high nibble = flags). */
  typeFlagged: number;
  id: number;
  clientID: number;
  generationID: number;
  data: Uint8Array;
  receivedAt: number; // Date.now()
}

export function packetType(p: Packet): PacketType {
  return (p.typeFlagged & 0x0f) as PacketType;
}

export function packetFlags(p: Packet): number {
  return p.typeFlagged & 0xf0;
}

export function isUnencrypted(p: Packet): boolean {
  return (packetFlags(p) & PacketFlags.Unencrypted) !== 0;
}

/** Build the 5-byte client-to-server header: [packetID(2), clientID(2), typeFlagged(1)]. */
export function buildC2SHeader(p: Packet): Uint8Array {
  const header = new Uint8Array(5);
  const view = new DataView(header.buffer);
  view.setUint16(0, p.id, false);
  view.setUint16(2, p.clientID, false);
  header[4] = p.typeFlagged;
  return header;
}

/** Parse a 3-byte server-to-client header. */
export function parseS2CHeader(raw: Uint8Array): Pick<Packet, "id" | "typeFlagged"> {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    id: view.getUint16(0, false),
    typeFlagged: raw[2]!,
  };
}

/** Parse a 5-byte client-to-server header. */
export function parseC2SHeader(raw: Uint8Array): Pick<Packet, "id" | "clientID" | "typeFlagged"> {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    id: view.getUint16(0, false),
    clientID: view.getUint16(2, false),
    typeFlagged: raw[4]!,
  };
}
