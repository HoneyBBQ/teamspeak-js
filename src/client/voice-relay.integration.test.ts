/**
 * Live tests of what the server relays: a speaker's own state (away,
 * input-muted, no input hardware), a listener's (output-muted), and a
 * subscription, which shows a channel's clients but not its voice. The
 * documentation of `sendVoice`, `updateClient` and `subscribeChannel` rests on
 * these.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run --project integration src/client/voice-relay.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Codec, listChannels, moveClient, updateClient } from "@honeybbq/teamspeak";
import type { ClientUpdateOptions } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { subscribeChannel, unsubscribeChannel } from "./api/voice.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const RUN = Date.now().toString(36).slice(-5);
const FRAME = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const FRAMES = 20;

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
  // TeamSpeak's antiflood tolerates only a few rapid connects from one address.
  await sleep(2_200);
  return client;
}

describe.skipIf(!ADDR)("what the server relays — live", () => {
  let s: Client; // the speaker
  let l: Client; // the listener

  beforeAll(async () => {
    s = await connectClient(`ts-js-rls-${RUN}`);
    l = await connectClient(`ts-js-rll-${RUN}`);
  }, 60_000);

  afterAll(async () => {
    for (const client of [s, l]) await client.disconnect().catch(() => {});
  }, 30_000);

  /** How many of FRAMES frames, spoken or whispered by s, reach l. */
  async function heard(whisper = false): Promise<number> {
    let count = 0;
    const stop = l.on("voiceData", (e) => {
      if (e.clientID === s.clientID && e.whisper === whisper) count++;
    });
    try {
      for (let i = 0; i < FRAMES; i++) {
        if (whisper) s.sendWhisper(FRAME, { clients: [l.clientID] }, Codec.OpusVoice);
        else s.sendVoice(FRAME, Codec.OpusVoice);
        await sleep(20);
      }
      await sleep(500);
      return count;
    } finally {
      stop();
    }
  }

  /** Set some of who's state, measure, and set it back. */
  async function heardWhile(
    who: Client,
    on: ClientUpdateOptions,
    off: ClientUpdateOptions,
    whisper = false,
  ): Promise<number> {
    await updateClient(who, on);
    await sleep(300);
    try {
      return await heard(whisper);
    } finally {
      await updateClient(who, off);
      await sleep(300);
    }
  }

  it("relays voice and whispers in the channel by default", async () => {
    expect(await heard()).toBeGreaterThan(0);
    expect(await heard(true)).toBeGreaterThan(0);
  }, 20_000);

  it("relays nothing from a speaker that is away, input-muted or without input hardware", async () => {
    for (const [on, off] of [
      [{ isAway: true }, { isAway: false }],
      [{ isInputMuted: true }, { isInputMuted: false }],
      [{ hasInputHardware: false }, { hasInputHardware: true }],
    ] as const) {
      expect(await heardWhile(s, on, off), JSON.stringify(on)).toBe(0);
      expect(await heardWhile(s, on, off, true), `whisper ${JSON.stringify(on)}`).toBe(0);
      expect(await heard(), `after ${JSON.stringify(off)}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it("sends nothing to a listener that is output-muted or without output hardware, but does to one away", async () => {
    for (const [on, off] of [
      [{ isOutputMuted: true }, { isOutputMuted: false }],
      [{ hasOutputHardware: false }, { hasOutputHardware: true }],
    ] as const) {
      expect(await heardWhile(l, on, off), JSON.stringify(on)).toBe(0);
      expect(await heardWhile(l, on, off, true), `whisper ${JSON.stringify(on)}`).toBe(0);
    }
    expect(await heardWhile(l, { isAway: true }, { isAway: false })).toBeGreaterThan(0);
  }, 60_000);

  it.skipIf(PASSWORD_CHANNEL === "" || PASSWORD_CHANNEL_PASSWORD === "")(
    "shows a subscribed channel's clients, but not their voice",
    async () => {
      const home = l.channelID;
      const target = (await listChannels(s)).find((c) => c.name === PASSWORD_CHANNEL);
      expect(target).toBeDefined();
      await moveClient(s, s.clientID, target!.id, { password: PASSWORD_CHANNEL_PASSWORD });
      try {
        await subscribeChannel(l, target!.id);
        await sleep(500);
        expect(l.view.clients.has(s.clientID)).toBe(true);
        expect(await heard()).toBe(0);
      } finally {
        await unsubscribeChannel(l, target!.id).catch(() => {});
        await moveClient(s, s.clientID, home);
      }
    },
    30_000,
  );
});
