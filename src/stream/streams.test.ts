import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandTimeoutError,
  ErrorCode,
  NotConnectedError,
  ServerError,
  TeamspeakError,
  asClientID,
} from "@honeybbq/teamspeak";
import type { CommandRequest } from "@honeybbq/teamspeak";
import {
  StreamEndedError,
  StreamJoinDeniedError,
  StreamPayloadTooLargeError,
  StreamsUnsupportedError,
} from "./errors.js";
import { Streams } from "./streams.js";
import type {
  JoinRequest,
  PeerClosed,
  PublishedStream,
  StreamEnded,
  StreamInfo,
  StreamView,
  ViewerPeer,
} from "./types.js";
import { FakeClient, param, settle } from "./testing/fake-client.js";

const SELF = 1;
const OTHER = 7;
const STREAM = "11111111-2222-3333-4444-555555555555";

const started = (over: Record<string, string> = {}): Record<string, string> => ({
  clid: String(OTHER),
  id: STREAM,
  name: "Demo",
  type: "2",
  access: "1",
  mode: "1",
  bitrate: "58208",
  viewer_limit: "0",
  audio: "0",
  ...over,
});

const refusal = (code: number): ServerError => new ServerError(code, "refused");

function setup(options: { rememberDenied?: boolean } = {}): {
  client: FakeClient;
  streams: Streams;
} {
  const client = new FakeClient();
  // The viewers of the tests are in view, as the clients of a channel are.
  for (const clid of [9, 10, 12]) client.see(clid);
  return { client, streams: new Streams(client, options) };
}

/** Publish as this client: the server announces the stream once `setupstream` is sent. */
async function publishOne(
  client: FakeClient,
  streams: Streams,
  id = STREAM,
  name = "mine",
): Promise<PublishedStream> {
  const promise = streams.publish({ name });
  await settle();
  client.notify("notifystreamstarted", started({ clid: String(SELF), id, name }));
  return promise;
}

/** A viewer asks, and is accepted with an offer. */
async function admit(
  client: FakeClient,
  pub: PublishedStream,
  clid = 9,
): Promise<{ request: JoinRequest; peer: ViewerPeer }> {
  let request: JoinRequest | undefined;
  pub.on("request", (r) => (request = r));
  client.notify("notifyjoinstreamrequest", {
    id: pub.id,
    clid: String(clid),
    msg: "",
    is_remove: "0",
  });
  const peer = await request!.accept("v=0\r\n");
  return { request: request!, peer };
}

/** Watch the stream another client publishes, answered with an offer. */
async function watchOne(client: FakeClient, streams: Streams): Promise<StreamView> {
  client.notify("notifystreamstarted", started());
  const promise = streams.watch(STREAM);
  await settle();
  client.notify("notifyrespondjoinstreamrequest", {
    clid: String(OTHER),
    id: STREAM,
    msg: "",
    decision: "1",
    offer: "v=0\r\n",
  });
  return promise;
}

describe("a server that is not TeamSpeak 6", () => {
  it("refuses publish and watch before sending anything", async () => {
    const { client, streams } = setup();
    client.serverCapabilities = { family: "ts3", version: "3.13.8 [Build: 1]" };
    expect(streams.supported).toBe(false);
    await expect(streams.publish({ name: "x" })).rejects.toBeInstanceOf(StreamsUnsupportedError);
    await expect(streams.watch(STREAM)).rejects.toBeInstanceOf(StreamsUnsupportedError);
    expect(client.sent).toEqual([]);
  });

  it("names what the server is", async () => {
    const { client, streams } = setup();
    client.serverCapabilities = { family: "ts3", version: "3.13.8" };
    const error = await streams.publish({ name: "x" }).catch((e: unknown) => e);
    expect((error as StreamsUnsupportedError).family).toBe("ts3");
    expect((error as StreamsUnsupportedError).version).toBe("3.13.8");
  });

  it("treats a server not yet known as unsupported", async () => {
    const { client, streams } = setup();
    client.serverCapabilities = { family: "unknown", version: "" };
    await expect(streams.publish({ name: "x" })).rejects.toBeInstanceOf(StreamsUnsupportedError);
  });

  it("sends nothing when a client seems to stream", () => {
    const { client } = setup();
    client.serverCapabilities = { family: "ts3", version: "3.13.8" };
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.sent).toEqual([]);
  });
});

describe("discovery", () => {
  it("asks once for a client that comes into view streaming", () => {
    const { client } = setup();
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    client.emit("clientEnter", { id: asClientID(6), isStreaming: false });
    expect(client.commands("requeststreaminfo").map((r) => param(r, "clid"))).toEqual([5]);
  });

  it("asks for the clients already in view when it attaches", () => {
    const client = new FakeClient();
    client.see(5, { isStreaming: true });
    client.see(6, { isStreaming: false });
    const streams = new Streams(client);
    expect(streams.supported).toBe(true);
    expect(client.commands("requeststreaminfo").map((r) => param(r, "clid"))).toEqual([5]);
  });

  it("asks again when the flag clears and later comes back", () => {
    const { client } = setup();
    const clientID = asClientID(5);
    client.emit("clientUpdated", { clientID, changes: { isStreaming: true } });
    client.emit("clientUpdated", { clientID, changes: { isStreaming: true } });
    client.emit("clientUpdated", { clientID, changes: { isStreaming: false } });
    client.emit("clientUpdated", { clientID, changes: { isStreaming: true } });
    client.emit("clientUpdated", { clientID, changes: { isAway: true } });
    expect(client.commands("requeststreaminfo")).toHaveLength(2);
  });

  it("asks again for a client that went out of view and came back", () => {
    const { client } = setup();
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    client.emit("clientLeave", { clientID: asClientID(5) });
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.commands("requeststreaminfo")).toHaveLength(2);
  });

  it("does not ask about itself, nor before it is connected", () => {
    const { client } = setup();
    client.emit("clientEnter", { id: client.clientID, isStreaming: true });
    client.status = "connecting";
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.sent).toEqual([]);
    client.status = "connected";
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.sent).toHaveLength(1);
  });

  it("learns every stream of a client, one notification each, and tolerates an empty answer", () => {
    const { client, streams } = setup();
    const events: string[] = [];
    streams.on("started", (info) => events.push(info.id));
    client.notify("notifystreaminfo", { clid: "5", id: "a", name: "one", type: "1", viewer: "2" });
    client.notify("notifystreaminfo", { clid: "5", id: "b", name: "two", type: "3", viewer: "0" });
    client.notify("notifystreaminfo", { return_code: "9" });
    expect(events).toEqual(["a", "b"]);
    expect(streams.list().map((s) => s.name)).toEqual(["one", "two"]);
    expect(streams.get("a")?.viewers).toBe(2);
    expect(streams.get("a")?.source).toBe("camera");
  });

  it("reports an error nobody awaits, and asks again next time", async () => {
    const { client, streams } = setup();
    const errors: Error[] = [];
    streams.on("error", (e) => errors.push(e));
    client.answer = () => Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient));
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    await settle();
    expect(errors).toHaveLength(1);
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.commands("requeststreaminfo")).toHaveLength(2);
  });

  it("does not report a connection that is gone", async () => {
    const { client, streams } = setup();
    const errors: Error[] = [];
    streams.on("error", (e) => errors.push(e));
    client.answer = () => Promise.reject(new NotConnectedError());
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    await settle();
    expect(errors).toEqual([]);
  });
});

