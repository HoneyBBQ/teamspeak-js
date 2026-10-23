/**
 * Live tests of what a record or an event says when the server does not:
 * who moved a client that moved itself, which channel it came from when the
 * server sends no `cfid`, which client fields each `clientlist` flag brings,
 * and the channel description that no list or notification carries.
 *
 * Opt-in like the rest of the integration suite: they run when TEAMSPEAK_ADDR
 * and a query endpoint are set.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/client/records.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Reason,
  asClientID,
  createChannel,
  deleteChannel,
  editChannel,
  getChannelInfo,
  listChannels,
  listClients,
  moveClient,
  NoDataError,
} from "@honeybbq/teamspeak";
import type {
  ChannelID,
  ClientID,
  ClientMovedEvent,
  CommandExecutor,
  ServerEventMap,
} from "@honeybbq/teamspeak";
import { Client, clientInternals } from "./client.js";
import { subscribeChannel } from "./api/voice.js";
import { generateIdentitySync } from "./crypto/identity.js";
import type { QueryClient } from "../query/client.js";
import { KINDS, LiveSession, SKIP as NO_QUERY } from "../query/testing/live.js";
import type { Kind } from "../query/testing/live.js";

const ADDR = process.env["TEAMSPEAK_ADDR"];
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const SKIP = !ADDR || NO_QUERY;
const RUN = Date.now().toString(36).slice(-5);
const EVENT_MS = 10_000;

async function makeChannel(q: CommandExecutor, name: string): Promise<ChannelID> {
  try {
    return await createChannel(q, { name });
  } catch (error) {
    if (!(error instanceof NoDataError)) throw error;
    const found = (await listChannels(q)).find((c) => c.name === name);
    if (found === undefined) throw error;
    return found.id;
  }
}

interface Watcher {
  on<K extends "clientMoved">(name: K, listener: (payload: ServerEventMap[K]) => void): () => void;
}

/** The next move of `clientID` that `watcher` sees. */
/**
 * The next move of `clientID` into `target`. Matching the target as well keeps
 * a late event of an earlier move from being taken for this one.
 */
function nextMove(
  watcher: Watcher,
  clientID: ClientID,
  target: ChannelID,
): Promise<ClientMovedEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("no clientMoved event arrived"));
    }, EVENT_MS);
    const off = watcher.on("clientMoved", (event) => {
      if (event.clientID !== clientID || event.targetChannelID !== target) return;
      clearTimeout(timer);
      off();
      resolve(event);
    });
  });
}

