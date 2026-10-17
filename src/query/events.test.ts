import { describe, expect, it } from "vitest";
import { QueryClient } from "./index.js";
import type { QueryClientOptions, QueryTransport, QueryTransportOptions } from "./index.js";
import type {
  ClientEnterEvent,
  ClientLeaveEvent,
  ClientMovedEvent,
  KickedEvent,
  NotificationEvent,
  TextMessageEvent,
} from "@honeybbq/teamspeak";
import { Reason } from "@honeybbq/teamspeak";

/**
 * A transport that answers the setup commands by itself and lets the test push
 * notification lines. The alternative — every test driving `connect()` by
 * hand — is the same six lines repeated.
 */
class FakeTransport implements QueryTransport {
  supportsNotifications: boolean;
  sent: string[] = [];
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;
  /** The rows `clientlist` answers with, for the tests that need a client list. */
  clientList: string[] = ["error id=0 msg=ok"];
  /** The rows `whoami` answers with: no row, as a server that does not say who this is. */
  whoami: string[] = ["error id=0 msg=ok"];
  /** Commands the server refuses, by their first word, with the error line it answers. */
  refuse = new Map<string, string>();

  constructor(supportsNotifications = true) {
    this.supportsNotifications = supportsNotifications;
  }

  async send(line: string): Promise<void> {
    this.sent.push(line);
    const refusal = this.refuse.get(line.split(" ")[0] ?? "");
    if (refusal !== undefined) {
      this.receive(refusal);
    } else if (line.startsWith("version")) {
      this.receive("version=3.13.8 build=1 platform=Linux", "error id=0 msg=ok");
    } else if (line.startsWith("whoami")) {
      this.receive(...this.whoami);
    } else if (line.startsWith("clientlist")) {
      this.receive(...this.clientList);
    } else {
      this.receive("error id=0 msg=ok");
    }
  }

  async close(): Promise<void> {
    this.onClose?.(undefined);
  }

  receive(...lines: string[]): void {
    for (const line of lines) this.onLine?.(line);
  }
}

function clientOn(
  transport: FakeTransport,
  options: Partial<QueryClientOptions> = {},
): QueryClient {
  const custom: QueryTransportOptions = { kind: "custom", open: async () => transport };
  return new QueryClient({ ...options, transport: custom });
}