describe("known streams", () => {
  it("merges the announcement and the info, and reports a change as updated", () => {
    const { client, streams } = setup();
    const updated: StreamInfo[] = [];
    streams.on("updated", (info) => updated.push(info));
    client.notify("notifystreamstarted", started());
    client.notify("notifystreaminfo", { ...started(), accessibility: "1", viewer: "3" });
    expect(streams.get(STREAM)?.viewers).toBe(3);
    expect(updated).toHaveLength(1);
    client.notify("notifystreaminfo", { ...started(), accessibility: "1", viewer: "3" });
    expect(updated).toHaveLength(1);
  });

  // A client may run several streams, and stopping one leaves the others.
  it("keeps the other streams of a client when one stops", () => {
    const { client, streams } = setup();
    const stopped: Array<[string, number]> = [];
    streams.on("stopped", (e) => stopped.push([e.info.id, e.reason]));
    client.notify("notifystreamstarted", started({ id: "a" }));
    client.notify("notifystreamstarted", started({ id: "b" }));
    client.notify("notifystreamstopped", { clid: String(OTHER), id: "a", reason: "2" });
    expect(streams.list().map((s) => s.id)).toEqual(["b"]);
    expect(stopped).toEqual([["a", 2]]);
    client.notify("notifystreamstopped", { clid: String(OTHER), id: "a", reason: "2" });
    expect(stopped).toHaveLength(1);
  });

  it("keeps a stream when its publisher changes channel or leaves view", () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    client.emit("clientMoved", { clientID: asClientID(OTHER) });
    client.emit("clientLeave", { clientID: asClientID(OTHER) });
    expect(streams.list()).toHaveLength(1);
  });

  it("reports a viewer joining and leaving", () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const seen: string[] = [];
    streams.on("viewerJoined", (e) => seen.push(`joined ${e.clientId}`));
    streams.on("viewerLeft", (e) => seen.push(`left ${e.clientId}`));
    client.notify("notifystreamclientjoined", { id: STREAM, clid: "9" });
    client.notify("notifystreamclientleft", { id: STREAM, clid: "9", reason: "1" });
    client.notify("notifystreamclientjoined", { id: "unknown", clid: "9" });
    expect(seen).toEqual(["joined 9", "left 9"]);
  });
});

describe("publish", () => {
  it("sends setupstream with all seven parameters and resolves on the announcement", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const [request] = client.commands("setupstream") as [CommandRequest];
    expect(request.params).toEqual([
      ["name", "mine"],
      ["type", 2],
      ["bitrate", 1_500_000],
      ["accessibility", 1],
      ["mode", 1],
      ["viewer_limit", 0],
      ["audio", false],
    ]);
    expect(pub.id).toBe(STREAM);
    expect(pub.info.name).toBe("mine");
    expect(streams.get(STREAM)).toBeDefined();
  });

  it("sends the options as given", async () => {
    const { client, streams } = setup();
    const promise = streams.publish({
      name: "cam",
      source: "camera",
      audio: true,
      bitrate: 2_500_000,
      accessibility: "private",
      viewerLimit: 5,
    });
    await settle();
    const [request] = client.commands("setupstream") as [CommandRequest];
    expect(request.params?.map(([, v]) => v)).toEqual(["cam", 1, 2_500_000, 3, 1, 5, true]);
    client.notify("notifystreamstarted", started({ clid: String(SELF), name: "cam" }));
    await promise;
  });

  it.each([
    [{ source: "hologram" }, /source/],
    [{ accessibility: "secret" }, /accessibility/],
    [{ viewerLimit: 65536 }, /viewer limit/],
    [{ viewerLimit: -1 }, /viewer limit/],
    [{ viewerLimit: 1.5 }, /viewer limit/],
    [{ bitrate: -1 }, /bitrate/],
    [{ bitrate: Number.NaN }, /bitrate/],
  ])("rejects the option %j before sending", async (options, message) => {
    const { client, streams } = setup();
    await expect(streams.publish({ name: "x", ...options } as never)).rejects.toThrow(message);
    expect(client.sent).toEqual([]);
  });

  it("takes a viewer limit of 65535", async () => {
    const { client, streams } = setup();
    const promise = streams.publish({ name: "x", viewerLimit: 65535 });
    await settle();
    client.notify("notifystreamstarted", started({ clid: String(SELF), name: "x" }));
    await promise;
  });

  it("refuses a name too long to send, without sending", async () => {
    const { client, streams } = setup();
    await expect(streams.publish({ name: "x".repeat(10_000) })).rejects.toBeInstanceOf(
      StreamPayloadTooLargeError,
    );
    expect(client.sent).toEqual([]);
  });

  it("matches each announcement to its call when several are made", async () => {
    const { client, streams } = setup();
    const first = streams.publish({ name: "one" });
    const second = streams.publish({ name: "two" });
    await settle();
    expect(client.commands("setupstream")).toHaveLength(1);
    client.notify("notifystreamstarted", started({ clid: String(SELF), id: "a", name: "one" }));
    const a = await first;
    await settle();
    expect(client.commands("setupstream")).toHaveLength(2);
    client.notify("notifystreamstarted", started({ clid: String(SELF), id: "b", name: "two" }));
    const b = await second;
    expect([a.id, b.id]).toEqual(["a", "b"]);
    expect(a.info.name).toBe("one");
    expect(b.info.name).toBe("two");
  });

  it("does not take another client's stream for its own", async () => {
    const { client, streams } = setup();
    const promise = streams.publish({ name: "x", timeoutMs: 30 });
    await settle();
    client.notify("notifystreamstarted", started());
    await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("fails with the server's refusal, and then publishes again", async () => {
    const { client, streams } = setup();
    client.answer = () => Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient));
    await expect(streams.publish({ name: "x" })).rejects.toBeInstanceOf(ServerError);
    client.answer = () => undefined;
    await publishOne(client, streams);
  });

  it("stops waiting when the signal aborts", async () => {
    const { streams } = setup();
    const controller = new AbortController();
    const promise = streams.publish({ name: "x", signal: controller.signal });
    await settle();
    controller.abort(new Error("enough"));
    await expect(promise).rejects.toThrow("enough");
  });

  it("rejects while pending when the connection ends", async () => {
    const { client, streams } = setup();
    const promise = streams.publish({ name: "x" });
    await settle();
    client.emit("disconnected", { error: undefined, willReconnect: false });
    await expect(promise).rejects.toBeInstanceOf(NotConnectedError);
  });
});

