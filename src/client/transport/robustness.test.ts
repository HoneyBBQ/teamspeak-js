/**
 * How the handler behaves when the server's packets go missing: a resent
 * clientek keeps its key, a hole in the command stream ends the connection,
 * and an oversize command leaves the stream in step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crypt } from "../crypto/crypt.js";
import { generateIdentitySync } from "../crypto/identity.js";
import { ConnectionStalledError } from "../errors.js";
import { FakeSocket, completeCryptoInit, sessionPacket } from "../testing/fake-server.js";
import { processInit1 } from "../handshake/crypt-handshake.js";
import { PacketHandler } from "./handler.js";
import { PacketFlags, PacketType } from "./packet.js";

function commandsSent(socket: FakeSocket): Uint8Array[] {
  return socket.sent.filter((data) => ((data[12]! & 0x0f) as PacketType) === PacketType.Command);
}

describe("robustness of the packet handler", () => {
  let handler: PacketHandler | undefined;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "Date", "performance"],
    });
  });

  afterEach(() => {
    handler?.close();
    handler = undefined;
    vi.useRealTimers();
  });

  function session(): {
    handler: PacketHandler;
    socket: FakeSocket;
    crypt: Crypt;
  } {
    const crypt = new Crypt(generateIdentitySync(0));
    completeCryptoInit(crypt);
    const h = new PacketHandler(crypt);
    const socket = new FakeSocket();
    h.start(socket);
    handler = h;
    return { handler: h, socket, crypt };
  }

  it("sends a command again under the key it first went out under", () => {
    const crypt = new Crypt(generateIdentitySync(0));
    const h = new PacketHandler(crypt);
    handler = h;
    const socket = new FakeSocket();
    h.start(socket);

    // clientek: sent under the dummy key, and crypto init completes right after.
    h.sendPacket(PacketType.Command, new TextEncoder().encode("clientek ek=x proof=y"), 0);
    completeCryptoInit(crypt);
    expect(commandsSent(socket)).toHaveLength(1);

    vi.advanceTimersByTime(600);

    const sent = commandsSent(socket);
    expect(sent).toHaveLength(2);
    expect(Buffer.from(sent[1]!).equals(Buffer.from(sent[0]!))).toBe(true);
  });

  it("ends the connection when a command stays missing while later ones wait", () => {
    const s = session();
    const delivered: number[] = [];
    s.handler.onPacket = (p) => delivered.push(p.id);
    const closed: Array<Error | null> = [];
    s.handler.onClosed = (err) => closed.push(err);

    // Id 0 never arrives.
    s.socket.deliver(sessionPacket(s.crypt, PacketType.Command, 0, 1, Uint8Array.of(65)));
    vi.advanceTimersByTime(4_000);
    expect(closed).toHaveLength(0);

    vi.advanceTimersByTime(2_000);
    expect(delivered).toEqual([]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeInstanceOf(ConnectionStalledError);
  });

  it("does not end the connection when the hole fills in time", () => {
    const s = session();
    const delivered: number[] = [];
    s.handler.onPacket = (p) => delivered.push(p.id);
    const closed: Array<Error | null> = [];
    s.handler.onClosed = (err) => closed.push(err);

    s.socket.deliver(sessionPacket(s.crypt, PacketType.Command, 0, 1, Uint8Array.of(65)));
    vi.advanceTimersByTime(3_000);
    s.socket.deliver(sessionPacket(s.crypt, PacketType.Command, 0, 0, Uint8Array.of(66)));
    vi.advanceTimersByTime(10_000);

    expect(delivered).toEqual([0, 1]);
    expect(closed).toHaveLength(0);
  });

  it("ignores an empty or malformed Init1 step instead of failing the attempt", () => {
    const crypt = new Crypt(generateIdentitySync(0));
    expect(processInit1(crypt, new Uint8Array(0))).toBeNull();
    expect(processInit1(crypt, Uint8Array.of(0, 1, 2))).toBeNull();
  });

  it("counts only datagrams that authenticate", () => {
    const s = session();
    const before = s.handler.trafficSnapshot();
    s.socket.deliver(new Uint8Array(40).fill(9));
    expect(s.handler.trafficSnapshot()).toEqual(before);
  });

  it("drops an oversize fragmented command whole, to its end marker", () => {
    const s = session();
    const delivered: Uint8Array[] = [];
    s.handler.onPacket = (p) => delivered.push(p.data);

    const chunk = new Uint8Array(3_900).fill(1);
    const count = 300; // 1.17 MB, over the reassembly limit
    for (let i = 0; i < count; i++) {
      const flags = i === 0 || i === count - 1 ? PacketFlags.Fragmented : 0;
      s.socket.deliver(sessionPacket(s.crypt, PacketType.Command, flags, i, chunk));
    }
    // A small command after it must arrive intact, not as the oversize tail.
    s.socket.deliver(sessionPacket(s.crypt, PacketType.Command, 0, count, Uint8Array.of(65, 66)));

    expect(delivered).toHaveLength(1);
    expect(Array.from(delivered[0]!)).toEqual([65, 66]);
  });
});
