/**
 * Watch a TeamSpeak 6 screen share from Node. The signalling is `Streams`; the
 * video travels over WebRTC, here werift, a WebRTC stack in TypeScript
 * (`pnpm add werift`). The viewer is receive-only: it logs the tracks it gets
 * and counts their RTP packets. See docs/streams.md.
 *
 * Run:
 *   TEAMSPEAK_ADDR=127.0.0.1:9988 pnpm tsx examples/stream-watch.ts
 *
 * Streams need a TeamSpeak 6 server. TEAMSPEAK_SERVER_PASSWORD is optional. The
 * example watches the first stream it sees, in `list()` or the next to start,
 * until Ctrl-C.
 */

import { Client, generateIdentitySync } from "@honeybbq/teamspeak/client";
import { Streams } from "@honeybbq/teamspeak/stream";
import type { IceCandidate, StreamInfo } from "@honeybbq/teamspeak/stream";
import { RTCPeerConnection } from "werift";
import type { RTCIceCandidate } from "werift";

const ADDR = process.env["TEAMSPEAK_ADDR"] ?? "127.0.0.1:9988";
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";

// werift hands over its own candidate class: convert it to what `Streams` takes.
const toInit = (c: RTCIceCandidate): IceCandidate => ({
  candidate: c.candidate,
  sdpMid: c.sdpMid ?? null,
  sdpMLineIndex: c.sdpMLineIndex ?? null,
});

async function main(): Promise<void> {
  const identity = generateIdentitySync(8);
  const client = new Client(identity, ADDR, "ts-js-stream-watch", {
    serverPassword: SERVER_PASSWORD,
  });

  console.log(`[example] connecting to ${ADDR}…`);
  await client.connect({ signal: AbortSignal.timeout(30_000) });
  await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  console.log(`[example] connected, clid=${client.clientID}`);

  const streams = new Streams(client);
  streams.on("error", (error) => console.warn("[example] streams error:", error.message));

  let pc: RTCPeerConnection | undefined;
  let stop: (() => void) | undefined;
  const interrupted = new Promise<void>((resolve) => {
    stop = resolve;
  });
  process.once("SIGINT", () => stop?.());

  try {
    // The first stream: one already known, or the next to start.
    const first = new Promise<StreamInfo>((resolve) => {
      const known = streams.list()[0];
      if (known !== undefined) resolve(known);
      else streams.on("started", resolve);
    });
    console.log("[example] waiting for a stream (Ctrl-C to quit)…");
    const info = await Promise.race([first, interrupted]);
    if (info === undefined) return;

    console.log(`[example] watching "${info.name}" (id ${info.id})`);
    const view = await streams.watch(info, { message: "ts-js example" });

    pc = new RTCPeerConnection({ iceServers: [] });
    let rtpPackets = 0;
    pc.onTrack.subscribe((track) => {
      console.log(`[example] track: ${track.kind}`);
      track.onReceiveRtp.subscribe(() => rtpPackets++);
    });
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate) void view.sendCandidate(toInit(candidate));
    });
    // Candidates that arrived with the offer go to the first listener.
    view.on("candidate", (candidate) => {
      void pc?.addIceCandidate(candidate);
    });
    view.on("closed", ({ cause }) => {
      console.log(`[example] stream closed: ${cause}`);
      stop?.();
    });

    // Receive-only: a recvonly video transceiver, as in the live test.
    pc.addTransceiver("video", { direction: "recvonly" });
    await pc.setRemoteDescription({ type: "offer", sdp: view.offer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await view.answer(answer.sdp);
    console.log("[example] answered, waiting for media");

    const ticker = setInterval(
      () => console.log(`[example] rtp packets received: ${rtpPackets}`),
      5_000,
    );
    await interrupted;
    clearInterval(ticker);
    console.log(`[example] total rtp packets: ${rtpPackets}`);
  } finally {
    await pc?.close();
    streams.dispose();
    console.log("[example] disconnecting…");
    await client.disconnect();
    console.log("[example] done.");
  }
}

main().catch((err) => {
  console.error("[example] fatal:", err);
  process.exit(1);
});
