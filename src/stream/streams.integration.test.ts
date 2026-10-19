/**
 * Live tests of streams: two or three voice clients on a real server, signalling
 * a stream between them.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set. On a TeamSpeak 6 server they exercise the whole flow;
 * on a TeamSpeak 3 server only that streams are refused up front, and the rest
 * skips. The server needs a second channel (TEAMSPEAK_PASSWORD_CHANNEL) for the
 * tests that move a client.
 *
 *   TEAMSPEAK_ADDR=127.0.0.1:9988 pnpm vitest run --project integration src/stream/streams.integration.test.ts --reporter=verbose
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import {
  CommandTimeoutError,
  ErrorCode,
  ServerError,
  asChannelID,
  moveClient,
  whoAmI,
} from "@honeybbq/teamspeak";
import type { ChannelID, Unsubscribe } from "@honeybbq/teamspeak";
import { Client } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { encodeRequest } from "../core/internal.js";
import {
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
  StreamStoppedEvent,
  StreamView,
  ViewerPeer,
} from "./types.js";
import { MAX_COMMAND_LINE_BYTES, signalRequest } from "./wire.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const OTHER_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const OTHER_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const SKIP = !ADDR;
const EVENT_MS = 8_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Connect a client, trying again: a datagram can be dropped, and the server's anti-flood is touchy. */
async function connectClient(nickname: string, channel = DEFAULT_CHANNEL): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: channel,
    ...(channel === OTHER_CHANNEL ? { defaultChannelPassword: OTHER_CHANNEL_PASSWORD } : {}),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2_000);
    }
  }
  await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  await sleep(300);
  return client;
}

