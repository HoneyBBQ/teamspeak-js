/**
 * Live connects over a socket that loses datagrams the handshake depends on.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/client/transport-loss.integration.test.ts
 */

import { createSocket } from "node:dgram";
import { describe, expect, it } from "vitest";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import type { DatagramSocket, SocketFactory } from "./types.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";

/** Byte offset of the packet type in a client datagram: tag, packet id, client id. */
const TYPE_BYTE = 12;
const COMMAND = 2;

/** A UDP socket factory that drops the first Command datagram the client sends: clientek. */
function dropFirstCommand(dropped: { count: number }): SocketFactory {
  return (family) => {
    const socket = createSocket(family === 6 ? "udp6" : "udp4");
    const wrapped: DatagramSocket = {
      connect: (port, address, callback) => socket.connect(port, address, callback),
      send: (data, callback) => {
        if (dropped.count === 0 && (data[TYPE_BYTE]! & 0x0f) === COMMAND) {
          dropped.count++;
          callback(null);
          return;
        }
        socket.send(data, callback);
      },
      close: () => socket.close(),
      on: (event: string, listener: never) => socket.on(event, listener),
      once: (_event, listener) => socket.once("error", listener),
      off: (_event, listener) => socket.off("error", listener),
      address: () => socket.address(),
    };
    return wrapped;
  };
}

describe.skipIf(!ADDR)("Integration: a lost clientek", () => {
  it("connects when the first clientek datagram is lost", async () => {
    const dropped = { count: 0 };
    const client = new Client(generateIdentitySync(8), ADDR!, "LossBot", {
      serverPassword: SERVER_PASSWORD,
      socketFactory: dropFirstCommand(dropped),
    });
    try {
      await client.connect({ signal: AbortSignal.timeout(20_000) });
      expect(dropped.count).toBe(1);
      expect(client.status).toBe("connected");
      expect(clientInternals(client).handler.resends).toBeGreaterThan(0);
    } finally {
      await client.disconnect({ signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
  }, 30_000);
});