describe.skipIf(SKIP)("Records and events when the server says less — live", () => {
  const session = new LiveSession();
  let admin: QueryClient;
  let observer: Client;
  let subject: Client;
  let subjectID: ClientID;
  let home: ChannelID;
  let room: ChannelID;
  const made: ChannelID[] = [];

  const connectVoice = async (nickname: string): Promise<Client> => {
    const client = new Client(generateIdentitySync(8), ADDR!, nickname, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    await client.connect({ signal: AbortSignal.timeout(15_000) });
    return client;
  };

  beforeAll(async () => {
    observer = await connectVoice(`ts-js-rs-obs-${RUN}`);
    subject = await connectVoice(`ts-js-rs-sub-${RUN}`);
    subjectID = asClientID(subject.clientID);
    // The fixture's own transport does the admin work; on TS6 SSH too, since
    // it delivers notifications over SSH and not WebQuery.
    const own: Kind = process.env["TEAMSPEAK_QUERY_KIND"] === "web" ? "web" : "tcp";
    await session.open([
      own,
      ...(process.env["TEAMSPEAK_QUERY_FAMILY"] === "ts6" && KINDS.includes("ssh")
        ? (["ssh"] as const)
        : []),
    ]);
    admin = session.first();
    room = await makeChannel(admin, `rs-room-${RUN}`);
    made.push(room);
    await subscribeChannel(observer, room);
    // The observer knows the subject once it has seen it enter.
    for (let i = 0; i < 50 && !clientInternals(observer).clients.has(subjectID); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    home = clientInternals(observer).clients.get(subjectID)!.channelID;
  }, 60_000);

  afterAll(async () => {
    await subject?.disconnect().catch(() => {});
    await observer?.disconnect().catch(() => {});
    for (const id of made) await deleteChannel(admin, id, { force: true }).catch(() => {});
    await session.close();
  }, 30_000);

  // WebQuery delivers no notifications, so the query watchers are the raw
  // TCP and SSH connections, whichever the fixture provisioned.
  const watchers: ReadonlyArray<readonly [string, () => Watcher | undefined]> = [
    ["a voice client", () => observer],
    ["a raw TCP ServerQuery client", () => session.clients.get("tcp")],
    ["an SSH ServerQuery client", () => session.clients.get("ssh")],
  ];

  describe.each(watchers)("a move seen by %s", (_who, getWatcher) => {
    const needs = (ctx: { skip: (reason?: string) => never }): Watcher =>
      getWatcher() ?? ctx.skip("this transport is not provisioned here");

    it("names no invoker for a client's own move, and says where it came from", async (ctx) => {
      const seen = nextMove(needs(ctx), subjectID, room);
      await moveClient(subject, subjectID, room);
      const event = await seen;
      console.log("own move:", event);
      expect(event.reason).toBe(Reason.None);
      expect(event.invokerID).toBe(0);
      expect(event.invokerName).toBe("");
      expect(event.invokerUID).toBe("");
      expect(event.targetChannelID).toBe(room);
      // TS3 sends no cfid, TS6 does; either way the SDK says where it came from.
      expect(event.fromChannelID).toBe(home);
    }, 20_000);

    it("names the invoker of an admin move, and where it came from", async (ctx) => {
      const seen = nextMove(needs(ctx), subjectID, home);
      await moveClient(admin, subjectID, home);
      const event = await seen;
      console.log("admin move:", event);
      expect(event.reason).toBe(Reason.Moved);
      expect(event.invokerID).not.toBe(0);
      expect(event.invokerName).not.toBe("");
      expect(event.fromChannelID).toBe(room);
      expect(event.targetChannelID).toBe(home);
    }, 20_000);
  });

  it("clientlist without a flag carries no field a flag brings", async () => {
    const [entry] = (await listClients(admin, { uid: false })).filter((c) => c.id === subjectID);
    expect(entry).toBeDefined();
    for (const field of [
      "uid",
      "serverGroups",
      "isAway",
      "isRecording",
      "isTalker",
      "channelGroupID",
      "createdAt",
      "lastConnectedAt",
      "idleTimeMs",
    ])
      expect(field in entry!, field).toBe(false);
    expect(entry).toMatchObject({ id: subjectID, channelID: home, type: 0 });
  });

  it.each([
    ["uid", ["uid"]],
    ["away", ["isAway"]],
    ["voice", ["isRecording", "isTalker"]],
    ["groups", ["serverGroups", "channelGroupID"]],
    ["times", ["createdAt", "lastConnectedAt", "idleTimeMs"]],
  ] as const)("clientlist with %s carries %j", async (flag, fields) => {
    const list = await listClients(admin, { uid: false, [flag]: true });
    const entry = list.find((c) => c.id === subjectID)!;
    for (const field of fields) expect(entry[field], field).not.toBeUndefined();
  });

  it("a channel's description is absent from the list and the view, and in channelinfo", async () => {
    const channel = await makeChannel(admin, `rs-desc-${RUN}`);
    made.push(channel);
    await subscribeChannel(observer, channel);
    await editChannel(admin, channel, { description: "the text" });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const listed = (await listChannels(admin)).find((c) => c.id === channel)!;
    expect("description" in listed).toBe(false);
    const viewed = observer.view.channel(channel);
    expect(viewed).toBeDefined();
    expect("description" in viewed!).toBe(false);
    expect((await getChannelInfo(admin, channel)).description).toBe("the text");
  }, 20_000);
});
