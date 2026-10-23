import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Logger } from "@honeybbq/teamspeak";
import { Client, clientInternals } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { FakeSocket, sessionPacket } from "./testing/fake-server.js";

const identity = generateIdentitySync(0);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await sleep(2);
  expect(condition()).toBe(true);
}

/** A reconnecting client on fake sockets, with what it logged. */
function reconnectingClient(
  delayMs = 20,
  shouldRetry?: (error: Error | undefined, attempt: number) => boolean,
): {
  client: Client;
  sockets: FakeSocket[];
  logs: string[];
} {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
  };
  const client = new Client(identity, "127.0.0.1:9987", "Bot", {
    logger,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnect: {
      backoff: { initialDelayMs: delayMs, maxDelayMs: delayMs, jitter: 0 },
      shouldRetry,
    },
  });
  return { client, sockets, logs };
}

/** Complete the handshake on `socket`, with `extra` lines in the same datagram. */
function finishHandshake(client: Client, socket: FakeSocket, extra = ""): void {
  const crypt = clientInternals(client).crypt;
  crypt.setSharedSecret(randomBytes(10), randomBytes(54), randomBytes(64));
  const lines = `initserver aclid=7 virtualserver_version=3.13.7${extra}`;
  socket.deliver(sessionPacket(crypt, 2, 0x20, 0, new TextEncoder().encode(lines)));
}

async function connectedClient(): Promise<ReturnType<typeof reconnectingClient>> {
  const made = reconnectingClient();
  const connecting = made.client.connect();
  await until(() => made.sockets.length === 1);
  finishHandshake(made.client, made.sockets[0]!);
  await connecting;
  return made;
}

describe("the reconnect loop", () => {
  it("tells `connected` whether it made the connection, and `disconnected` whether it will", async () => {
    const { client, sockets } = reconnectingClient();
    const connected: boolean[] = [];
    const disconnected: boolean[] = [];
    client.on("connected", (e) => connected.push(e.reconnected));
    client.on("disconnected", (e) => disconnected.push(e.willReconnect));
    const first = client.connect();
    await until(() => sockets.length === 1);
    finishHandshake(client, sockets[0]!);
    await first;

    sockets[0]!.close();
    await until(() => sockets.length === 2);
    finishHandshake(client, sockets[1]!);
    await until(() => connected.length === 2);
    await client.disconnect({ signal: AbortSignal.timeout(1) });

    expect(connected).toEqual([false, true]);
    expect(disconnected).toEqual([true, false]);
  });

  it("asks shouldRetry once for a failure, and reports its refusal", async () => {
    const asked: number[] = [];
    const { client, sockets } = reconnectingClient(20, (_, attempt) => {
      asked.push(attempt);
      return false;
    });
    const disconnected: boolean[] = [];
    client.on("disconnected", (e) => disconnected.push(e.willReconnect));
    const first = client.connect();
    await until(() => sockets.length === 1);
    finishHandshake(client, sockets[0]!);
    await first;

    sockets[0]!.close();
    await until(() => disconnected.length === 1);
    for (let i = 0; i < 5; i++) await settle();

    expect(disconnected).toEqual([false]);
    expect(asked).toEqual([1]);
    expect(sockets).toHaveLength(1);
  });

  it("keeps retrying when its own attempt drops before the loop resumes", async () => {
    const { client, sockets, logs } = await connectedClient();
    sockets[0]!.close();
    await until(() => sockets.length === 2);

    // The server finishes the handshake and stops in the same datagram.
    finishHandshake(
      client,
      sockets[1]!,
      "\nnotifyclientleftview clid=7 reasonid=11 reasonmsg=stop",
    );
    await until(() => sockets.length === 3);
    expect(logs).not.toContain("reconnected");

    finishHandshake(client, sockets[2]!);
    await until(() => logs.includes("reconnected"));
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });

  it("ends when the client is connected by hand during the wait", async () => {
    // A long wait, for the user's connect() to land in.
    const { client, sockets, logs } = reconnectingClient(150);
    const first = client.connect();
    await until(() => sockets.length === 1);
    finishHandshake(client, sockets[0]!);
    await first;

    sockets[0]!.close();
    await until(() => client.status === "disconnected");
    const byHand = client.connect();
    await until(() => sockets.length === 2);
    finishHandshake(client, sockets[1]!);
    await byHand;

    await until(() => logs.some((l) => l.startsWith("reconnect loop ended")));
    // The loop has ended; nothing is left for it to do, so let any stray
    // deliveries run and see that no attempt follows.
    for (let i = 0; i < 5; i++) await settle();
    expect(sockets).toHaveLength(2);
    expect(client.status).toBe("connected");
    await client.disconnect({ signal: AbortSignal.timeout(1) });
  });
});