/** Resolve with what `register`'s listener gets first and `match` accepts; reject after EVENT_MS. */
function first<T>(
  label: string,
  register: (listener: (value: T) => void) => Unsubscribe,
  match: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${label} arrived`));
    }, EVENT_MS);
    const off = register((value) => {
      if (!match(value)) return;
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}

/** Collect `count` values, in order; reject after EVENT_MS. */
function collect<T>(
  label: string,
  count: number,
  register: (listener: (value: T) => void) => Unsubscribe,
  ms = EVENT_MS,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const seen: T[] = [];
    const timer = setTimeout(() => {
      off();
      reject(new Error(`only ${seen.length} of ${count} ${label} arrived`));
    }, ms);
    const off = register((value) => {
      seen.push(value);
      if (seen.length < count) return;
      clearTimeout(timer);
      off();
      resolve(seen);
    });
  });
}

/** An SDP-looking text of about `size` characters, with the characters the wire has to escape. */
function sdpLike(size: number): string {
  const lines = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
    "c=IN IP4 0.0.0.0",
    "a=rtcp-mux",
    "a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
    'a=note:quotes " pipes | back\\slash ünï 日本 😀',
  ];
  let sdp = "";
  for (let i = 0; sdp.length < size; i++) sdp += `${lines[i % lines.length]}\r\n`;
  return sdp.slice(0, size);
}

const candidate = (n: number): { candidate: string; sdpMid: string; sdpMLineIndex: number } => ({
  candidate: `candidate:${n} 1 udp 2122260223 192.168.0.${n % 250} ${50000 + n} typ host generation 0`,
  sdpMid: "0",
  sdpMLineIndex: 0,
});

describe.skipIf(SKIP)("Streams — live", { timeout: 30_000 }, () => {
  let a: Client;
  let b: Client;
  let family: string;
  let alpha: ChannelID;
  let other: ChannelID;
  const extra: Client[] = [];
  const streams: Streams[] = [];

  /** Streams on a client, disposed after the test. */
  function attach(client: Client, options?: { rememberDenied?: boolean }): Streams {
    const s = new Streams(client, options);
    streams.push(s);
    return s;
  }

  function ts6(ctx: TestContext): void {
    if (family !== "ts6") ctx.skip();
  }

  /** Publish from `a` and have `b` ask, so that the test has an accepted viewer. */
  async function connectedPair(): Promise<{
    publisher: Streams;
    viewer: Streams;
    pub: PublishedStream;
    peer: ViewerPeer;
    view: StreamView;
  }> {
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "pair" });
    const info = await learned;
    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const watching = viewer.watch(info, { message: "pair" });
    const request = await requested;
    const peer = await request.accept(sdpLike(2500));
    const view = await watching;
    return { publisher, viewer, pub, peer, view };
  }

  beforeAll(async () => {
    a = await connectClient("ts-js-stream-a");
    b = await connectClient("ts-js-stream-b");
    family = a.serverCapabilities.family;
    for (const channel of a.view.channels.values()) {
      if (channel.name === DEFAULT_CHANNEL) alpha = channel.id;
      if (channel.name === OTHER_CHANNEL) other = channel.id;
    }
    alpha ??= asChannelID(0n);
    other ??= asChannelID(0n);
  }, 60_000);

  afterEach(async () => {
    const closing = streams.splice(0);
    // Stops what the test published, so the next one starts clean.
    await Promise.all(closing.map((s) => stopAll(s)));
    for (const s of closing) s.dispose();
    for (const client of extra.splice(0)) await client.disconnect().catch(() => {});
    // Both back in the first channel.
    for (const client of [a, b]) {
      if (client.status === "connected" && client.channelID !== alpha && alpha !== 0n) {
        await moveClient(client, client.clientID, alpha).catch(() => {});
      }
    }
    await sleep(300);
  }, 30_000);

  afterAll(async () => {
    for (const client of [a, b, ...extra]) await client?.disconnect().catch(() => {});
  }, 20_000);

  async function stopAll(s: Streams): Promise<void> {
    for (const info of s.list()) {
      // Only streams this client published, which stop() is the way to end.
      if (info.clientId === a.clientID || info.clientId === b.clientID) {
        await a
          .send({
            command: "stopstream",
            params: [
              ["id", info.id],
              ["reason", 0],
            ],
          })
          .catch(() => {});
      }
    }
  }

  it("sees a stream start in its channel, with what the publisher announced", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({
      name: "Demo | stream",
      source: "window",
      audio: true,
      accessibility: "contacts",
      viewerLimit: 4,
    });
    const info = await learned;
    expect(info.id).toBe(pub.id);
    expect(info).toMatchObject({
      clientId: a.clientID,
      name: "Demo | stream",
      source: "window",
      audio: true,
      accessibility: "contacts",
      viewerLimit: 4,
    });
    expect(viewer.list().map((s) => s.id)).toEqual([pub.id]);
    expect(publisher.get(pub.id)?.name).toBe("Demo | stream");
  });

  it("finds a stream that was running before the client came", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const pub = await publisher.publish({ name: "already running", audio: true });
    const late = await connectClient("ts-js-stream-late");
    extra.push(late);
    const seen = attach(late);
    // Nothing announced it to the client: the flag on the client, and a request, did.
    if (seen.list().length === 0) await first<StreamInfo>("started", (l) => seen.on("started", l));
    const info = seen.get(pub.id);
    expect(info).toMatchObject({ name: "already running", clientId: a.clientID, audio: true });
    expect(info?.viewers).toBe(0);
  });

  it("finds a stream when the client moves into the channel it runs in", async (ctx) => {
    ts6(ctx);
    if (other === 0n) ctx.skip();
    const late = await connectClient("ts-js-stream-mover", OTHER_CHANNEL);
    extra.push(late);
    const seen = attach(late);
    const publisher = attach(a);
    const pub = await publisher.publish({ name: "in alpha" });
    await sleep(500);
    expect(seen.get(pub.id)).toBeUndefined();
    const learned = first<StreamInfo>("started", (l) => seen.on("started", l));
    await moveClient(late, late.clientID, alpha);
    expect((await learned).id).toBe(pub.id);
  });

  it("knows every stream of a client, and stopping one leaves the other", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const first1 = await publisher.publish({ name: "one" });
    const second = await publisher.publish({ name: "two", source: "camera" });
    expect(first1.id).not.toBe(second.id);
    const late = await connectClient("ts-js-stream-late2");
    extra.push(late);
    const seen = attach(late);
    await first<StreamInfo[]>("both streams", (l) => {
      const check = (): void => {
        if (seen.list().length >= 2) l(seen.list() as StreamInfo[]);
      };
      check();
      return seen.on("started", check);
    });
    expect(
      seen
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["one", "two"]);

    const stopped = first<StreamStoppedEvent>("stopped", (l) => seen.on("stopped", l));
    await first1.stop();
    expect((await stopped).info.id).toBe(first1.id);
    expect(seen.list().map((s) => s.name)).toEqual(["two"]);
    expect(second.ended).toBe(false);
  });

  it("carries the offer, the answer and the candidates both ways, byte for byte", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "signalling" });
    const info = await learned;

    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const watching = viewer.watch(info, { message: "let me in | please ü" });
    const request = await requested;
    expect(request.viewer.clientId).toBe(b.clientID);
    expect(request.viewer.uid).toBe(b.uid);
    expect(request.message).toBe("let me in | please ü");

    const offer = sdpLike(3000);
    const peer = await request.accept(offer);
    const view = await watching;
    expect(view.offer).toBe(offer);

    const fromViewer = collect<string>("candidates", 12, (l) =>
      peer.on("candidate", (c) => l(c.candidate)),
    );
    const fromPublisher = collect<string>("candidates", 12, (l) =>
      view.on("candidate", (c) => l(c.candidate)),
    );
    const answered = first<string>("answer", (l) => peer.on("answer", l));
    const answer = sdpLike(2800).replace("o=- 4611731400430051336", "o=- 1");
    await view.answer(answer);
    expect(await answered).toBe(answer);
    for (let n = 0; n < 12; n++) {
      await view.sendCandidate(candidate(n));
      await peer.sendCandidate(candidate(100 + n));
    }
    expect(await fromViewer).toEqual(Array.from({ length: 12 }, (_, n) => candidate(n).candidate));
    expect(await fromPublisher).toEqual(
      Array.from({ length: 12 }, (_, n) => candidate(100 + n).candidate),
    );
    expect(pub.viewers()).toHaveLength(1);
  });

  it("delivers what the publisher sends right behind the offer to a listener added later", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "early" });
    const info = await learned;
    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const watching = viewer.watch(info);
    const peer = await (await requested).accept(sdpLike(1500));
    // Sent at once, not awaited: the viewer has no listener when they arrive.
    const sent = Promise.all(Array.from({ length: 8 }, (_, n) => peer.sendCandidate(candidate(n))));
    const view = await watching;
    await sent;
    await sleep(500);
    const seen: string[] = [];
    view.on("candidate", (c) => seen.push(c.candidate));
    expect(seen).toEqual(Array.from({ length: 8 }, (_, n) => candidate(n).candidate));
  });

  it("hands a message it has no name for to the other end as a raw signal", async (ctx) => {
    ts6(ctx);
    const { peer, view } = await connectedPair();
    const raw = first("signal", (l) => view.on("signal", l));
    await peer.sendSignal("custom", { note: "a b | c" });
    expect(await raw).toMatchObject({ cmd: "custom", args: { note: "a b | c" } });
  });

  it("tells the viewer why a request was denied, and lets it ask again", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "private" });
    const info = await learned;

    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const denied = viewer.watch(info).catch((e: unknown) => e);
    const request = await requested;
    await request.deny("Denied | not today");
    const error = await denied;
    expect(error).toBeInstanceOf(StreamJoinDeniedError);
    expect((error as StreamJoinDeniedError).serverMessage).toBe("Denied | not today");

    // The server forgets a denial.
    const again = first<JoinRequest>("second request", (l) => pub.on("request", l));
    const second = viewer.watch(info);
    const retry = await again;
    await retry.accept(sdpLike(500));
    expect((await second).offer).toBe(sdpLike(500));
  });

  it("leaves a remembered denial unanswered", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a, { rememberDenied: true });
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "remembered" });
    const info = await learned;

    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const denied = viewer.watch(info).catch((e: unknown) => e);
    await (await requested).deny("no");
    expect(await denied).toBeInstanceOf(StreamJoinDeniedError);

    const requests: JoinRequest[] = [];
    pub.on("request", (r) => requests.push(r));
    // Ask again: the server relays it, and the publisher says nothing.
    await expect(viewer.watch(info, { timeoutMs: 2500 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    expect(requests).toEqual([]);
  });

  it("closes the publisher's peer when the viewer leaves", async (ctx) => {
    ts6(ctx);
    const { pub, peer, view } = await connectedPair();
    const closed = first<PeerClosed>("closed", (l) => peer.on("closed", l));
    await view.leave();
    expect(await closed).toEqual({ cause: "left" });
    expect(pub.viewers()).toEqual([]);
    expect(view.closed).toBe(true);
  });

  it("ends the viewer's side, with the reason, when the publisher stops", async (ctx) => {
    ts6(ctx);
    const { viewer, pub, peer, view } = await connectedPair();
    const viewClosed = first<PeerClosed>("closed", (l) => view.on("closed", l));
    const stopped = first<StreamStoppedEvent>("stopped", (l) => viewer.on("stopped", l));
    const ended = first<StreamEnded>("ended", (l) => pub.on("ended", l));
    await pub.stop(3);
    expect(await viewClosed).toEqual({ cause: "stopped", reason: 3 });
    expect((await stopped).reason).toBe(3);
    expect(await ended).toEqual({ cause: "stopped", reason: 3 });
    expect(peer.closed).toBe(true);
    expect(viewer.list()).toEqual([]);
  });

  it("asks for a stream that has ended and is told so", async (ctx) => {
    ts6(ctx);
    const publisher = attach(a);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "short" });
    const info = await learned;
    await pub.stop();
    const error = await viewer.watch(info).catch((e: unknown) => e);
    expect((error as Error).name).toBe("StreamEndedError");
    expect(((error as Error).cause as ServerError).code).toBe(ErrorCode.StreamNotFound);
  });

  it("reports a second request to watch as the server's 5638", async (ctx) => {
    ts6(ctx);
    const { viewer, pub } = await connectedPair();
    // This client has no local session for it, as after a lost one: the server answers.
    const other2 = attach(b);
    const info = viewer.get(pub.id)!;
    const error = await other2.watch(info).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).code).toBe(ErrorCode.StreamAlreadyJoined);
  });

  it("keeps the stream and its signalling when the publisher changes channel", async (ctx) => {
    ts6(ctx);
    if (other === 0n) ctx.skip();
    const { peer, view, viewer } = await connectedPair();
    await moveClient(a, a.clientID, other, { password: OTHER_CHANNEL_PASSWORD });
    await sleep(800);
    expect(view.closed).toBe(false);
    expect(peer.closed).toBe(false);
    expect(viewer.list()).toHaveLength(1);
    const arrived = first<string>("candidate", (l) => peer.on("candidate", (c) => l(c.candidate)));
    await view.sendCandidate(candidate(5));
    expect(await arrived).toBe(candidate(5).candidate);
    // The viewer, still a participant, hears the stop from the other channel.
    const closed = first<PeerClosed>("closed", (l) => view.on("closed", l));
    await peer.close();
    await a.send({
      command: "stopstream",
      params: [
        ["id", view.streamId],
        ["reason", 0],
      ],
    });
    expect((await closed).cause).toBe("stopped");
  });

  it("ends the viewer's side when the publisher disconnects", async (ctx) => {
    ts6(ctx);
    const publisherClient = await connectClient("ts-js-stream-gone");
    extra.push(publisherClient);
    const publisher = attach(publisherClient);
    const viewer = attach(b);
    const learned = first<StreamInfo>("started", (l) => viewer.on("started", l));
    const pub = await publisher.publish({ name: "going away" });
    const info = await learned;
    const requested = first<JoinRequest>("request", (l) => pub.on("request", l));
    const watching = viewer.watch(info);
    await (await requested).accept(sdpLike(800));
    const view = await watching;
    const closed = first<PeerClosed>("closed", (l) => view.on("closed", l));
    const ended = first<StreamEnded>("ended", (l) => pub.on("ended", l));
    await publisherClient.disconnect();
    // The server reports a publisher that went away as reason 1.
    expect(await closed).toEqual({ cause: "stopped", reason: 1 });
    expect((await ended).cause).toBe("disconnected");
    expect(viewer.list()).toEqual([]);
  });

  it("refuses a payload too long before sending, and carries one at the limit", async (ctx) => {
    ts6(ctx);
    const { peer, view } = await connectedPair();
    await expect(peer.sendOffer("x".repeat(20_000))).rejects.toBeInstanceOf(
      StreamPayloadTooLargeError,
    );
    await expect(
      view.sendCandidate({ candidate: sdpLike(12_000), sdpMid: "0", sdpMLineIndex: 0 }),
    ).rejects.toBeInstanceOf(StreamPayloadTooLargeError);

    // The longest candidate the SDK sends: the line is exactly the limit.
    const wrap = (text: string): number =>
      Buffer.byteLength(
        encodeRequest(
          signalRequest(
            view.streamId,
            peer.clientId,
            JSON.stringify({ cmd: "iceCandidate", args: { sdp: text, mid: "0", mLine: 0 } }),
          ),
          (p) => p,
        ),
      );
    let text = "a".repeat(MAX_COMMAND_LINE_BYTES - wrap(""));
    while (wrap(text) > MAX_COMMAND_LINE_BYTES) text = text.slice(1);
    expect(wrap(text)).toBe(MAX_COMMAND_LINE_BYTES);
    const arrived = first<string>("long candidate", (l) =>
      peer.on("candidate", (c) => l(c.candidate)),
    );
    await view.sendCandidate({ candidate: text, sdpMid: "0", sdpMLineIndex: 0 });
    expect(await arrived).toBe(text);
  });

  it("delivers a burst of candidates in order", async (ctx) => {
    ts6(ctx);
    const { peer, view } = await connectedPair();
    // The client's throttle paces them, about five a second as measured here.
    const got = collect<string>(
      "candidates",
      40,
      (l) => peer.on("candidate", (c) => l(c.candidate)),
      25_000,
    );
    // Issued together, so they queue in the client's throttle and stay in order.
    await Promise.all(Array.from({ length: 40 }, (_, n) => view.sendCandidate(candidate(n))));
    expect(await got).toEqual(Array.from({ length: 40 }, (_, n) => candidate(n).candidate));
  });

  it("ends everything when the client disposes its Streams, and stops nothing it did not publish", async (ctx) => {
    ts6(ctx);
    const { viewer, view, pub } = await connectedPair();
    const closed = first<PeerClosed>("closed", (l) => view.on("closed", l));
    viewer.dispose();
    expect(await closed).toEqual({ cause: "disposed" });
    // The stream is still running for its publisher.
    expect(pub.ended).toBe(false);
    const who = await whoAmI(b);
    expect(who.clientID).toBe(b.clientID);
  });

  describe("on a server without streams", () => {
    it("refuses publish and watch at once, without sending, and attaches harmlessly", async (ctx) => {
      if (family !== "ts3") ctx.skip();
      const s = attach(a);
      const t0 = Date.now();
      await expect(s.publish({ name: "nope" })).rejects.toBeInstanceOf(StreamsUnsupportedError);
      await expect(
        s.watch({ id: "x", clientId: b.clientID, name: "x", audio: false }),
      ).rejects.toBeInstanceOf(StreamsUnsupportedError);
      expect(Date.now() - t0).toBeLessThan(500);
      expect(s.supported).toBe(false);
      expect(s.list()).toEqual([]);
      // The connection is none the worse.
      expect((await whoAmI(a)).clientID).toBe(a.clientID);
      await sleep(500);
      expect((await whoAmI(b)).clientID).toBe(b.clientID);
    });

    it("names the server it found", async (ctx) => {
      if (family !== "ts3") ctx.skip();
      const error = await attach(a)
        .publish({ name: "nope" })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ family: "ts3" });
      expect((error as StreamsUnsupportedError).version).toMatch(/^3\./);
    });
  });
});
