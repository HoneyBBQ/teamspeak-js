/**
 * Live tests of what the server relays: a speaker's own state (away,
 * input-muted, no input hardware), a listener's (output-muted), talk power
 * (which a whisper does not need and a priority speaker does not get), and
 * subscriptions, which show a channel's clients but not its voice, come with
 * joining a channel and stay after leaving it. The documentation of
 * `sendVoice`, `sendWhisper`, `updateClient` and the subscription functions
 * rests on these.
 *
 * Opt-in like the rest of the integration suite: they run only when
 * TEAMSPEAK_ADDR is set, and the ones that need an administrator only when the
 * fixture's query login is set too.
 *
 *   source /tmp/ts3-fixture.env && pnpm vitest run --project integration src/client/voice-relay.integration.test.ts
 */

import { createSocket } from "node:dgram";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Codec,
  addClientPermission,
  createChannel,
  deleteChannel,
  deleteClientPermission,
  editClient,
  getClientDBIDByUID,
  listChannels,
  moveClient,
  permissionByName,
  updateClient,
} from "@honeybbq/teamspeak";
import type { ChannelID, ClientUpdateOptions } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { subscribeChannel, unsubscribeChannel } from "./api/voice.js";
import { MAX_VOICE_FRAME_SIZE } from "./index.js";
import { GroupWhisperScope, GroupWhisperType } from "./types.js";
import type { ClientOptions, DatagramSocket } from "./types.js";
import { QueryClient } from "../query/client.js";
import type { QueryClientOptions } from "../query/options.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";
const RUN = Date.now().toString(36).slice(-5);
const FRAME = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const FRAMES = 20;
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const HAS_ADMIN = QUERY_KIND === "tcp" || QUERY_KIND === "web";

