import type { Socket as UdpSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { Crypt } from "../crypto/crypt.js";
import { EAX } from "../crypto/eax.js";
import { generateIdentity } from "../crypto/identity.js";
import { PacketHandler } from "./handler.js";
import { PacketType, packetType } from "./packet.js";

const PAYLOAD = Uint8Array.of(0, 1, 0, 2, 0, 4, 1);

/** A UDP socket stand-in: records what the client sends, delivers what the test injects. */
class FakeSocket {
  readonly sent: Uint8Array[] = [];
  #message: Array<(msg: Buffer) => void> = [];

  send(data: Uint8Array, callback: (err: Error | null) => void): void {
    this.sent.push(Uint8Array.from(data));
    callback(null);
  }

  close(): void {}

  on(event: string, listener: (msg: Buffer) => void): this {
    if (event === "message") this.#message.push(listener);
    return this;
  }

  deliver(datagram: Uint8Array): void {
    for (const listener of this.#message) listener(Buffer.from(datagram));
  }
}

/** A packet the server sealed with the session key of `generation`. */
function serverPacket(
  crypt: Crypt,
  type: PacketType,
  id: number,
  generation: number,
  payload: Uint8Array = PAYLOAD,
): Uint8Array {
  const header = Uint8Array.of((id >> 8) & 0xff, id & 0xff, type);
  const [key, nonce] = crypt.getKeyNonce(true, id, generation, type, false);
  const [ciphertext, tag] = new EAX(key).encrypt(nonce, header, payload);
  const out = new Uint8Array(8 + header.length + ciphertext.length);
  out.set(tag.subarray(0, 8), 0);
  out.set(header, 8);
  out.set(ciphertext, 11);
  return out;
}

function session(): { handler: PacketHandler; socket: FakeSocket; crypt: Crypt } {
  const crypt = new Crypt(generateIdentity(0));
  crypt.setSharedSecret(
    new Uint8Array(10).fill(7),
    new Uint8Array(54).fill(9),
    new Uint8Array(20).fill(3),
  );
  const handler = new PacketHandler(crypt);
  const socket = new FakeSocket();
  handler.start(socket as unknown as UdpSocket);
  return { handler, socket, crypt };
}

/** Ids through two wraps, each step well inside half the id space. */
const TWO_WRAPS: Array<[id: number, generation: number]> = [
  [65535, 0],
  [0, 1],
  [30000, 1],
  [60000, 1],
  [0, 2],
  [1, 2],
];

describe("non-command receive generations", () => {
  for (const { name, type } of [
    { name: "voice", type: PacketType.Voice },
    { name: "whisper", type: PacketType.VoiceWhisper },
    { name: "pong", type: PacketType.Pong },
  ]) {
    it(`decrypts ${name} across two 16-bit packet id wraps`, () => {
      const { handler, socket, crypt } = session();
      const delivered: Array<[number, number]> = [];
      handler.onPacket = (p) => delivered.push([p.id, p.generationID]);

      for (const [id, gen] of TWO_WRAPS) socket.deliver(serverPacket(crypt, type, id, gen));

      expect(delivered).toEqual(TWO_WRAPS);
      handler.close();
    });
  }

  it("answers ping across two 16-bit packet id wraps", () => {
    const { handler, socket, crypt } = session();
    const pongs = (): number =>
      socket.sent.filter((data) => ((data[12]! & 0x0f) as PacketType) === PacketType.Pong).length;

    for (const [id, gen] of TWO_WRAPS) {
      socket.deliver(serverPacket(crypt, PacketType.Ping, id, gen, new Uint8Array(0)));
    }

    expect(pongs()).toBe(TWO_WRAPS.length);
    handler.close();
  });

  it("decrypts voice after a long loss across the wrap, and a late packet before it", () => {
    const { handler, socket, crypt } = session();
    const delivered: number[] = [];
    handler.onPacket = (p) => delivered.push(p.id);

    // 2000 packets lost across 65535 -> 0, then one from before the wrap.
    socket.deliver(serverPacket(crypt, PacketType.Voice, 64000, 0));
    socket.deliver(serverPacket(crypt, PacketType.Voice, 464, 1));
    socket.deliver(serverPacket(crypt, PacketType.Voice, 65530, 0));
    socket.deliver(serverPacket(crypt, PacketType.Voice, 465, 1));

    expect(delivered).toEqual([64000, 464, 65530, 465]);
    handler.close();
  });

  it("advances packet-type streams independently", () => {
    const { handler, socket, crypt } = session();
    const delivered: PacketType[] = [];
    handler.onPacket = (p) => delivered.push(packetType(p));

    for (const [id, gen] of TWO_WRAPS)
      socket.deliver(serverPacket(crypt, PacketType.Voice, id, gen));
    socket.deliver(serverPacket(crypt, PacketType.VoiceWhisper, 7, 0));

    expect(delivered).toEqual([...TWO_WRAPS.map(() => PacketType.Voice), PacketType.VoiceWhisper]);
    handler.close();
  });
});
