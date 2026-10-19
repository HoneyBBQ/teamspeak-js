/**
 * A real WebRTC session over a live server: a publisher with a send-only video
 * track and a viewer with a receive-only one, negotiating through `Streams`
 * alone, then ICE connecting and RTP flowing between them. It proves that the
 * strings `Streams` hands over are what a peer connection takes, and reports
 * the sizes of the real messages against the server's line limit.
 *
 * Opt-in like the rest of the integration suite, and TeamSpeak 6 only: it runs
 * when TEAMSPEAK_ADDR is set and the server is one. werift, a WebRTC stack in
 * TypeScript, is a development dependency for this test; the package itself
 * has none.
 *
 *   TEAMSPEAK_ADDR=127.0.0.1:9988 pnpm vitest run --project integration src/stream/webrtc.integration.test.ts --reporter=verbose
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } from "werift";
import type { RTCIceCandidate } from "werift";
import { Client } from "../client/client.js";
import { onSentLine } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { Streams } from "./streams.js";
import type { IceCandidate, StreamInfo, ViewerPeer } from "./types.js";
import { MAX_COMMAND_LINE_BYTES } from "./wire.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const SKIP = !ADDR;
const WAIT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function connectClient(nickname: string): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
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

/** Resolve when `done()` is true, polling; reject with `what` after `ms`. */
async function until(what: string, done: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const toInit = (c: RTCIceCandidate): IceCandidate => ({
  candidate: c.candidate,
  sdpMid: c.sdpMid ?? null,
  sdpMLineIndex: c.sdpMLineIndex ?? null,
});

/** The size on the wire of each stream command the clients send, escaped, with the return code. */
const sizes: Array<{ command: string; json: string; bytes: number }> = [];

describe.skipIf(SKIP)("Streams with WebRTC — live", { timeout: 60_000 }, () => {
  let publisherClient: Client;
  let viewerClient: Client;
  let ts6 = false;

  beforeAll(async () => {
    onSentLine((_client, line) => {
      const name = line.split(" ", 1)[0] ?? "";
      if (name !== "respondjoinstreamrequest" && name !== "streamsignaling") return;
      const json = /(?:^| )json=(\S+)/.exec(line)?.[1] ?? "";
      sizes.push({ command: name, json, bytes: Buffer.byteLength(line) });
    });
    publisherClient = await connectClient("ts-js-rtc-pub");
    viewerClient = await connectClient("ts-js-rtc-view");
    ts6 = publisherClient.serverCapabilities.family === "ts6";
  }, 60_000);

  afterAll(async () => {
    onSentLine(undefined);
    await publisherClient?.disconnect().catch(() => {});
    await viewerClient?.disconnect().catch(() => {});
  }, 20_000);

  it("connects ICE and delivers RTP, signalling only through Streams", async (ctx) => {
    if (!ts6) ctx.skip();
    const publisherStreams = new Streams(publisherClient);
    const viewerStreams = new Streams(viewerClient);
    const pcs: RTCPeerConnection[] = [];
    let feeder: ReturnType<typeof setInterval> | undefined;
    try {
      const learned = new Promise<StreamInfo>((resolve) => {
        viewerStreams.on("started", resolve);
      });
      const stream = await publisherStreams.publish({
        name: "webrtc end to end",
        source: "camera",
      });
      const info = await learned;

      // The publisher sends one video track; each viewer gets its own connection.
      const track = new MediaStreamTrack({ kind: "video" });
      const pubPc = new RTCPeerConnection({ iceServers: [] });
      pcs.push(pubPc);
      pubPc.addTrack(track);
      // Candidates are gathered from the moment the offer is set, before the
      // viewer exists: they wait here, and go as soon as it does.
      const pubCandidates: IceCandidate[] = [];
      let viewerPeer: ViewerPeer | undefined;
      let pubState = "";
      pubPc.iceConnectionStateChange.subscribe((state) => (pubState = state));
      pubPc.onIceCandidate.subscribe((c) => {
        if (c === undefined) return;
        if (viewerPeer === undefined) pubCandidates.push(toInit(c));
        else void viewerPeer.sendCandidate(toInit(c));
      });

      stream.on("request", (request) => {
        void (async () => {
          await pubPc.setLocalDescription(await pubPc.createOffer());
          const viewer = await request.accept(pubPc.localDescription!.sdp);
          viewer.on("answer", (sdp) => {
            void pubPc.setRemoteDescription({ type: "answer", sdp });
          });
          viewer.on("candidate", (c) => {
            void pubPc.addIceCandidate(c);
          });
          viewerPeer = viewer;
          for (const c of pubCandidates.splice(0)) void viewer.sendCandidate(c);
        })();
      });

      // The viewer: a receive-only video track.
      const view = await viewerStreams.watch(info, { message: "end to end" });
      const subPc = new RTCPeerConnection({ iceServers: [] });
      pcs.push(subPc);
      let subState = "";
      subPc.iceConnectionStateChange.subscribe((state) => (subState = state));
      let rtpPackets = 0;
      subPc.onTrack.subscribe((received) => {
        received.onReceiveRtp.subscribe(() => rtpPackets++);
      });
      subPc.onIceCandidate.subscribe((c) => {
        if (c) void view.sendCandidate(toInit(c));
      });
      view.on("candidate", (c) => {
        void subPc.addIceCandidate(c);
      });
      subPc.addTransceiver("video", { direction: "recvonly" });
      await subPc.setRemoteDescription({ type: "offer", sdp: view.offer });
      const answer = await subPc.createAnswer();
      await subPc.setLocalDescription(answer);
      await view.answer(answer.sdp);

      await until("ICE to connect on both sides", () => {
        const up = (state: string): boolean => state === "connected" || state === "completed";
        return up(pubState) && up(subState);
      });

      let sequence = 0;
      feeder = setInterval(() => {
        sequence++;
        track.writeRtp(
          new RtpPacket(
            new RtpHeader({
              payloadType: 96,
              sequenceNumber: sequence & 0xffff,
              timestamp: sequence * 3000,
              ssrc: 4242,
            }),
            Buffer.alloc(300, sequence & 0xff),
          ),
        );
      }, 20);
      await until("RTP to arrive", () => rtpPackets >= 20);
      expect(rtpPackets).toBeGreaterThanOrEqual(20);

      // The real sizes, against the server's limit.
      const offerBytes = sizes.filter((s) => s.command === "respondjoinstreamrequest");
      const answerBytes = sizes.filter(
        (s) => /answer/.test(s.json) && s.command === "streamsignaling",
      );
      const candidateBytes = sizes.filter((s) => /iceCandidate/.test(s.json));
      const report = {
        limitBytes: MAX_COMMAND_LINE_BYTES,
        offerLineBytes: offerBytes.map((s) => s.bytes),
        answerLineBytes: answerBytes.map((s) => s.bytes),
        candidateLineBytes: {
          count: candidateBytes.length,
          min: Math.min(...candidateBytes.map((s) => s.bytes)),
          max: Math.max(...candidateBytes.map((s) => s.bytes)),
        },
        rtpPackets,
      };
      console.log(`stream signalling sizes: ${JSON.stringify(report)}`);
      for (const s of sizes) expect(s.bytes).toBeLessThanOrEqual(MAX_COMMAND_LINE_BYTES + 23);
      expect(offerBytes.length).toBeGreaterThan(0);
      expect(answerBytes.length).toBeGreaterThan(0);
      expect(candidateBytes.length).toBeGreaterThan(0);

      await view.leave();
      await stream.stop();
    } finally {
      if (feeder !== undefined) clearInterval(feeder);
      for (const pc of pcs) await pc.close();
      publisherStreams.dispose();
      viewerStreams.dispose();
    }
  });
});
