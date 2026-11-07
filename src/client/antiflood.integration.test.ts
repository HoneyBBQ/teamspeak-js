/**
 * Live measurement of the voice antiflood, which `docs/flood-control.md`
 * quotes: what each command costs in points, that `servergetvariables` costs
 * none, what the 524 refusal says, and that a fresh guest identity can read
 * the four thresholds.
 *
 * It edits the virtual server's antiflood settings through the fixture's admin
 * query connection, and puts them back (they are read first) in `finally`.
 *
 *   source ~/.cache/tslive/ts3.env && pnpm vitest run --project integration src/client/antiflood.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorCode,
  PermissionName,
  PropertyName,
  ServerError,
  editServer,
  floodWaitMs,
  getServerInfo,
} from "@honeybbq/teamspeak";
import type { Client } from "./client.js";
import { KINDS, LiveSession, SKIP, VOICE_ADDR } from "../query/testing/live.js";

const FIELDS = [
  PropertyName.VirtualServerAntiFloodPointsTickReduce,
  PropertyName.VirtualServerAntiFloodPointsNeededCommandBlock,
  PropertyName.VirtualServerAntiFloodPointsNeededIPBlock,
  PropertyName.VirtualServerAntiFloodPointsNeededPluginBlock,
] as const;
const [TICK_REDUCE, COMMAND_BLOCK, IP_BLOCK] = FIELDS;

/** The most commands one count sends: a command that costs nothing never reaches a block. */
const COUNT_LIMIT = 700;

describe.skipIf(SKIP || KINDS.length === 0 || VOICE_ADDR === undefined)(
  "voice antiflood — live",
  () => {
    const session = new LiveSession();
    let original: Record<string, string> = {};

    beforeAll(async () => {
      await session.open([KINDS[0]!]);
      const info = await getServerInfo(session.first());
      original = Object.fromEntries(FIELDS.map((f) => [f, info[f] ?? ""]));
    }, 60_000);

    afterAll(async () => {
      try {
        // What the fixture had before this file changed it.
        await editServer(session.first(), original);
      } finally {
        await session.close();
      }
    }, 60_000);

    /** Accepted commands before the first 524, with the refusal, on a client no middleware touches. */
    async function accepted(
      client: Client,
      command: string,
    ): Promise<{ count: number; refusal: ServerError | undefined }> {
      for (let count = 0; count < COUNT_LIMIT; count++) {
        try {
          await client.exec(command);
        } catch (error) {
          if (error instanceof ServerError && error.code === ErrorCode.ClientIsFlooding) {
            return { count, refusal: error };
          }
          throw error;
        }
      }
      return { count: COUNT_LIMIT, refusal: undefined };
    }

    /** The count for a command with command_block at `block`, on a fresh client. */
    async function countAt(
      block: number,
      name: string,
      command: (client: Client) => string,
    ): Promise<{ count: number; refusal: ServerError | undefined }> {
      await editServer(session.first(), {
        [TICK_REDUCE]: 1,
        [IP_BLOCK]: 65000,
        [COMMAND_BLOCK]: block,
      });
      const client = await session.voice(`ts-js-af-${name}-${block}`);
      try {
        return await accepted(client, command(client));
      } finally {
        await client.disconnect().catch(() => {});
      }
    }

    it("lets a fresh guest identity read the four thresholds with servergetvariables", async () => {
      const guest = await session.voice("ts-js-af-read");
      const rows = await guest.exec("servergetvariables");
      for (const field of FIELDS) expect(rows[0]?.[field], field).toBeDefined();
    }, 60_000);

    it("has servergetvariables cost nothing: 400 of them get through at command_block 200", async () => {
      await editServer(session.first(), {
        [TICK_REDUCE]: 1,
        [IP_BLOCK]: 65000,
        [COMMAND_BLOCK]: 200,
      });
      const client = await session.voice("ts-js-af-free");
      for (let n = 0; n < 400; n++) await client.exec("servergetvariables");
    }, 120_000);

    // The cost of one command is the points it adds, which a block at 200 and
    // one at 600 let through as 400 points' worth more of them.
    it.each([
      ["permget", 5, () => `permget permsid=${PermissionName.ClientIgnoreAntiflood}`],
      ["channellist", 5, () => "channellist"],
      ["clientupdate", 15, () => "clientupdate client_away=0"],
      [
        "sendtextmessage",
        15,
        (client: Client) => `sendtextmessage targetmode=2 target=${client.channelID} msg=x`,
      ],
    ] as const)(
      "costs %s %i points",
      async (name, cost, command) => {
        const low = await countAt(200, name, command);
        const high = await countAt(600, name, command);
        expect(low.refusal, "refused at command_block 200").toBeDefined();
        expect(high.refusal, "refused at command_block 600").toBeDefined();
        expect(400 / (high.count - low.count)).toBeCloseTo(cost, 0);

        // The refusal names a wait, and floodWaitMs reads it.
        const wait = floodWaitMs(high.refusal);
        expect(wait, high.refusal?.extraMessage).toBeGreaterThanOrEqual(0);
        expect(high.refusal?.extraMessage).toMatch(/^retry in \d+ms$/);
      },
      180_000,
    );
  },
);
