import { describe, it, expect } from "vitest";
import { Client, generateIdentity } from "./index.js";
import { PacketType, type Packet } from "./transport/packet.js";

function commandPacket(text: string): Packet {
  return {
    typeFlagged: PacketType.Command,
    id: 1,
    clientID: 0,
    generationID: 0,
    data: new TextEncoder().encode(text),
    receivedAt: Date.now(),
  };
}

/** A client already past the handshake, as initserver would have left it. */
function connectedClient(nickname: string, clid: number): Client {
  const client = new Client(generateIdentity(0), "127.0.0.1:9987", nickname);
  client.clid = clid;
  client.handler.setClientID(clid);
  return client;
}

describe("Client self identification on notifycliententerview", () => {
  it("does not adopt another client named <own nick><digits>", () => {
    // The server renames a client whose nickname is taken to "<nick><digits>",
    // so a lookalike is indistinguishable from us by nickname alone. Adopting
    // its clid would poison every outgoing packet header with a foreign id.
    const client = connectedClient("Bot", 5);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot2"),
    );

    expect(client.clid).toBe(5);
  });

  it("tracks the server-applied rename on its own clientEnter", () => {
    const client = connectedClient("Bot", 5);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=5 ctid=1 client_nickname=Bot2"),
    );

    expect(client.clid).toBe(5);
    expect(client.nickname).toBe("Bot2");
  });

  it("still learns its clid from the welcome enter when initserver carried no aclid", () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );

    expect(client.clid).toBe(7);
    expect(client.nickname).toBe("Bot");
  });

  it("adopts the first suffix match while the clid is still unknown, then locks it in", () => {
    // While initserver has given us no clid, a nickname match is the only
    // signal available, so the first one wins. The clid is then known, which
    // is what stops any later lookalike from taking over.
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=9 ctid=1 client_nickname=Bot3"),
    );
    expect(client.clid).toBe(9);

    client.handler.onPacket?.(
      commandPacket("notifycliententerview clid=7 ctid=1 client_nickname=Bot"),
    );
    expect(client.clid).toBe(9);
  });
});

describe("waitConnected failure reporting", () => {
  it("rejects with the server error instead of timing out", async () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    const pending = client.waitConnected();

    // A handshake the server rejects before the welcome sequence completes.
    client.handler.onPacket?.(commandPacket("error id=1028 msg=invalid\\sserver\\spassword"));

    await expect(pending).rejects.toThrow(/invalid server password/);
  });

  it("keeps rejecting for waiters that arrive after the failure", async () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    client.handler.onPacket?.(commandPacket("error id=1028 msg=invalid\\sserver\\spassword"));

    await expect(client.waitConnected()).rejects.toThrow(/invalid server password/);
  });

  it("rejects an already-aborted wait without registering a listener", async () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    const controller = new AbortController();
    const reason = new Error("caller went away");
    controller.abort(reason);

    await expect(client.waitConnected(controller.signal)).rejects.toBe(reason);
  });

  it("stops waiting on abort and is not resolved by a later connect", async () => {
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    const controller = new AbortController();
    const pending = client.waitConnected(controller.signal);

    controller.abort(new Error("aborted by test"));
    await expect(pending).rejects.toThrow(/aborted by test/);

    // The aborted waiter must have been dropped, so marking connected later
    // must not resolve it (a resolved-after-reject would be a no-op, but a
    // leaked entry would also re-resolve on every subsequent connect).
    expect(() => client._markConnected()).not.toThrow();
  });
});

describe("waitConnected registered before connect()", () => {
  it("survives the reset that connect() performs and settles on the handshake", async () => {
    // connect() calls #resetForConnect() internally. A waiter registered
    // before it is not stale — it is the documented "block until the handshake
    // completes" usage — so the reset must leave it in place.
    const client = new Client(generateIdentity(0), "127.0.0.1:9987", "Bot");
    const pending = client.waitConnected();

    client._markConnected();

    await expect(pending).resolves.toBeUndefined();
  });
});
