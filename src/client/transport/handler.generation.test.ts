import { describe, expect, it } from "vitest";
import { Crypt } from "../crypto/crypt.js";
import { generateIdentitySync } from "../crypto/identity.js";
import { FakeSocket, completeCryptoInit, sessionPacket } from "../testing/fake-server.js";
import { PacketHandler } from "./handler.js";
import { PacketType, packetType } from "./packet.js";

const PAYLOAD = Uint8Array.of(0, 1, 0, 2, 0, 4, 1);

function session(): {
  handler: PacketHandler;
  socket: FakeSocket;
  crypt: Crypt;
} {
  const crypt = new Crypt(generateIdentitySync(0));
  completeCryptoInit(crypt);
  const handler = new PacketHandler(crypt);
  const socket = new FakeSocket();
  handler.start(socket);

  return { handler, socket, crypt };
}

describe("non-command receive generations", () => {
  for (const { name, type } of [
    { name: "voice", type: PacketType.Voice },
    { name: "whisper", type: PacketType.VoiceWhisper },
    { name: "pong", type: PacketType.Pong },
  ]) {
    it(`decrypts ${name} across the 16-bit packet id wrap`, () => {
      const { handler, socket, crypt } = session();
      const delivered: number[] = [];
      handler.onPacket = (p) => delivered.push(p.generationID);

      socket.deliver(sessionPacket(crypt, type, 0, 65535, PAYLOAD, 0));
      socket.deliver(sessionPacket(crypt, type, 0, 0, PAYLOAD, 1));

      expect(delivered).toEqual([0, 1]);
      handler.close();
    });
  }

  it("answers ping across the 16-bit packet id wrap", () => {
    const { handler, socket, crypt } = session();
    const pongs = (): number =>
      socket.sent.filter((data) => ((data[12]! & 0x0f) as PacketType) === PacketType.Pong).length;

    socket.deliver(sessionPacket(crypt, PacketType.Ping, 0, 65535, new Uint8Array(0), 0));
    socket.deliver(sessionPacket(crypt, PacketType.Ping, 0, 0, new Uint8Array(0), 1));

    expect(pongs()).toBe(2);
    handler.close();
  });

  it("does not let a wrong-generation packet advance the window", () => {
    const { handler, socket, crypt } = session();
    const delivered: number[] = [];
    handler.onPacket = (p) => delivered.push(p.generationID);

    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 65535, PAYLOAD, 0));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 0, PAYLOAD, 0));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 0, PAYLOAD, 1));

    expect(delivered).toEqual([0, 1]);
    handler.close();
  });

  it("decrypts voice after a long loss across the wrap, and a late packet before it", () => {
    const { handler, socket, crypt } = session();
    const delivered: Array<[number, number]> = [];
    handler.onPacket = (p) => delivered.push([p.id, p.generationID]);

    // 2000 packets lost, more than a command window holds, across 65535 -> 0.
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 64000, PAYLOAD, 0));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 464, PAYLOAD, 1));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 65530, PAYLOAD, 0));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 465, PAYLOAD, 1));

    expect(delivered).toEqual([
      [64000, 0],
      [464, 1],
      [65530, 0],
      [465, 1],
    ]);
    handler.close();
  });

  it("advances packet-type streams independently", () => {
    const { handler, socket, crypt } = session();
    const delivered: PacketType[] = [];
    handler.onPacket = (p) => delivered.push(packetType(p));

    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 65535, PAYLOAD, 0));
    socket.deliver(sessionPacket(crypt, PacketType.Voice, 0, 7, PAYLOAD, 1));
    socket.deliver(sessionPacket(crypt, PacketType.VoiceWhisper, 0, 7, PAYLOAD, 0));

    expect(delivered).toEqual([PacketType.Voice, PacketType.Voice, PacketType.VoiceWhisper]);
    handler.close();
  });
});