describe("join requests", () => {
  it("emits a request with who asked", async () => {
    const { client, streams } = setup();
    client.see(9, { nickname: "Viewer" });
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", {
      id: pub.id,
      clid: "9",
      msg: "hi | there",
      is_remove: "0",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe("hi | there");
    expect(requests[0]?.viewer).toEqual({ clientId: 9, uid: "uid-9", nickname: "Viewer" });
    expect(requests[0]?.state).toBe("pending");
  });

  it("asks the server who a client out of view is", async () => {
    const { client, streams } = setup();
    client.clients.delete(asClientID(40));
    client.answer = (r) =>
      r.command === "clientgetuidfromclid"
        ? Promise.resolve([{ clid: "40", cluid: "far-uid", nickname: "Far", mytsid: "" }])
        : undefined;
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "40", msg: "", is_remove: "0" });
    await settle();
    expect(requests[0]?.viewer).toEqual({ clientId: 40, uid: "far-uid", nickname: "Far" });
  });

  it("knows no uid for a client the server cannot name, and still announces it", async () => {
    const { client, streams } = setup();
    client.answer = (r) =>
      r.command === "clientgetuidfromclid"
        ? Promise.reject(refusal(ErrorCode.ClientInvalidID))
        : undefined;
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "40", msg: "", is_remove: "0" });
    await settle();
    expect(requests[0]?.viewer).toEqual({ clientId: 40, uid: undefined, nickname: undefined });
  });

  it("remembers a denied client that was out of view by the uid the server gave", async () => {
    const { client, streams } = setup({ rememberDenied: true });
    client.answer = (r) =>
      r.command === "clientgetuidfromclid"
        ? Promise.resolve([{ clid: "40", cluid: "far-uid", nickname: "Far", mytsid: "" }])
        : undefined;
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    const ask = (): void =>
      client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "40", msg: "", is_remove: "0" });
    ask();
    await settle();
    await requests[0]!.deny();
    ask();
    await settle();
    expect(requests).toHaveLength(1);
  });

  it("announces requests in the order they came, whatever the lookups take", async () => {
    const { client, streams } = setup();
    const release: Array<() => void> = [];
    client.answer = (r) =>
      r.command === "clientgetuidfromclid"
        ? new Promise((resolve) =>
            release.push(() => resolve([{ clid: "1", cluid: "u", nickname: "n", mytsid: "" }])),
          )
        : undefined;
    const pub = await publishOne(client, streams);
    const seen: number[] = [];
    pub.on("request", (r) => seen.push(r.viewer.clientId));
    for (const clid of ["40", "9"]) {
      client.notify("notifyjoinstreamrequest", { id: pub.id, clid, msg: "", is_remove: "0" });
    }
    await settle();
    expect(seen).toEqual([]);
    release[0]!();
    await settle();
    expect(seen).toEqual([40, 9]);
  });

  it("does not announce a request withdrawn while its lookup was out", async () => {
    const { client, streams } = setup();
    let release!: () => void;
    client.answer = (r) =>
      r.command === "clientgetuidfromclid"
        ? new Promise((resolve) => (release = () => resolve([])))
        : undefined;
    const pub = await publishOne(client, streams);
    const seen: number[] = [];
    pub.on("request", (r) => seen.push(r.viewer.clientId));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "40", msg: "", is_remove: "0" });
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "40", msg: "", is_remove: "1" });
    release();
    await settle();
    expect(seen).toEqual([]);
  });

  // The app attaches after `await publish()`, and the server does not wait.
  it("keeps a request that arrives before a listener, for the first one", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "10", msg: "", is_remove: "0" });
    const seen: number[] = [];
    pub.on("request", (r) => seen.push(r.viewer.clientId));
    expect(seen).toEqual([9, 10]);
    const later: number[] = [];
    pub.on("request", (r) => later.push(r.viewer.clientId));
    expect(later).toEqual([]);
  });

  it("does not repeat a request from a viewer pending or connected", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    const ask = (): void =>
      client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    ask();
    ask();
    expect(requests).toHaveLength(1);
    await requests[0]!.accept("v=0");
    ask();
    expect(requests).toHaveLength(1);
  });

  it("answers an accepted request with the offer, and returns the peer", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { request, peer } = await admit(client, pub);
    const [respond] = client.commands("respondjoinstreamrequest") as [CommandRequest];
    expect(respond.params).toEqual([
      ["id", STREAM],
      ["clid", 9],
      ["msg", ""],
      ["offer", "v=0\r\n"],
      ["decision", true],
    ]);
    expect(request.state).toBe("accepted");
    expect(peer.clientId).toBe(9);
    expect(pub.viewers()).toEqual([peer]);
  });

  it("answers a denial with an empty offer and the reason", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    await requests[0]!.deny("Not today");
    const [respond] = client.commands("respondjoinstreamrequest") as [CommandRequest];
    expect(respond.params).toEqual([
      ["id", STREAM],
      ["clid", 9],
      ["msg", "Not today"],
      ["offer", ""],
      ["decision", false],
    ]);
    expect(requests[0]?.state).toBe("denied");
  });

  it("answers once: a second answer throws, and sends nothing", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { request } = await admit(client, pub);
    const sent = client.sent.length;
    await expect(request.accept("v=0")).rejects.toThrow(TeamspeakError);
    await expect(request.deny()).rejects.toThrow(/accepted/);
    expect(client.sent).toHaveLength(sent);
  });

  it("asks for a non-empty offer", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    await expect(requests[0]!.accept("")).rejects.toBeInstanceOf(RangeError);
    expect(requests[0]?.state).toBe("pending");
  });

  it("refuses an offer too long, and leaves the request to be answered again", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    await expect(requests[0]!.accept("a".repeat(20_000))).rejects.toBeInstanceOf(
      StreamPayloadTooLargeError,
    );
    expect(client.commands("respondjoinstreamrequest")).toEqual([]);
    expect(requests[0]?.state).toBe("pending");
    await requests[0]!.accept("v=0");
    expect(requests[0]?.state).toBe("accepted");
  });

  it("marks a request failed and closes its peer when the answer is refused", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    client.answer = () => Promise.reject(refusal(ErrorCode.StreamJoinRequestRedacted));
    await expect(requests[0]!.accept("v=0")).rejects.toBeInstanceOf(ServerError);
    expect(requests[0]?.state).toBe("failed");
    expect(pub.viewers()).toEqual([]);
    // The viewer may ask again, and is heard.
    client.answer = () => undefined;
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    expect(requests).toHaveLength(2);
  });

  it("drops a pending request the viewer withdrew", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "1" });
    expect(requests[0]?.state).toBe("withdrawn");
    await expect(requests[0]!.accept("v=0")).rejects.toThrow(/withdrawn/);
  });

  it("asks again after a denial is heard again, since the server forgets", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    const ask = (): void =>
      client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    ask();
    await requests[0]!.deny();
    ask();
    expect(requests).toHaveLength(2);
  });

  it("leaves a denied client unanswered when rememberDenied is on", async () => {
    const { client, streams } = setup({ rememberDenied: true });
    client.see(9);
    client.see(10);
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    const ask = (clid: string): void =>
      client.notify("notifyjoinstreamrequest", { id: pub.id, clid, msg: "", is_remove: "0" });
    ask("9");
    await requests[0]!.deny();
    ask("9");
    ask("10");
    expect(requests.map((r) => r.viewer.clientId)).toEqual([9, 10]);
    expect(client.commands("respondjoinstreamrequest")).toHaveLength(1);
  });

  it("remembers nothing by default", async () => {
    const { client, streams } = setup();
    client.see(9);
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    await requests[0]!.deny();
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    expect(requests).toHaveLength(2);
  });

  it("ignores a request for a stream it does not publish", () => {
    const { client } = setup();
    client.notify("notifyjoinstreamrequest", { id: "other", clid: "9", msg: "", is_remove: "0" });
    expect(client.sent).toEqual([]);
  });
});