/** Poll until `done`, for the delivery that happens a microtask later. */
async function waitFor(done: () => boolean, timeoutMs = 1_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Connect a client the transport answers by itself, so events can be pushed. */
async function connected(options: Partial<QueryClientOptions> = {}): Promise<{
  client: QueryClient;
  transport: FakeTransport;
}> {
  const transport = new FakeTransport();
  const client = clientOn(transport, options);
  await client.connect();
  return { client, transport };
}

describe("QueryClient events for channels and the server", () => {
  // The payloads are the ones TeamSpeak 3 and TeamSpeak 6 sent a query client.
  const lines = {
    channelCreated:
      "notifychannelcreated cid=246 cpid=0 channel_name=b2m-full channel_topic=tp channel_order=3 channel_flag_permanent=1 invokerid=460 invokername=b2-adm invokeruid=serveradmin",
    channelEdited:
      "notifychanneledited cid=246 reasonid=10 invokerid=460 invokername=b2-adm invokeruid=serveradmin channel_codec_quality=5",
    channelMoved:
      "notifychannelmoved cid=7 cpid=2 order=0 reasonid=1 invokerid=11 invokername=b2-adm2 invokeruid=serveradmin",
    channelDeleted: "notifychanneldeleted invokerid=0 invokername=Server cid=246",
    channelDescriptionChanged: "notifychanneldescriptionchanged cid=246",
    channelPasswordChanged: "notifychannelpasswordchanged cid=246",
    serverEdited:
      "notifyserveredited reasonid=10 invokerid=460 invokername=b2-adm invokeruid=serveradmin virtualserver_name=b2\\sname",
  } as const;

  it("delivers each as the core's event, and the catch-all after it", async () => {
    const { client, transport } = await connected();
    const order: string[] = [];
    const payloads = new Map<string, unknown>();
    for (const name of Object.keys(lines) as Array<keyof typeof lines>) {
      client.on(name, (e) => {
        order.push(name);
        payloads.set(name, e);
      });
    }
    client.on("notification", (e: NotificationEvent) => order.push(`notification:${e.name}`));

    for (const line of Object.values(lines)) transport.receive(line);

    expect(order).toEqual([
      "channelCreated",
      "notification:notifychannelcreated",
      "channelEdited",
      "notification:notifychanneledited",
      "channelMoved",
      "notification:notifychannelmoved",
      "channelDeleted",
      "notification:notifychanneldeleted",
      "channelDescriptionChanged",
      "notification:notifychanneldescriptionchanged",
      "channelPasswordChanged",
      "notification:notifychannelpasswordchanged",
      "serverEdited",
      "notification:notifyserveredited",
    ]);
    expect(payloads.get("channelCreated")).toMatchObject({
      channelID: 246n,
      parentID: 0n,
      changes: { name: "b2m-full", topic: "tp", order: 3n, isPermanent: true },
    });
    expect(payloads.get("channelEdited")).toMatchObject({
      reason: Reason.ChannelEdit,
      changes: { codecQuality: 5 },
    });
    expect(payloads.get("channelDeleted")).toMatchObject({
      invokerID: 0,
      invokerName: "Server",
    });
    expect(payloads.get("serverEdited")).toMatchObject({
      changes: { virtualserver_name: "b2 name" },
      invokerName: "b2-adm",
    });
  });

  it("gives a description fetch's answer to the catch-all only", async () => {
    const { client, transport } = await connected();
    const edits: string[] = [];
    const names: string[] = [];
    client.on("channelEdited", (e) => edits.push(String(e.channelID)));
    client.on("notification", (e: NotificationEvent) => names.push(e.name));

    transport.receive("notifychanneledited cid=7 channel_description=initial\\sdesc reasonid=9");
    transport.receive(lines.channelEdited);

    expect(edits).toEqual(["246"]);
    expect(names).toEqual(["notifychanneledited", "notifychanneledited"]);
  });

  it("offers none of the voice client's events, and still carries their notifications", async () => {
    const { client, transport } = await connected();
    const names: string[] = [];
    client.on("notification", (e: NotificationEvent) => names.push(e.name));

    transport.receive(
      "notifyclientupdated clid=4 client_away=1",
      "notifyplugincmd name=p data=d invokerid=4 invokername=x invokeruid=u",
      "notifychannelsubscribed cid=3 es=1",
      "notifyclientchatcomposing clid=4 cluid=u",
    );

    expect(names).toEqual([
      "notifyclientupdated",
      "notifyplugincmd",
      "notifychannelsubscribed",
      "notifyclientchatcomposing",
    ]);
    // @ts-expect-error a query client has no pluginCommand event
    expect(() => client.on("pluginCommand", () => {})).not.toThrow();
  });

  it("learns the clients with their away and mute state", async () => {
    const transport = new FakeTransport();
    transport.clientList = [
      "clid=5 cid=1 client_nickname=Alice client_unique_identifier=u client_type=0 client_away=1 client_input_muted=1",
      "error id=0 msg=ok",
    ];
    const client = clientOn(transport);
    await client.connect();
    const seen: TextMessageEvent[] = [];
    client.on("textMessage", (e) => seen.push(e));

    expect(transport.sent).toContain("clientlist -uid -groups -away -voice");
    transport.receive("notifytextmessage targetmode=1 msg=hi invokerid=5 invokername=Alice");
    expect(seen[0]?.invokerUID).toBe("u");
  });
});

describe("QueryClient events", () => {
  it("delivers a text message as the core's event", async () => {
    const { client, transport } = await connected();
    const seen: TextMessageEvent[] = [];
    client.on("textMessage", (e) => seen.push(e));

    transport.receive(
      "notifytextmessage targetmode=2 target=0 msg=hello\\sworld invokerid=9 invokername=Alice invokeruid=uid1",
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      invokerName: "Alice",
      invokerUID: "uid1",
      invokerID: 9,
      message: "hello world",
      targetMode: 2,
      targetID: 0,
      invokerGroups: undefined,
    });
  });

  it("delivers a client entering as the client list's own record", async () => {
    const { client, transport } = await connected();
    const seen: ClientEnterEvent[] = [];
    client.on("clientEnter", (e) => seen.push(e));

    transport.receive(
      "notifycliententerview clid=5 ctid=42 client_nickname=Alice client_unique_identifier=uid1 client_type=0 client_servergroups=6,9",
    );

    expect(seen[0]).toMatchObject({ id: 5, nickname: "Alice", uid: "uid1", channelID: 42n });
    expect(seen[0]?.serverGroups).toEqual([6n, 9n]);
  });

  it("fills a text message's groups from the client it learned of", async () => {
    const { client, transport } = await connected();
    const seen: TextMessageEvent[] = [];
    client.on("textMessage", (e) => seen.push(e));

    transport.receive(
      "notifycliententerview clid=9 ctid=1 client_nickname=Alice client_unique_identifier=uid1 client_servergroups=6,9",
      "notifytextmessage targetmode=1 msg=hi invokerid=9 invokername=Alice",
    );

    expect(seen[0]?.invokerGroups).toEqual([6n, 9n]);
  });

  it("delivers a client leaving, with its reason and who kicked it", async () => {
    const { client, transport } = await connected();
    const leaves: ClientLeaveEvent[] = [];
    client.on("clientLeave", (e) => leaves.push(e));

    transport.receive(
      "notifyclientleftview clid=7 reasonid=5 reasonmsg=bye invokerid=2 invokername=Bob invokeruid=uid2",
    );

    expect(leaves[0]).toMatchObject({
      clientID: 7,
      reason: Reason.KickServer,
      reasonMessage: "bye",
      invokerName: "Bob",
      invokerUID: "uid2",
      invokerID: 2,
    });
  });

  it("delivers a move of a client, with the move's own reason", async () => {
    const { client, transport } = await connected();
    const seen: ClientMovedEvent[] = [];
    client.on("clientMoved", (e) => seen.push(e));

    transport.receive(
      "notifyclientmoved clid=5 ctid=42 reasonid=1 invokerid=2 invokername=Bob invokeruid=uid2",
    );

    expect(seen[0]).toMatchObject({
      clientID: 5,
      targetChannelID: 42n,
      reason: Reason.Moved,
      invokerName: "Bob",
      invokerID: 2,
    });
  });

  // A query client is never kicked from the server, but a channel kick reaches
  // it as a move of its own — which is also what tells the client who it is.
  it("reads a channel kick of itself, by the id whoami names", async () => {
    const transport = new FakeTransport();
    transport.whoami = ["client_id=4 client_nickname=bot", "error id=0 msg=ok"];
    transport.clientList = [
      "clid=4 cid=1 client_nickname=bot client_unique_identifier=me client_type=1",
      "clid=5 cid=1 client_nickname=Alice client_unique_identifier=uid1 client_type=0",
      "error id=0 msg=ok",
    ];
    const client = clientOn(transport, { nickname: "bot" });
    await client.connect();

    const moves: ClientMovedEvent[] = [];
    const kicks: KickedEvent[] = [];
    client.on("clientMoved", (e) => moves.push(e));
    client.on("kicked", (e) => kicks.push(e));

    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=out invokername=Bob");
    // Someone else's move is theirs, not a kick of this client.
    transport.receive("notifyclientmoved clid=5 ctid=1 reasonid=4 reasonmsg=out");

    expect(moves).toHaveLength(2);
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toMatchObject({ reason: Reason.KickChannel, reasonMessage: "out" });
  });

  // The nickname is no way to find oneself: the server renames a client whose
  // nickname is taken, and an earlier session that has not gone yet still holds
  // it. The id is the one whoami names, whatever the list says.
  it("is not taken for an older session that has the same nickname", async () => {
    const transport = new FakeTransport();
    transport.whoami = ["client_id=9 client_nickname=bot1", "error id=0 msg=ok"];
    transport.clientList = [
      "clid=4 cid=1 client_nickname=bot client_unique_identifier=old client_type=1",
      "clid=9 cid=1 client_nickname=bot1 client_unique_identifier=me client_type=1",
      "error id=0 msg=ok",
    ];
    const client = clientOn(transport, { nickname: "bot" });
    await client.connect();

    const kicks: KickedEvent[] = [];
    client.on("kicked", (e) => kicks.push(e));

    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=theirs");
    expect(kicks).toHaveLength(0);

    transport.receive("notifyclientmoved clid=9 ctid=1 reasonid=4 reasonmsg=out");
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toMatchObject({ reason: Reason.KickChannel, reasonMessage: "out" });
  });

  it("reads a channel kick of itself without a nickname option", async () => {
    const transport = new FakeTransport();
    transport.whoami = ["client_id=9", "error id=0 msg=ok"];
    transport.clientList = [
      "clid=9 cid=1 client_nickname=serveradmin client_unique_identifier=me client_type=1",
      "error id=0 msg=ok",
    ];
    const client = clientOn(transport);
    await client.connect();

    const kicks: KickedEvent[] = [];
    client.on("kicked", (e) => kicks.push(e));

    transport.receive("notifyclientmoved clid=9 ctid=1 reasonid=4 reasonmsg=out");
    expect(kicks).toHaveLength(1);
  });

  // The escape hatch: every notification, modelled or not, after the event it
  // produced.
  it("delivers every notification, after the event it produced", async () => {
    const { client, transport } = await connected();
    const order: string[] = [];
    client.on("notification", (e: NotificationEvent) => order.push(`notification:${e.name}`));
    client.on("clientEnter", () => order.push("clientEnter"));

    transport.receive("notifychanneledited cid=1", "notifycliententerview clid=5 ctid=1");

    // The core's contract: `notification` comes after the event the same
    // notification produced, so a listener for both sees the typed one first.
    expect(order).toEqual([
      "notification:notifychanneledited",
      "clientEnter",
      "notification:notifycliententerview",
    ]);
  });

  it("delivers one event to every listener, and stops at the removal", async () => {
    const { client, transport } = await connected();
    const seen: number[] = [];
    const stop = client.on("textMessage", () => seen.push(1));
    client.on("textMessage", () => seen.push(2));

    transport.receive("notifytextmessage targetmode=1 msg=a");
    stop();
    transport.receive("notifytextmessage targetmode=1 msg=b");

    expect(seen).toEqual([1, 2, 2]);
  });

  it("listens for the next occurrence only", async () => {
    const { client, transport } = await connected();
    const seen: string[] = [];
    client.once("textMessage", (e) => seen.push(e.message));

    transport.receive(
      "notifytextmessage targetmode=1 msg=one",
      "notifytextmessage targetmode=1 msg=two",
    );

    expect(seen).toEqual(["one"]);
  });

  // One listener's failure is its own: the others still get the event, and the
  // exception surfaces on its own, as an EventEmitter listener's would.
  it("keeps delivering when a listener throws", async () => {
    const { client, transport } = await connected();
    const seen: string[] = [];
    const thrown: string[] = [];
    // Every throw is collected here before it can reach the runner: the
    // client rethrows from a microtask, which nothing else is waiting on.
    const onUncaught = (error: Error): void => {
      thrown.push(error.message);
    };
    process.on("uncaughtException", onUncaught);
    try {
      client.on("textMessage", () => {
        throw new Error("listener blew up");
      });
      client.on("textMessage", (e) => seen.push(e.message));

      transport.receive("notifytextmessage targetmode=1 msg=first");
      transport.receive("notifytextmessage targetmode=1 msg=second");
      await waitFor(() => thrown.length === 2);
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    // Both events reached the listener after the one that threw.
    expect(seen).toEqual(["first", "second"]);
    expect(thrown).toEqual(["listener blew up", "listener blew up"]);
  });

  it("iterates an event with for await", async () => {
    const { client, transport } = await connected();
    const seen: string[] = [];
    const loop = (async () => {
      for await (const message of client.events("textMessage")) seen.push(message.message);
    })();

    transport.receive("notifytextmessage targetmode=1 msg=one");
    await new Promise((r) => setImmediate(r));
    transport.receive("notifytextmessage targetmode=1 msg=two");
    await new Promise((r) => setImmediate(r));
    await client.disconnect();
    await loop;

    expect(seen).toEqual(["one", "two"]);
  });

  it("ends an iterator with the signal's reason when it aborts", async () => {
    const { client, transport } = await connected();
    const controller = new AbortController();
    const iterator = client.events("textMessage", { signal: controller.signal });
    const pending = iterator.next();
    controller.abort(new Error("stop reading"));

    await expect(pending).rejects.toThrow("stop reading");
    transport.receive("notifytextmessage targetmode=1 msg=ignored");
    await expect(iterator.next()).rejects.toThrow("stop reading");
  });

  // WebQuery has nothing to push a notification down, so a listener for one
  // could never run: the client refuses rather than accepting it silently.
  it("refuses a server event when the transport cannot deliver notifications", async () => {
    const offline = new FakeTransport(false);
    const client = clientOn(offline);
    await client.connect();

    expect(() => client.on("textMessage", () => {})).toThrow(TypeError);
    expect(() => client.on("notification", () => {})).toThrow(TypeError);
    expect(() => client.events("clientMoved")).toThrow(TypeError);
    for (const name of [
      "channelCreated",
      "channelEdited",
      "channelMoved",
      "channelDeleted",
      "channelDescriptionChanged",
      "channelPasswordChanged",
      "serverEdited",
    ] as const) {
      expect(() => client.on(name, () => {}), name).toThrow(TypeError);
    }
    // The session events come from the client's own lifecycle, not the server.
    expect(() => client.on("connected", () => {})).not.toThrow();
    expect(() => client.on("disconnected", () => {})).not.toThrow();
  });

  // A `custom` transport only says what it can do once it is opened, so the
  // client cannot refuse earlier than that.
  it("refuses `events` on a custom transport that reports no notifications", async () => {
    const offline = new FakeTransport(false);
    const client = clientOn(offline, { events: true });
    await expect(client.connect()).rejects.toBeInstanceOf(TypeError);
    expect(client.status).toBe("disconnected");
  });
});

describe("QueryClient: what it knows of the server it is on", () => {
  const ok = "error id=0 msg=ok";
  const roster = (...ids: number[]): string[] => [
    ...ids.map(
      (id) =>
        `clid=${id} cid=1 client_nickname=c${id} client_unique_identifier=uid${id} client_type=0`,
    ),
    ok,
  ];

  async function onServer(): Promise<{ client: QueryClient; transport: FakeTransport }> {
    const transport = new FakeTransport();
    transport.whoami = ["client_id=4 client_nickname=bot", ok];
    transport.clientList = roster(4, 5);
    const client = clientOn(transport, { events: true, server: { id: 1 }, nickname: "bot" });
    await client.connect();
    return { client, transport };
  }

  const kicksOf = (client: QueryClient): KickedEvent[] => {
    const kicks: KickedEvent[] = [];
    client.on("kicked", (e) => kicks.push(e));
    return kicks;
  };
  const enters = (client: QueryClient): ClientEnterEvent[] => {
    const seen: ClientEnterEvent[] = [];
    client.on("clientEnter", (e) => seen.push(e));
    return seen;
  };

  it("reads its id again after use, and recognises a kick on the new server", async () => {
    const { client, transport } = await onServer();
    const kicks = kicksOf(client);
    transport.whoami = ["client_id=11 client_nickname=bot", ok];
    transport.clientList = roster(11, 12);
    await client.use({ id: 2 });

    // The old id is another client now; the new one is this client.
    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=old");
    expect(kicks).toHaveLength(0);
    transport.receive("notifyclientmoved clid=11 ctid=1 reasonid=4 reasonmsg=new");
    expect(kicks).toHaveLength(1);
  });

  it("drops the old roster on use and lists the new server's clients", async () => {
    const { client, transport } = await onServer();
    transport.whoami = ["client_id=11", ok];
    transport.clientList = [
      "clid=11 cid=1 client_nickname=c11 client_unique_identifier=u11 client_type=0 client_servergroups=7",
      "clid=12 cid=1 client_nickname=c12 client_unique_identifier=u12 client_type=0 client_servergroups=8",
      ok,
    ];
    transport.sent.length = 0;
    await client.use({ port: 9988 });
    expect(transport.sent.map((l) => l.split(" ")[0])).toEqual(["use", "whoami", "clientlist"]);

    const messages: TextMessageEvent[] = [];
    client.on("textMessage", (e) => messages.push(e));
    // Client 5 only the old server had; 12 only the new one has.
    transport.receive("notifytextmessage targetmode=1 msg=a invokerid=5 invokername=c5");
    transport.receive("notifytextmessage targetmode=1 msg=b invokerid=12 invokername=c12");
    expect(messages[0]?.invokerGroups).toBeUndefined();
    expect(messages[1]?.invokerGroups).toEqual([8n]);
  });

  it("lists no clients after use when no event is registered for", async () => {
    const transport = new FakeTransport();
    transport.whoami = ["client_id=4", ok];
    const client = clientOn(transport, { events: false, server: { id: 1 } });
    await client.connect();
    transport.sent.length = 0;
    await client.use({ id: 2 });
    expect(transport.sent.map((l) => l.split(" ")[0])).toEqual(["use", "whoami"]);
  });

  it("asks nothing after use on a transport that delivers no events", async () => {
    const transport = new FakeTransport(false);
    const client = clientOn(transport);
    await client.connect();
    transport.sent.length = 0;
    await client.use({ id: 2 });
    expect(transport.sent).toEqual(["use sid=2"]);
  });

  it("clears its id and roster after logout", async () => {
    const { client, transport } = await onServer();
    const kicks = kicksOf(client);
    await client.logout();
    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=gone");
    expect(kicks).toHaveLength(0);
  });

  it("clears its id and roster when the server refuses use, and fails with its error", async () => {
    const { client, transport } = await onServer();
    const kicks = kicksOf(client);
    transport.refuse.set("use", "error id=1033 msg=server\\sis\\snot\\srunning");
    await expect(client.use({ id: 99 })).rejects.toMatchObject({ code: 1033 });

    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=gone");
    expect(kicks).toHaveLength(0);

    // The next successful use learns an id again.
    transport.refuse.clear();
    transport.whoami = ["client_id=21", ok];
    transport.clientList = roster(21);
    await client.use({ id: 1 });
    transport.receive("notifyclientmoved clid=21 ctid=1 reasonid=4 reasonmsg=back");
    expect(kicks).toHaveLength(1);
  });

  it("keeps its id when use fails for a reason that says nothing of the selection", async () => {
    const { client, transport } = await onServer();
    const kicks = kicksOf(client);
    const stop = new AbortController();
    stop.abort();
    await expect(client.use({ id: 2 }, { signal: stop.signal })).rejects.toBeDefined();
    transport.receive("notifyclientmoved clid=4 ctid=1 reasonid=4 reasonmsg=still");
    expect(kicks).toHaveLength(1);
  });

  it("lists the clients again once a registration is accepted, and not when it is refused", async () => {
    const { client, transport } = await onServer();
    transport.sent.length = 0;
    await client.registerNotifications("textserver");
    expect(transport.sent.map((l) => l.split(" ")[0])).toEqual([
      "servernotifyregister",
      "clientlist",
    ]);

    transport.sent.length = 0;
    transport.refuse.set("servernotifyregister", "error id=1024 msg=invalid\\sserverID");
    await expect(client.registerNotifications("server")).rejects.toMatchObject({ code: 1024 });
    expect(transport.sent.map((l) => l.split(" ")[0])).toEqual(["servernotifyregister"]);
  });

  it("learns the roster of the new server so a joiner is told from a known client", async () => {
    const { client, transport } = await onServer();
    transport.whoami = ["client_id=11", ok];
    transport.clientList = roster(11, 12);
    await client.use({ id: 2 });
    const seen = enters(client);
    transport.receive("notifycliententerview clid=30 ctid=1 client_nickname=new");
    expect(seen).toHaveLength(1);
  });

  // A reconnect starts over from the options: it logs in, selects the server
  // and registers the events again, and does not repeat a `use` made by hand.
  it("does not repeat a use made by hand when it reconnects", async () => {
    const transports: FakeTransport[] = [];
    const open = async (): Promise<FakeTransport> => {
      const t = new FakeTransport();
      t.whoami = ["client_id=4", ok];
      transports.push(t);
      return t;
    };
    const client = new QueryClient({
      transport: { kind: "custom", open },
      events: { categories: ["server"] },
      server: { id: 1 },
      reconnect: { backoff: { initialDelayMs: 1, maxDelayMs: 1, jitter: 0 } },
    });
    await client.connect();
    await client.use({ id: 2 });
    const first = transports[0]!;
    first.onClose?.(new Error("dropped"));
    await waitFor(() => transports.length === 2 && client.status === "connected");

    const second = transports[1]!.sent.filter(
      (l) => l.startsWith("use") || l.startsWith("servernotifyregister"),
    );
    expect(second.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "use sid=1",
      "servernotifyregister event=server",
    ]);
  });
});
