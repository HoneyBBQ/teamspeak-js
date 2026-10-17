/**
 * What the handler sends again while the handshake is unfinished. The resend
 * loop's timer and the clock are faked, so a test moves time instead of
 * waiting for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crypt } from "../crypto/crypt.js";
import { generateIdentitySync } from "../crypto/identity.js";
import { processInit1 } from "../handshake/crypt-handshake.js";
import { FakeSocket, init1Packet } from "../testing/fake-server.js";
import { PacketHandler } from "./handler.js";
import { PacketType, packetType } from "./packet.js";

const RESEND_DUE_MS = 600;

/** A handler started on a fake socket, answering each Init1 packet the way the client does. */
function startedHandler(): { handler: PacketHandler; socket: FakeSocket; step0: Uint8Array } {
  const crypt = new Crypt(generateIdentitySync(1));
  const handler = new PacketHandler(crypt);
  handler.onPacket = (p) => {
    if (packetType(p) !== PacketType.Init1) return;
    // From inside delivery, as the client does: the next step goes out while the
    // Init1 it answers is still being handled.
    // Steps 0 to 2 only: none of them is the puzzle, which would be a promise.
    const response = processInit1(crypt, p.data) as Uint8Array | null;
    if (response) handler.sendPacket(PacketType.Init1, response, 0);
  };
  const socket = new FakeSocket();
  handler.start(socket);
  expect(socket.sent).toHaveLength(1);
  return { handler, socket, step0: socket.sent[0]! };
}

/** An Init1 packet from the server whose payload is 21 bytes starting with `step`. */
function serverInit1(step: number): Uint8Array {
  const payload = new Uint8Array(21);
  payload[0] = step;
  return init1Packet(payload);
}

describe("the handshake's resends", () => {
  let handler: PacketHandler | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
  });

  afterEach(() => {
    handler?.close();
    handler = undefined;
    vi.useRealTimers();
  });

  it("resends the step the client answered with from inside delivery, not step 0", () => {
    const started = startedHandler();
    handler = started.handler;

    started.socket.deliver(serverInit1(0));
    expect(started.socket.sent).toHaveLength(2);
    const answer = started.socket.sent[1]!;
    expect(Buffer.from(answer).equals(Buffer.from(started.step0))).toBe(false);

    vi.advanceTimersByTime(RESEND_DUE_MS);

    expect(started.socket.sent).toHaveLength(3);
    expect(Buffer.from(started.socket.sent[2]!).equals(Buffer.from(answer))).toBe(true);
  });

  it("keeps resending the pending step when an Init1 gets no answer", () => {
    const started = startedHandler();
    handler = started.handler;

    // A step the client does not know: it is delivered and answered with nothing.
    started.socket.deliver(serverInit1(0x55));
    expect(started.socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(RESEND_DUE_MS);

    expect(started.socket.sent).toHaveLength(2);
    expect(Buffer.from(started.socket.sent[1]!).equals(Buffer.from(started.step0))).toBe(true);
  });

  it("resends nothing after the final acknowledgement", () => {
    const started = startedHandler();
    handler = started.handler;
    started.socket.deliver(serverInit1(0));
    const answer = started.socket.sent[1]!;

    // Until the acknowledgement, the step is still pending.
    vi.advanceTimersByTime(RESEND_DUE_MS);
    expect(started.socket.sent).toHaveLength(3);
    expect(Buffer.from(started.socket.sent[2]!).equals(Buffer.from(answer))).toBe(true);

    handler.receivedFinalInitAck();
    vi.advanceTimersByTime(10_000);

    expect(started.socket.sent).toHaveLength(3);
  });
});