describe("a viewer's peer, on the publisher's side", () => {
  it("delivers an answer and candidates, and sends candidates and offers", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const answers: string[] = [];
    const candidates: string[] = [];
    peer.on("answer", (sdp) => answers.push(sdp));
    peer.on("candidate", (c) => candidates.push(c.candidate));
    const signal = (cmd: string, args: unknown): void =>
      client.notify("notifystreamsignaling", {
        id: pub.id,
        clid: "9",
        json: JSON.stringify({ cmd, args }),
      });
    signal("answer", { answer: "v=0 answer" });
    signal("iceCandidate", { sdp: "candidate:1", mid: "0", mLine: 0 });
    expect(answers).toEqual(["v=0 answer"]);
    expect(candidates).toEqual(["candidate:1"]);

    await peer.sendCandidate({ candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 0 });
    await peer.sendOffer("v=0 again");
    const [first, second] = client.commands("streamsignaling") as [CommandRequest, CommandRequest];
    expect(first.params?.slice(0, 2)).toEqual([
      ["id", STREAM],
      ["clid", 9],
    ]);
    expect(JSON.parse(String(param(first, "json")))).toEqual({
      cmd: "iceCandidate",
      args: { sdp: "candidate:2", mid: "0", mLine: 0 },
    });
    expect(JSON.parse(String(param(second, "json")))).toEqual({
      cmd: "offer",
      args: { offer: "v=0 again" },
    });
  });

  // The viewer starts signalling as soon as it has the offer, which can be
  // before accept() returns, and before the app has added a listener.
  it("keeps what arrives before a listener, for the first listener of each event", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    let request: JoinRequest | undefined;
    pub.on("request", (r) => (request = r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    let release!: () => void;
    client.answer = (r) =>
      r.command === "respondjoinstreamrequest"
        ? new Promise((resolve) => (release = () => resolve([])))
        : undefined;
    const accepting = request!.accept("v=0");
    await settle();
    for (const n of [1, 2]) {
      client.notify("notifystreamsignaling", {
        id: pub.id,
        clid: "9",
        json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: `c${n}`, mid: "0", mLine: 0 } }),
      });
    }
    client.notify("notifystreamsignaling", {
      id: pub.id,
      clid: "9",
      json: JSON.stringify({ cmd: "answer", args: { answer: "early answer" } }),
    });
    release();
    const peer = await accepting;
    const seen: string[] = [];
    peer.on("candidate", (c) => seen.push(c.candidate));
    peer.on("answer", (sdp) => seen.push(sdp));
    expect(seen).toEqual(["c1", "c2", "early answer"]);
  });

  it("hands over messages it has no name for, and text that is no message", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const raw: Array<{ cmd: string; json: string }> = [];
    peer.on("signal", (s) => raw.push({ cmd: s.cmd, json: s.json }));
    client.notify("notifystreamsignaling", {
      id: pub.id,
      clid: "9",
      json: '{"cmd":"mute","args":1}',
    });
    client.notify("notifystreamsignaling", { id: pub.id, clid: "9", json: "garbage" });
    expect(raw).toEqual([
      { cmd: "mute", json: '{"cmd":"mute","args":1}' },
      { cmd: "", json: "garbage" },
    ]);
  });

  it("sends a message of the app's own", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    await peer.sendSignal("custom", { a: [1, "x y"] });
    const [sent] = client.commands("streamsignaling") as [CommandRequest];
    expect(JSON.parse(String(param(sent, "json")))).toEqual({
      cmd: "custom",
      args: { a: [1, "x y"] },
    });
  });

  it("refuses a message too long before sending", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    await expect(
      peer.sendCandidate({ candidate: " ".repeat(6000), sdpMid: "0", sdpMLineIndex: 0 }),
    ).rejects.toBeInstanceOf(StreamPayloadTooLargeError);
    expect(client.commands("streamsignaling")).toEqual([]);
  });

  it("closes when the viewer leaves, however it says so, once", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const closed: PeerClosed[] = [];
    peer.on("closed", (c) => closed.push(c));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "1" });
    client.notify("notifystreamclientleft", { id: pub.id, clid: "9", reason: "1" });
    expect(closed).toEqual([{ cause: "left" }]);
    expect(pub.viewers()).toEqual([]);
    await expect(
      peer.sendCandidate({ candidate: "c", sdpMid: null, sdpMLineIndex: null }),
    ).rejects.toThrow(/closed/);
  });

  it("does not close when another viewer leaves", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    client.notify("notifystreamclientleft", { id: pub.id, clid: "10", reason: "1" });
    expect(peer.closed).toBe(false);
  });

  it("closes without sending anything when the app closes it", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const sent = client.sent.length;
    await peer.close();
    await peer.close();
    expect(client.sent).toHaveLength(sent);
    expect(peer.closed).toBe(true);
  });
});

