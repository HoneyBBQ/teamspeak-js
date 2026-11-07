/**
 * Voice echo: send every voice frame heard in the channel back to it, so
 * whoever speaks hears themselves.
 *
 * Run:
 *   TEAMSPEAK_ADDR=127.0.0.1:9987 pnpm tsx examples/voice-echo.ts
 *
 * Optional: TEAMSPEAK_SERVER_PASSWORD, TEAMSPEAK_DEFAULT_CHANNEL.
 *
 * The bot needs talk power in the channel, or the server drops what it sends
 * (see "What the server relays" in docs/guide.md). Frames are relayed as they
 * arrive, with no re-timing: the echo has the speaker's own jitter. Whispers
 * are not echoed. Stop with Ctrl-C.
 */

import type { Codec } from "@honeybbq/teamspeak";
import { Client, generateIdentitySync } from "@honeybbq/teamspeak/client";

const ADDR = process.env["TEAMSPEAK_ADDR"] ?? "127.0.0.1:9987";
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"];
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"];

async function main(): Promise<void> {
  const identity = generateIdentitySync(8);
  const client = new Client(identity, ADDR, "ts-js-echo", {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
  });

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  console.log(`[example] connecting to ${ADDR}…`);
  await client.connect({ signal: AbortSignal.timeout(30_000) });
  console.log(`[example] connected, clid=${client.clientID}`);

  let echoed = 0;
  try {
    for await (const v of client.events("voiceData", { signal: controller.signal })) {
      if (v.whisper || v.clientID === client.clientID) continue;
      // VoiceDataEvent.codec is a plain number. An empty frame is the end of
      // speech; it is sent back like any other.
      client.sendVoice(v.data, v.codec as Codec);
      echoed++;
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }

  console.log(`[example] stopping after ${echoed} frame(s)`);
  await client.disconnect();
  console.log("[example] done.");
}

main().catch((err) => {
  console.error("[example] fatal:", err);
  process.exit(1);
});