/** The query connection that acts as the administrator, from the fixture's environment. */
function adminOptions(): QueryClientOptions {
  if (QUERY_KIND === "web") {
    return {
      transport: {
        kind: "web",
        url: process.env["TEAMSPEAK_QUERY_URL"] ?? "",
        apiKey: process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "",
      },
      server: { id: 1 },
    };
  }
  return {
    transport: {
      kind: "tcp",
      host: process.env["TEAMSPEAK_QUERY_HOST"] ?? "127.0.0.1",
      port: Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011"),
      login: {
        name: process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "",
        password: process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "",
      },
    },
    server: { id: 1 },
    nickname: "ts-js-relay-admin",
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function connectClient(nickname: string, extra?: Partial<ClientOptions>): Promise<Client> {
  const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
    serverPassword: SERVER_PASSWORD,
    defaultChannel: DEFAULT_CHANNEL,
    ...extra,
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
  let admin: QueryClient | undefined;
  const made: ChannelID[] = [];

  beforeAll(async () => {
    s = await connectClient(`ts-js-rls-${RUN}`);
    l = await connectClient(`ts-js-rll-${RUN}`);
    if (HAS_ADMIN) {
      admin = new QueryClient(adminOptions());
      await admin.connect({ signal: AbortSignal.timeout(15_000) });
    }
  }, 60_000);

  afterAll(async () => {
    for (const client of [s, l]) await client.disconnect().catch(() => {});
    if (admin)
      for (const cid of made) await deleteChannel(admin, cid, { force: true }).catch(() => {});
    await admin?.disconnect().catch(() => {});
  }, 30_000);

  /** A channel of this run, deleted after the tests. */
  async function scratchChannel(name: string, neededTalkPower?: number): Promise<ChannelID> {
    const cid = await createChannel(admin!, {
      name: `ts-js-rl-${name}-${RUN}`,
      isPermanent: true,
      neededTalkPower,
    });
    made.push(cid);
    return cid;
  }

  /** Whether event `name` fires on `who` while `run` runs and for 500 ms after. */
  async function fires(
    who: Client,
    name: "channelSubscribed" | "channelUnsubscribed",
    cid: ChannelID,
    run: () => Promise<unknown>,
  ): Promise<boolean> {
    let seen = false;
    const stop = who.on(name, (e) => {
      if (e.channelID === cid) seen = true;
    });
    try {
      await run();
      await sleep(500);
      return seen;
    } finally {
      stop();
    }
  }

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

  /**
   * `heard`, for a check that wants frames: up to three tries, since a state
   * change the server has answered may take a moment to reach its relay. A
   * check that wants none measures once: no frame is the state to hold, and a
   * retry would only hide one that got through.
   */
  async function heardSome(whisper = false): Promise<number> {
    let count = 0;
    for (let attempt = 1; attempt <= 3 && count === 0; attempt++) {
      if (attempt > 1) await sleep(500);
      count = await heard(whisper);
    }
    return count;
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
    expect(await heardSome()).toBeGreaterThan(0);
    expect(await heardSome(true)).toBeGreaterThan(0);
  }, 20_000);

  it("relays nothing from a speaker that is away, input-muted or without input hardware", async () => {
    for (const [on, off] of [
      [{ isAway: true }, { isAway: false }],
      [{ isInputMuted: true }, { isInputMuted: false }],
      [{ hasInputHardware: false }, { hasInputHardware: true }],
    ] as const) {
      expect(await heardWhile(s, on, off), JSON.stringify(on)).toBe(0);
      expect(await heardWhile(s, on, off, true), `whisper ${JSON.stringify(on)}`).toBe(0);
      expect(await heardSome(), `after ${JSON.stringify(off)}`).toBeGreaterThan(0);
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
    await updateClient(l, { isAway: true });
    await sleep(300);
    try {
      expect(await heardSome(), "listener away").toBeGreaterThan(0);
    } finally {
      await updateClient(l, { isAway: false });
      await sleep(300);
    }
  }, 60_000);

  it.skipIf(!HAS_ADMIN)(
    "needs talk power for channel voice, not for a whisper, and a priority speaker gets none",
    async () => {
      const home = s.channelID;
      const quiet = await scratchChannel("tp", 50);
      await moveClient(s, s.clientID, quiet);
      await moveClient(l, l.clientID, quiet);
      const dbid = await getClientDBIDByUID(admin!, s.uid);
      try {
        expect(await heard(), "talk power 0 of 50").toBe(0);
        expect(await heardSome(true), "whisper with talk power 0 of 50").toBeGreaterThan(0);

        await addClientPermission(
          admin!,
          dbid,
          permissionByName("b_client_is_priority_speaker"),
          1,
        );
        await sleep(300);
        try {
          expect(await heard(), "priority speaker, talk power 0 of 50").toBe(0);
        } finally {
          await deleteClientPermission(
            admin!,
            dbid,
            permissionByName("b_client_is_priority_speaker"),
          );
        }

        await editClient(admin!, s.clientID, { isTalker: true });
        await sleep(300);
        try {
          expect(await heardSome(), "talker, talk power 0 of 50").toBeGreaterThan(0);
        } finally {
          await editClient(admin!, s.clientID, { isTalker: false });
        }
      } finally {
        await moveClient(s, s.clientID, home);
        await moveClient(l, l.clientID, home);
      }
    },
    60_000,
  );

  it.skipIf(!HAS_ADMIN)(
    "subscribes to a channel joined without saying so, and keeps it after leaving",
    async () => {
      const home = l.channelID;
      const room = await scratchChannel("join");
      const b = await connectClient(`ts-js-rlb-${RUN}`);
      try {
        await moveClient(b, b.clientID, room);
        await sleep(500);
        expect(l.view.clients.has(b.clientID), "before joining").toBe(false);

        const announced = await fires(l, "channelSubscribed", room, () =>
          moveClient(l, l.clientID, room),
        );
        expect(l.view.clients.has(b.clientID), "after joining").toBe(true);
        expect(announced, "channelSubscribed on joining").toBe(false);

        await moveClient(l, l.clientID, home);
        await sleep(500);
        expect(l.view.clients.has(b.clientID), "after leaving").toBe(true);
        let updates = 0;
        const stop = l.on("clientUpdated", (e) => {
          if (e.clientID === b.clientID) updates++;
        });
        try {
          await updateClient(b, { isAway: true });
          await updateClient(b, { isAway: false });
          await sleep(500);
        } finally {
          stop();
        }
        expect(updates, "updates of a client in the channel left").toBeGreaterThan(0);
      } finally {
        await unsubscribeChannel(l, room).catch(() => {});
        await b.disconnect().catch(() => {});
      }
    },
    60_000,
  );

  it("does nothing when told to unsubscribe from the channel the client is in", async () => {
    const here = l.channelID;
    expect(s.channelID).toBe(here);
    const announced = await fires(l, "channelUnsubscribed", here, () =>
      unsubscribeChannel(l, here),
    );
    expect(announced).toBe(false);
    expect(l.view.clients.has(s.clientID)).toBe(true);
    expect(await heardSome()).toBeGreaterThan(0);
  }, 20_000);

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

  it("relays 484-byte voice frames and 600-byte whispers, while the server drops a 485-byte voice frame", async () => {
    async function heardOfLength(
      size: number,
      send: () => void,
      whisper: boolean,
      fromID = s.clientID,
    ): Promise<number> {
      let count = 0;
      const stop = l.on("voiceData", (e) => {
        if (e.clientID === fromID && e.whisper === whisper && e.data.length === size) count++;
      });
      try {
        for (let i = 0; i < FRAMES; i++) {
          send();
          await sleep(20);
        }
        if (!whisper) s.sendVoice(new Uint8Array(0), Codec.OpusMusic);
        await sleep(500);
        return count;
      } finally {
        stop();
      }
    }

    async function heardSomeOfLength(
      size: number,
      send: () => void,
      whisper: boolean,
    ): Promise<number> {
      let count = 0;
      for (let attempt = 1; attempt <= 3 && count === 0; attempt++) {
        if (attempt > 1) await sleep(500);
        count = await heardOfLength(size, send, whisper);
      }
      return count;
    }

    const maxFrame = new Uint8Array(MAX_VOICE_FRAME_SIZE).fill(0x5a);
    expect(
      await heardSomeOfLength(
        MAX_VOICE_FRAME_SIZE,
        () => s.sendVoice(maxFrame, Codec.OpusMusic),
        false,
      ),
      "484-byte voice frame",
    ).toBeGreaterThan(0);

    expect(() => s.sendVoice(new Uint8Array(MAX_VOICE_FRAME_SIZE + 1), Codec.OpusMusic)).toThrow(
      RangeError,
    );

    // Bypass the SDK's guard through socketFactory: append 1 byte to outgoing
    // 500-byte Voice datagrams (type nibble 0, unencrypted under the fixed fake
    // tag) so a valid 501-byte packet carrying a 485-byte frame reaches the server.
    let padVoice = false;
    let paddedSent = 0;
    const padded = await connectClient(`ts-js-rlp-${RUN}`, {
      socketFactory: (family) => {
        const raw = createSocket(family === 6 ? "udp6" : "udp4");
        const wrapped: DatagramSocket = {
          connect: (port, address, cb) => raw.connect(port, address, cb),
          send: (data, cb) => {
            if (padVoice && data.length === 500 && (data[12]! & 0x0f) === 0) {
              const bigger = new Uint8Array(501);
              bigger.set(data);
              bigger[500] = 0x5a;
              paddedSent++;
              raw.send(bigger, cb);
              return;
            }
            raw.send(data, cb);
          },
          close: () => raw.close(),
          on: raw.on.bind(raw),
          once: raw.once.bind(raw),
          off: raw.off.bind(raw),
          address: () => raw.address(),
        };
        return wrapped;
      },
    });
    try {
      // Measure once, no retry: 0 frames is the expected server behaviour.
      padVoice = true;
      let droppedHeard = 0;
      const stop = l.on("voiceData", (e) => {
        if (e.clientID === padded.clientID && e.data.length > 0) droppedHeard++;
      });
      try {
        for (let i = 0; i < FRAMES; i++) {
          padded.sendVoice(maxFrame, Codec.OpusMusic);
          await sleep(20);
        }
        padVoice = false;
        padded.sendVoice(new Uint8Array(0), Codec.OpusMusic);
        await sleep(500);
      } finally {
        padVoice = false;
        stop();
      }
      expect(paddedSent, "501-byte voice datagrams sent").toBe(FRAMES);
      expect(droppedHeard, "485-byte voice frame sent on the wire").toBe(0);
    } finally {
      await padded.disconnect().catch(() => {});
    }

    const bigWhisper = new Uint8Array(600).fill(0x5a);
    expect(
      await heardSomeOfLength(
        600,
        () => s.sendWhisper(bigWhisper, { clients: [l.clientID] }, Codec.OpusMusic),
        true,
      ),
      "600-byte direct whisper",
    ).toBeGreaterThan(0);
    expect(
      await heardSomeOfLength(
        600,
        () =>
          s.sendGroupWhisper(
            bigWhisper,
            { type: GroupWhisperType.AllClients, scope: GroupWhisperScope.AllChannels },
            Codec.OpusMusic,
          ),
        true,
      ),
      "600-byte group whisper",
    ).toBeGreaterThan(0);
  }, 60_000);
});