describe("stopping a stream", () => {
  it("sends stopstream with the reason, ends the stream here, and tells nobody else", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const ended: StreamEnded[] = [];
    const stopped: number[] = [];
    const closed: PeerClosed[] = [];
    pub.on("ended", (e) => ended.push(e));
    peer.on("closed", (c) => closed.push(c));
    streams.on("stopped", (e) => stopped.push(e.reason));

    await pub.stop(2);
    const [stop] = client.commands("stopstream") as [CommandRequest];
    expect(stop.params).toEqual([
      ["id", STREAM],
      ["reason", 2],
    ]);
    expect(ended).toEqual([{ cause: "stopped", reason: 2 }]);
    expect(closed).toEqual([{ cause: "stopped", reason: 2 }]);
    expect(stopped).toEqual([2]);
    expect(pub.ended).toBe(true);
    expect(streams.list()).toEqual([]);

    await pub.stop();
    expect(client.commands("stopstream")).toHaveLength(1);
  });

  it("defaults the reason to 0 and takes only integers", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    await expect(pub.stop(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(pub.stop(1.5)).rejects.toBeInstanceOf(RangeError);
    await pub.stop();
    expect(param(client.commands("stopstream")[0]!, "reason")).toBe(0);
  });

  it("counts a stream the server no longer knows as stopped", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    client.answer = (r) =>
      r.command === "stopstream" ? Promise.reject(refusal(ErrorCode.StreamNotFound)) : undefined;
    await pub.stop();
    expect(pub.ended).toBe(true);
  });

  it("leaves the stream running when the server refuses the command", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    client.answer = (r) =>
      r.command === "stopstream"
        ? Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient))
        : undefined;
    await expect(pub.stop()).rejects.toBeInstanceOf(ServerError);
    expect(pub.ended).toBe(false);
  });

  it("ends on the server's word, whoever stopped it, with the reason", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const ended: StreamEnded[] = [];
    const closed: PeerClosed[] = [];
    pub.on("ended", (e) => ended.push(e));
    peer.on("closed", (c) => closed.push(c));
    client.notify("notifystreamstopped", { clid: String(SELF), id: pub.id, reason: "1" });
    expect(ended).toEqual([{ cause: "server", reason: 1 }]);
    expect(closed).toEqual([{ cause: "stopped", reason: 1 }]);
    expect(client.commands("stopstream")).toEqual([]);
  });

  it("ends pending requests, which then cannot be answered", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    client.notify("notifystreamstopped", { clid: String(SELF), id: pub.id, reason: "0" });
    expect(requests[0]?.state).toBe("ended");
    await expect(requests[0]!.accept("v=0")).rejects.toThrow(/ended/);
  });

  it("keeps the ended event for a listener that comes late", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    client.notify("notifystreamstopped", { clid: String(SELF), id: pub.id, reason: "0" });
    const ended: StreamEnded[] = [];
    pub.on("ended", (e) => ended.push(e));
    expect(ended).toHaveLength(1);
  });
});

describe("watch", () => {
  it("asks, and resolves with the offer when the publisher accepts", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM, { message: "may I | please" });
    await settle();
    const [join] = client.commands("joinstreamrequest") as [CommandRequest];
    expect(join.params).toEqual([
      ["id", STREAM],
      ["clid", OTHER],
      ["msg", "may I | please"],
      ["is_remove", false],
    ]);
    client.notify("notifyrespondjoinstreamrequest", {
      clid: String(OTHER),
      id: STREAM,
      msg: "",
      decision: "1",
      offer: "v=0\r\no=- 1\r\n",
    });
    const view = await promise;
    expect(view.offer).toBe("v=0\r\no=- 1\r\n");
    expect(view.streamId).toBe(STREAM);
    expect(view.clientId).toBe(OTHER);
  });

  it("takes a StreamInfo for a stream it has not heard of", async () => {
    const { client, streams } = setup();
    const info: StreamInfo = { id: "z", clientId: asClientID(4), name: "n", audio: false };
    const promise = streams.watch(info);
    await settle();
    expect(param(client.commands("joinstreamrequest")[0]!, "clid")).toBe(4);
    client.notify("notifyrespondjoinstreamrequest", {
      id: "z",
      msg: "",
      decision: "1",
      offer: "o",
    });
    await promise;
  });

  it("rejects an id it knows nothing of, without sending", async () => {
    const { client, streams } = setup();
    await expect(streams.watch("nope")).rejects.toThrow(/not known/);
    expect(client.sent).toEqual([]);
  });

  it("rejects with the publisher's message when it denies", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM);
    await settle();
    client.notify("notifyrespondjoinstreamrequest", {
      clid: String(OTHER),
      id: STREAM,
      msg: "Denied | sorry",
      decision: "0",
    });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamJoinDeniedError);
    expect((error as StreamJoinDeniedError).serverMessage).toBe("Denied | sorry");
    // The server forgot the refusal: asking again is allowed.
    const again = streams.watch(STREAM);
    await settle();
    expect(client.commands("joinstreamrequest")).toHaveLength(2);
    client.notify("notifyrespondjoinstreamrequest", {
      id: STREAM,
      msg: "",
      decision: "1",
      offer: "o",
    });
    await again;
  });

  it("rejects an acceptance without an offer, and withdraws", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM);
    await settle();
    client.notify("notifyrespondjoinstreamrequest", { id: STREAM, msg: "", decision: "1" });
    await expect(promise).rejects.toThrow(/without an offer/);
    await settle();
    expect(param(client.commands("joinstreamrequest")[1]!, "is_remove")).toBe(true);
  });

  it("surfaces 5638 as the server's error, and 5635 as a stream that ended", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    client.answer = () => Promise.reject(refusal(ErrorCode.StreamAlreadyJoined));
    const joined = await streams.watch(STREAM).catch((e: unknown) => e);
    expect(joined).toBeInstanceOf(ServerError);
    expect((joined as ServerError).code).toBe(ErrorCode.StreamAlreadyJoined);

    client.answer = () => Promise.reject(refusal(ErrorCode.StreamNotFound));
    const gone = await streams.watch(STREAM).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(StreamEndedError);
    expect((gone as StreamEndedError).cause).toBeInstanceOf(ServerError);
  });

  it("rejects when the stream stops before the publisher answers", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM);
    await settle();
    client.notify("notifystreamstopped", { clid: String(OTHER), id: STREAM, reason: "1" });
    await expect(promise).rejects.toBeInstanceOf(StreamEndedError);
  });

  it("withdraws the request when the wait runs out", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    await expect(streams.watch(STREAM, { timeoutMs: 20 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    await settle();
    expect(param(client.commands("joinstreamrequest")[1]!, "is_remove")).toBe(true);
    // And it can ask again.
    const again = streams.watch(STREAM, { timeoutMs: 20 });
    await expect(again).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it("withdraws the request when the signal aborts", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const controller = new AbortController();
    const promise = streams.watch(STREAM, { signal: controller.signal });
    await settle();
    controller.abort(new Error("changed my mind"));
    await expect(promise).rejects.toThrow("changed my mind");
    await settle();
    expect(param(client.commands("joinstreamrequest")[1]!, "is_remove")).toBe(true);
  });

  it("will not watch a stream twice", async () => {
    const { client, streams } = setup();
    await watchOne(client, streams);
    await expect(streams.watch(STREAM)).rejects.toThrow(/already watching/);
  });

  // TS6 starts sending candidates right after the offer, before the app has
  // awaited the view, and before it has a listener.
  it("keeps what arrives with the offer, for the first listener", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM);
    await settle();
    client.notify("notifystreamsignaling", {
      id: STREAM,
      clid: String(OTHER),
      json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: "c0", mid: "0", mLine: 0 } }),
    });
    client.notify("notifyrespondjoinstreamrequest", {
      id: STREAM,
      msg: "",
      decision: "1",
      offer: "o",
    });
    for (const n of [1, 2]) {
      client.notify("notifystreamsignaling", {
        id: STREAM,
        clid: String(OTHER),
        json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: `c${n}`, mid: "0", mLine: 0 } }),
      });
    }
    const view = await promise;
    const seen: string[] = [];
    view.on("candidate", (c) => seen.push(c.candidate));
    expect(seen).toEqual(["c0", "c1", "c2"]);
  });

  it("sends the answer and candidates to the publisher", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    await view.answer("v=0 answer");
    await view.sendCandidate({ candidate: "candidate:9", sdpMid: "0", sdpMLineIndex: 0 });
    const [answer, candidate] = client.commands("streamsignaling") as [
      CommandRequest,
      CommandRequest,
    ];
    expect(answer.params?.slice(0, 2)).toEqual([
      ["id", STREAM],
      ["clid", OTHER],
    ]);
    expect(JSON.parse(String(param(answer, "json")))).toEqual({
      cmd: "answer",
      args: { answer: "v=0 answer" },
    });
    expect(JSON.parse(String(param(candidate, "json"))).cmd).toBe("iceCandidate");
  });

  it("delivers a renegotiation offer", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    const offers: string[] = [];
    view.on("offer", (sdp) => offers.push(sdp));
    client.notify("notifystreamsignaling", {
      id: STREAM,
      clid: String(OTHER),
      json: JSON.stringify({ cmd: "reconnectOffer", args: { offer: "v=0 new" } }),
    });
    expect(offers).toEqual(["v=0 new"]);
  });

  it("leaves with is_remove, once", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    const closed: PeerClosed[] = [];
    view.on("closed", (c) => closed.push(c));
    await view.leave();
    await view.leave();
    await view.close();
    const joins = client.commands("joinstreamrequest");
    expect(joins).toHaveLength(2);
    expect(param(joins[1]!, "is_remove")).toBe(true);
    expect(closed).toEqual([{ cause: "closed" }]);
    // The stream is still known, and can be watched again.
    const again = streams.watch(STREAM);
    await settle();
    client.notify("notifyrespondjoinstreamrequest", {
      id: STREAM,
      msg: "",
      decision: "1",
      offer: "o",
    });
    await again;
  });

  it("leaves quietly when the stream is gone or the connection is", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    client.answer = () => Promise.reject(refusal(ErrorCode.StreamNotFound));
    await view.leave();
    expect(view.closed).toBe(true);
  });

  it("raises any other failure to leave", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    client.answer = () => Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient));
    await expect(view.leave()).rejects.toBeInstanceOf(ServerError);
    expect(view.closed).toBe(true);
  });

  it("stays when another viewer leaves, and closes when it is itself the one", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    const closed: PeerClosed[] = [];
    view.on("closed", (c) => closed.push(c));
    client.notify("notifystreamclientleft", { id: STREAM, clid: "12", reason: "1" });
    expect(view.closed).toBe(false);
    client.notify("notifystreamclientleft", { id: STREAM, clid: String(SELF), reason: "1" });
    expect(closed).toEqual([{ cause: "left" }]);
  });

  it("closes with the reason when the stream stops", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    const closed: PeerClosed[] = [];
    view.on("closed", (c) => closed.push(c));
    client.notify("notifystreamstopped", { clid: String(OTHER), id: STREAM, reason: "1" });
    expect(closed).toEqual([{ cause: "stopped", reason: 1 }]);
    expect(streams.get(STREAM)).toBeUndefined();
  });

  it("stays when the publisher changes channel or leaves view", async () => {
    const { client, streams } = setup();
    const view = await watchOne(client, streams);
    client.emit("clientMoved", { clientID: asClientID(OTHER) });
    client.emit("clientLeave", { clientID: asClientID(OTHER) });
    expect(view.closed).toBe(false);
    expect(streams.get(STREAM)).toBeDefined();
  });

  it("reports signalling from a client it has no session with", () => {
    const { client, streams } = setup();
    const errors: Error[] = [];
    streams.on("error", (e) => errors.push(e));
    client.notify("notifystreamsignaling", { id: "nope", clid: "3", json: "{}" });
    expect(errors).toHaveLength(1);
  });
});

