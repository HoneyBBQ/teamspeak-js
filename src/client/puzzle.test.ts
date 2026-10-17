/**
 * What a connect does with the server's Init1 puzzle: answers the levels a
 * flooded server asks for without stopping the event loop, stops when the
 * caller cancels, and refuses a level beyond the cap.
 */

import { describe, expect, it } from "vitest";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { MAX_RSA_CHALLENGE_LEVEL } from "./crypto/crypt.js";
import { PuzzleTooHardError } from "./errors.js";
import { puzzleOf } from "./handshake/crypt-handshake.js";
import { FakeSocket, init1Packet } from "./testing/fake-server.js";

const identity = generateIdentitySync(0);
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function startedClient(): Promise<{
  client: Client;
  socket: FakeSocket;
  connecting: Promise<void>;
  controller: AbortController;
}> {
  let socket: FakeSocket | undefined;
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    socketFactory: () => (socket = new FakeSocket()),
  });
  const controller = new AbortController();
  const connecting = client.connect({ signal: controller.signal });
  connecting.catch(() => {});
  // oxlint-disable-next-line no-unmodified-loop-condition -- the socket factory assigns it
  for (let i = 0; i < 100 && socket === undefined; i++) await settle();
  return { client, socket: socket!, connecting, controller };
}

/** The server's puzzle step: a full-size modulus and `level` squarings to do. */
function puzzleStep(level: number): Uint8Array {
  const step = new Uint8Array(233);
  step[0] = 3;
  step.fill(0x7f, 1, 1 + 64); // x
  step.fill(0xff, 1 + 64, 1 + 128); // n
  step[1 + 127] = 0xfd;
  new DataView(step.buffer).setUint32(129, level, false);
  return init1Packet(step);
}

describe("the Init1 puzzle in a connect", () => {
  it("answers the level a flooded server asks for, with the loop running meanwhile", async () => {
    const { client, socket } = await startedClient();
    const before = socket.sent.length;
    socket.deliver(puzzleStep(1_000_000));
    // The answer is not there at once: the solve is yielding.
    expect(socket.sent.length - before).toBe(0);

    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    while (socket.sent.length === before) await settle();
    clearInterval(timer);

    expect(socket.sent.length - before).toBe(1);
    expect(puzzleOf(clientInternals(client).crypt).level).toBe(1_000_000);
    expect(puzzleOf(clientInternals(client).crypt).durationMs).toBeGreaterThan(0);
    // 1,000,000 squarings is some 300 ms here; a blocked loop would tick once.
    expect(ticks).toBeGreaterThan(2);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("stops solving when the caller cancels, and rejects with the caller's reason", async () => {
    const { client, socket, connecting, controller } = await startedClient();
    const before = socket.sent.length;
    socket.deliver(puzzleStep(MAX_RSA_CHALLENGE_LEVEL));
    await settle();
    await settle();

    const reason = new Error("caller gave up");
    const cancelledAt = performance.now();
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expect(performance.now() - cancelledAt).toBeLessThan(250);

    // The abandoned solve answers nothing, then or later.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(socket.sent.length - before).toBe(0);
    expect(client.status).toBe("disconnected");
  });

  it("refuses a level beyond the cap with a PuzzleTooHardError, solving nothing", async () => {
    const { client, socket, connecting } = await startedClient();
    const before = socket.sent.length;
    socket.deliver(puzzleStep(MAX_RSA_CHALLENGE_LEVEL + 1));
    const error = await connecting.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PuzzleTooHardError);
    expect((error as PuzzleTooHardError).level).toBe(MAX_RSA_CHALLENGE_LEVEL + 1);
    expect(socket.sent.length - before).toBe(0);
    expect(client.status).toBe("disconnected");
  });

  it("ignores another challenge, and the same one again, while it is solving", async () => {
    const { client, socket } = await startedClient();
    const before = socket.sent.length;
    socket.deliver(puzzleStep(300_000));
    socket.deliver(puzzleStep(300_000));
    socket.deliver(puzzleStep(300_001));
    while (socket.sent.length === before) await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.sent.length - before).toBe(1);
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
