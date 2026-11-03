/**
 * Live tests of the fields of a `voiceData` event: the speaker's own `seq`,
 * the `whisper` flag, the end-of-speech frame and the `session`, against a
 * real server.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run --project integration src/client/voice-fields.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Codec, asClientID } from "@honeybbq/teamspeak";
import type { ClientID, VoiceDataEvent } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const RUN = Date.now().toString(36).slice(-5);
const FRAME = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const diff = (a: number, b: number): number => ((a - b) << 16) >> 16;

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
  // TeamSpeak's antiflood tolerates only a few rapid connects from one address.
  await sleep(2_200);
  return client;
}

async function speak(send: () => void, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    send();
    await sleep(20);
  }
}

describe.skipIf(!ADDR)("voiceData fields — live", () => {
  let a: Client; // a speaker
  let b: Client; // another speaker
  let l: Client; // the listener
  const idOf = (client: Client): ClientID => asClientID(client.clientID);

  beforeAll(async () => {
    a = await connectClient(`ts-js-vfa2-${RUN}`);
    b = await connectClient(`ts-js-vfb2-${RUN}`);
    l = await connectClient(`ts-js-vfl2-${RUN}`);
  }, 60_000);

  afterAll(async () => {
    for (const client of [a, b, l]) await client.disconnect().catch(() => {});
  }, 30_000);

  function record(): { heard: VoiceDataEvent[]; stop: () => void } {
    const heard: VoiceDataEvent[] = [];
    const stop = l.on("voiceData", (e) => heard.push(e));
    return { heard, stop };
  }

  it("two speakers each count their own seq, and arrival times do not go backwards", async () => {
    const { heard, stop } = record();
    try {
      for (let i = 0; i < 10; i++) {
        a.sendVoice(FRAME, Codec.OpusVoice);
        b.sendVoice(FRAME, Codec.OpusVoice);
        await sleep(20);
      }
      await sleep(1_200);
    } finally {
      stop();
    }
    for (const speaker of [a, b]) {
      const seqs = heard.filter((e) => e.clientID === idOf(speaker)).map((e) => e.seq);
      expect(seqs).toHaveLength(10);
      // Each speaker's sequence goes up by one per packet, whatever the other does.
      for (let i = 1; i < seqs.length; i++) expect(diff(seqs[i]!, seqs[i - 1]!)).toBe(1);
    }
    expect(heard.every((e) => e.session === l.session && !e.whisper)).toBe(true);
    expect(heard.every((e) => e.codec === Codec.OpusVoice)).toBe(true);
    for (let i = 1; i < heard.length; i++) {
      expect(heard[i]!.receivedAt).toBeGreaterThanOrEqual(heard[i - 1]!.receivedAt);
    }
    expect(Math.abs(heard.at(-1)!.receivedAt - performance.now())).toBeLessThan(5_000);
  }, 30_000);

  it("voice and whisper are two sequences, and only the whisper is flagged", async () => {
    const { heard, stop } = record();
    try {
      await speak(() => a.sendVoice(FRAME, Codec.OpusVoice), 5);
      await speak(() => a.sendWhisper(FRAME, { clients: [idOf(l)] }, Codec.OpusVoice), 5);
      await speak(() => a.sendVoice(FRAME, Codec.OpusVoice), 5);
      await sleep(1_200);
    } finally {
      stop();
    }
    const mine = heard.filter((e) => e.clientID === idOf(a));
    expect(mine.map((e) => e.whisper)).toEqual([
      ...Array<boolean>(5).fill(false),
      ...Array<boolean>(5).fill(true),
      ...Array<boolean>(5).fill(false),
    ]);
    const voice = mine.filter((e) => !e.whisper).map((e) => e.seq);
    const whisper = mine.filter((e) => e.whisper).map((e) => e.seq);
    // The whisper does not advance the voice counter: it continues across it.
    for (let i = 1; i < voice.length; i++) expect(diff(voice[i]!, voice[i - 1]!)).toBe(1);
    for (let i = 1; i < whisper.length; i++) expect(diff(whisper[i]!, whisper[i - 1]!)).toBe(1);
  }, 30_000);

  it("delivers the end of speech as a frame with empty data and its own seq", async () => {
    const { heard, stop } = record();
    try {
      await speak(() => a.sendVoice(FRAME, Codec.OpusVoice), 3);
      a.sendVoice(new Uint8Array(0), Codec.OpusVoice);
      await sleep(1_200);
    } finally {
      stop();
    }
    const mine = heard.filter((e) => e.clientID === idOf(a));
    expect(mine.map((e) => e.data.length)).toEqual([8, 8, 8, 0]);
    expect(diff(mine[3]!.seq, mine[2]!.seq)).toBe(1);
  }, 30_000);

  it("a client that connects again is in another session, and a listener sees both", async () => {
    const seen: number[] = [];
    const stop = l.on("voiceData", (e) => seen.push(e.session));
    try {
      await speak(() => a.sendVoice(FRAME, Codec.OpusVoice), 3);
      await sleep(500);
      const before = l.session;
      await l.disconnect();
      await sleep(2_200);
      await l.connect({ signal: AbortSignal.timeout(10_000) });
      await sleep(2_200);
      expect(l.session).toBe(before + 1);
      await speak(() => a.sendVoice(FRAME, Codec.OpusVoice), 3);
      await sleep(1_200);
      expect(new Set(seen)).toEqual(new Set([before, before + 1]));
      expect(seen.at(-1)).toBe(before + 1);
    } finally {
      stop();
    }
  }, 60_000);
});