describe("cleanup", () => {
  it("ends every session once when the connection ends, and forgets what it knew", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    client.notify("notifystreamstarted", started({ id: "other-stream" }));
    const view = await (async () => {
      const promise = streams.watch("other-stream");
      await settle();
      client.notify("notifyrespondjoinstreamrequest", {
        id: "other-stream",
        msg: "",
        decision: "1",
        offer: "o",
      });
      return promise;
    })();

    const ended: StreamEnded[] = [];
    const peerClosed: PeerClosed[] = [];
    const viewClosed: PeerClosed[] = [];
    pub.on("ended", (e) => ended.push(e));
    peer.on("closed", (c) => peerClosed.push(c));
    view.on("closed", (c) => viewClosed.push(c));
    client.status = "disconnected";
    client.emit("disconnected", { error: undefined, willReconnect: true });
    client.emit("disconnected", { error: undefined, willReconnect: true });

    expect(ended).toEqual([{ cause: "disconnected", reason: 0 }]);
    expect(peerClosed).toEqual([{ cause: "disconnected" }]);
    expect(viewClosed).toEqual([{ cause: "disconnected" }]);
    expect(streams.list()).toEqual([]);
    // Nothing is sent for a connection that is gone; least of all stopstream.
    expect(client.commands("stopstream")).toEqual([]);
    expect(client.commands("joinstreamrequest")).toHaveLength(1);
  });

  it("rejects a watch pending at the end of the connection", async () => {
    const { client, streams } = setup();
    client.notify("notifystreamstarted", started());
    const promise = streams.watch(STREAM);
    await settle();
    client.emit("disconnected", { error: undefined, willReconnect: false });
    await expect(promise).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("looks the streams up again after a reconnection", () => {
    const { client } = setup();
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    client.emit("disconnected", { error: undefined, willReconnect: true });
    client.emit("clientEnter", { id: asClientID(5), isStreaming: true });
    expect(client.commands("requeststreaminfo")).toHaveLength(2);
  });

  it("detaches and ends everything on dispose, once", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const ended: StreamEnded[] = [];
    const closed: PeerClosed[] = [];
    pub.on("ended", (e) => ended.push(e));
    peer.on("closed", (c) => closed.push(c));
    streams.dispose();
    streams.dispose();
    expect(ended).toEqual([{ cause: "disposed", reason: 0 }]);
    expect(closed).toEqual([{ cause: "disposed" }]);
    for (const event of [
      "notification",
      "clientEnter",
      "clientUpdated",
      "clientLeave",
      "disconnected",
    ]) {
      expect(client.listenerCount(event)).toBe(0);
    }
    await expect(streams.publish({ name: "x" })).rejects.toThrow(/disposed/);
    await expect(streams.watch(STREAM)).rejects.toThrow(/disposed/);
    // Connected, so the server is told once: the stream is stopped.
    expect(client.commands("stopstream")).toHaveLength(1);
  });

  it("tells the server on dispose: stops what it published, leaves what it watched", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    client.notify("notifystreamstarted", started({ id: "theirs" }));
    const promise = streams.watch("theirs");
    await settle();
    client.notify("notifyrespondjoinstreamrequest", {
      id: "theirs",
      msg: "",
      decision: "1",
      offer: "o",
    });
    await promise;
    streams.dispose();
    await settle();
    expect(client.commands("stopstream").map((r) => param(r, "id"))).toEqual([pub.id]);
    const joins = client.commands("joinstreamrequest");
    expect(joins).toHaveLength(2);
    expect(param(joins[1]!, "id")).toBe("theirs");
    expect(param(joins[1]!, "is_remove")).toBe(true);
  });

  it("reports a failure of the goodbye to the error event, which still has its listeners", async () => {
    const { client, streams } = setup();
    await publishOne(client, streams);
    const errors: Error[] = [];
    streams.on("error", (e) => errors.push(e));
    client.answer = (r) =>
      r.command === "stopstream"
        ? Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient))
        : undefined;
    streams.dispose();
    await settle();
    expect(errors).toHaveLength(1);
  });

  it("sends nothing on dispose when the connection is gone", async () => {
    const { client, streams } = setup();
    await publishOne(client, streams);
    client.status = "disconnected";
    streams.dispose();
    await settle();
    expect(client.commands("stopstream")).toEqual([]);
  });

  it("clears the remembered denials on dispose", async () => {
    const { client, streams } = setup({ rememberDenied: true });
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    client.notify("notifyjoinstreamrequest", { id: pub.id, clid: "9", msg: "", is_remove: "0" });
    await requests[0]!.deny();
    streams.dispose();
    // A new Streams on the same client starts with none, and the old holds none either.
    const again = new Streams(client, { rememberDenied: true });
    const second = await publishOne(client, again, "second", "second");
    const seen: JoinRequest[] = [];
    second.on("request", (r) => seen.push(r));
    client.notify("notifyjoinstreamrequest", { id: "second", clid: "9", msg: "", is_remove: "0" });
    expect(seen).toHaveLength(1);
  });

  it("does not let a throwing listener stop the others", async () => {
    const { client, streams } = setup();
    const seen: string[] = [];
    const uncaught = vi.fn<(error: Error) => void>();
    process.once("uncaughtException", uncaught);
    streams.on("started", () => {
      throw new Error("boom");
    });
    streams.on("started", (info) => seen.push(info.id));
    client.notify("notifystreamstarted", started());
    await settle();
    expect(seen).toEqual([STREAM]);
    expect(uncaught).toHaveBeenCalledTimes(1);
  });
});

describe("review fixes", () => {
  const ask = (client: FakeClient, id: string, clid: string, remove = "0"): void =>
    client.notify("notifyjoinstreamrequest", { id, clid, msg: "", is_remove: remove });

  describe("matching a publish to its announcement", () => {
    it("does not adopt an own stream of another name", async () => {
      const { client, streams } = setup();
      const promise = streams.publish({ name: "wanted", timeoutMs: 30 });
      await settle();
      client.notify("notifystreamstarted", started({ clid: String(SELF), name: "other" }));
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
    });

    it("never lets a second publish adopt the first's stream", async () => {
      const { client, streams } = setup();
      const first = streams.publish({ name: "same", timeoutMs: 40 });
      const second = streams.publish({ name: "same", timeoutMs: 2000 });
      await settle();
      expect(client.commands("setupstream")).toHaveLength(1);
      await expect(first).rejects.toBeInstanceOf(CommandTimeoutError);
      await settle();
      expect(client.commands("setupstream")).toHaveLength(2);
      // The first one's stream arrives late: it is stopped, and the second waits for its own.
      client.notify(
        "notifystreamstarted",
        started({ clid: String(SELF), id: "late", name: "same" }),
      );
      await settle();
      expect(client.commands("stopstream").map((r) => param(r, "id"))).toEqual(["late"]);
      expect(streams.get("late")).toBeUndefined();
      client.notify(
        "notifystreamstarted",
        started({ clid: String(SELF), id: "own", name: "same" }),
      );
      expect((await second).id).toBe("own");
    });

    it("stops a stream whose publish was aborted after the command went out", async () => {
      const { client, streams } = setup();
      const controller = new AbortController();
      const promise = streams.publish({ name: "gone", signal: controller.signal });
      await settle();
      controller.abort(new Error("changed my mind"));
      await expect(promise).rejects.toThrow("changed my mind");
      client.notify(
        "notifystreamstarted",
        started({ clid: String(SELF), id: "orphan", name: "gone" }),
      );
      await settle();
      expect(client.commands("stopstream").map((r) => param(r, "id"))).toEqual(["orphan"]);
    });

    it("does not stop anything when the server refused the command", async () => {
      const { client, streams } = setup();
      client.answer = () => Promise.reject(refusal(ErrorCode.PermissionsClientInsufficient));
      await expect(streams.publish({ name: "refused" })).rejects.toBeInstanceOf(ServerError);
      client.notify(
        "notifystreamstarted",
        started({ clid: String(SELF), id: "x", name: "refused" }),
      );
      expect(client.commands("stopstream")).toEqual([]);
    });
  });

  describe("a publisher that stops streaming", () => {
    const clear = (client: FakeClient, id = OTHER): void =>
      client.emit("clientUpdated", { clientID: asClientID(id), changes: { isStreaming: false } });
    /** Fake timers for the rest of a test whose setup needed real ones. */
    const fake = (): void => {
      vi.useFakeTimers();
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it("drops its streams, with the cause gone, once the flag has stayed clear for the grace", () => {
      fake();
      const { client, streams } = setup();
      const stopped: Array<[string, string]> = [];
      streams.on("stopped", (e) => stopped.push([e.info.id, e.cause]));
      client.notify("notifystreamstarted", started({ id: "a" }));
      client.notify("notifystreamstarted", started({ id: "b" }));
      clear(client);
      // A hint only: nothing ends at once.
      expect(streams.list()).toHaveLength(2);
      vi.advanceTimersByTime(1999);
      expect(streams.list()).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(streams.list()).toEqual([]);
      expect(stopped).toEqual([
        ["a", "gone"],
        ["b", "gone"],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("lets the stop notification that follows the clear win, with its reason", () => {
      fake();
      const { client, streams } = setup();
      const stopped: Array<[string, string, number]> = [];
      streams.on("stopped", (e) => stopped.push([e.info.id, e.cause, e.reason]));
      client.notify("notifystreamstarted", started({ id: "a" }));
      clear(client);
      client.notify("notifystreamstopped", { id: "a", reason: "3" });
      expect(stopped).toEqual([["a", "server", 3]]);
      // Nothing is left to end, and no timer is left running.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(stopped).toHaveLength(1);
    });

    it("cancels the end when the flag is set again within the grace", () => {
      fake();
      const { client, streams } = setup();
      client.notify("notifystreamstarted", started({ id: "a" }));
      clear(client);
      vi.advanceTimersByTime(1000);
      client.emit("clientUpdated", {
        clientID: asClientID(OTHER),
        changes: { isStreaming: true },
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(streams.list().map((x) => x.id)).toEqual(["a"]);
    });

    it("does not run the end after dispose, and leaves no timer", () => {
      fake();
      const { client, streams } = setup();
      const stopped: string[] = [];
      streams.on("stopped", (e) => stopped.push(e.info.id));
      client.notify("notifystreamstarted", started({ id: "a" }));
      clear(client);
      expect(vi.getTimerCount()).toBe(1);
      streams.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(stopped).toEqual([]);
    });

    it("leaves no timer when the connection ends", () => {
      fake();
      const { client, streams } = setup();
      client.notify("notifystreamstarted", started({ id: "a" }));
      clear(client);
      client.emit("disconnected", undefined);
      expect(vi.getTimerCount()).toBe(0);
      expect(streams.list()).toEqual([]);
    });

    it("drops its streams after the grace when it comes into view not streaming", () => {
      fake();
      const { client, streams } = setup();
      client.notify("notifystreamstarted", started());
      client.emit("clientEnter", { id: asClientID(OTHER), isStreaming: false });
      expect(streams.list()).toHaveLength(1);
      vi.advanceTimersByTime(2000);
      expect(streams.list()).toEqual([]);
    });

    it("keeps a stream when the flag says nothing, and the streams of others", () => {
      fake();
      const { client, streams } = setup();
      client.notify("notifystreamstarted", started());
      client.notify("notifystreamstarted", started({ id: "z", clid: "30" }));
      client.emit("clientUpdated", { clientID: asClientID(OTHER), changes: { isAway: true } });
      clear(client);
      vi.advanceTimersByTime(5000);
      expect(streams.list().map((s) => s.id)).toEqual(["z"]);
    });

    it("ends the viewer's side of a stream that is gone, after the grace", async () => {
      const { client, streams } = setup();
      const view = await watchOne(client, streams);
      fake();
      const closed: PeerClosed[] = [];
      view.on("closed", (c) => closed.push(c));
      clear(client);
      expect(closed).toEqual([]);
      vi.advanceTimersByTime(2000);
      expect(closed).toEqual([{ cause: "stopped", reason: 0 }]);
    });

    it("keeps the real reason for a viewer when the stop follows the clear", async () => {
      const { client, streams } = setup();
      const view = await watchOne(client, streams);
      fake();
      const closed: PeerClosed[] = [];
      view.on("closed", (c) => closed.push(c));
      clear(client);
      client.notify("notifystreamstopped", { id: view.streamId, reason: "3" });
      expect(closed).toEqual([{ cause: "stopped", reason: 3 }]);
    });
  });

  it("forgets a pending request when its client leaves view, so a reused clid is heard", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    ask(client, pub.id, "9");
    client.emit("clientLeave", { clientID: asClientID(9) });
    expect(requests[0]?.state).toBe("withdrawn");
    ask(client, pub.id, "9");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.state).toBe("pending");
  });

  it("ignores what a closed viewer still sends, without an error", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const { peer } = await admit(client, pub);
    const errors: Error[] = [];
    streams.on("error", (e) => errors.push(e));
    await peer.close();
    client.notify("notifystreamsignaling", {
      id: pub.id,
      clid: "9",
      json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: "c", mid: "0", mLine: 0 } }),
    });
    await settle();
    expect(errors).toEqual([]);
    // Another client with no session is still reported.
    client.notify("notifystreamsignaling", { id: pub.id, clid: "77", json: "{}" });
    await settle();
    expect(errors).toHaveLength(1);
  });

  it("bounds the remembered denials to the most recent 1024", async () => {
    const { client, streams } = setup({ rememberDenied: true });
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    for (let clid = 100; clid < 100 + 1030; clid++) {
      client.see(clid);
      ask(client, pub.id, String(clid));
      await requests.at(-1)!.deny();
    }
    const before = requests.length;
    // The oldest was forgotten, the newest is remembered.
    ask(client, pub.id, "100");
    ask(client, pub.id, String(100 + 1029));
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)?.viewer.clientId).toBe(100);
  });

  describe("events nobody listens for", () => {
    it("keeps errors for the first listener, and then delivers them live", async () => {
      const { client, streams } = setup();
      client.notify("notifystreamsignaling", { id: "nope", clid: "3", json: "{}" });
      client.notify("notifystreamsignaling", { id: "nope2", clid: "3", json: "{}" });
      const errors: Error[] = [];
      streams.on("error", (e) => errors.push(e));
      expect(errors).toHaveLength(2);
      client.notify("notifystreamsignaling", { id: "nope3", clid: "3", json: "{}" });
      expect(errors).toHaveLength(3);
    });

    it("drops the oldest past the bound, and reports an overflowing peer once", async () => {
      const { client, streams } = setup();
      const errors: Error[] = [];
      streams.on("error", (e) => errors.push(e));
      const pub = await publishOne(client, streams);
      const { peer } = await admit(client, pub);
      for (let n = 0; n < 300; n++) {
        client.notify("notifystreamsignaling", {
          id: pub.id,
          clid: "9",
          json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: `c${n}`, mid: "0", mLine: 0 } }),
        });
      }
      expect(errors).toHaveLength(1);
      const seen: string[] = [];
      peer.on("candidate", (c) => seen.push(c.candidate));
      expect(seen).toHaveLength(256);
      expect(seen[0]).toBe("c44");
      expect(seen.at(-1)).toBe("c299");
    });

    it("drops the oldest signalling before the answer, and reports it once", async () => {
      const { client, streams } = setup();
      const errors: Error[] = [];
      streams.on("error", (e) => errors.push(e));
      client.notify("notifystreamstarted", started());
      const promise = streams.watch(STREAM);
      await settle();
      for (let n = 0; n < 300; n++) {
        client.notify("notifystreamsignaling", {
          id: STREAM,
          clid: String(OTHER),
          json: JSON.stringify({ cmd: "iceCandidate", args: { sdp: `c${n}`, mid: "0", mLine: 0 } }),
        });
      }
      client.notify("notifyrespondjoinstreamrequest", {
        id: STREAM,
        msg: "",
        decision: "1",
        offer: "o",
      });
      const view = await promise;
      expect(errors).toHaveLength(1);
      const seen: string[] = [];
      view.on("candidate", (c) => seen.push(c.candidate));
      expect(seen[0]).toBe("c44");
      expect(seen).toHaveLength(256);
    });
  });

  it("sends the message given to accept", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    ask(client, pub.id, "9");
    await requests[0]!.accept("v=0", "welcome | aboard");
    expect(param(client.commands("respondjoinstreamrequest")[0]!, "msg")).toBe("welcome | aboard");
  });

  it("rejects watch of an unknown id with a StreamEndedError", async () => {
    const { client, streams } = setup();
    const error = await streams.watch("nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamEndedError);
    expect((error as StreamEndedError).streamId).toBe("nope");
    expect(client.sent).toEqual([]);
  });

  it("says why a published stream ended, so a reason of 0 is not ambiguous", async () => {
    const { client, streams } = setup();
    const pub = await publishOne(client, streams);
    vi.useFakeTimers();
    try {
      const ended: StreamEnded[] = [];
      pub.on("ended", (e) => ended.push(e));
      client.emit("clientUpdated", { clientID: client.clientID, changes: { isStreaming: false } });
      vi.advanceTimersByTime(2000);
      expect(ended).toEqual([{ cause: "gone", reason: 0 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
