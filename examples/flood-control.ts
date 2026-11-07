/**
 * Pacing a voice client's commands against the server's antiflood: a token
 * bucket, a resend of a command the server refused as flooding, and a bucket
 * weighted by what each command costs. The SDK does none of this itself; these
 * are line middleware you copy and own. The numbers are a starting point, not a
 * measured optimum. See docs/flood-control.md.
 *
 * Run:
 *   TEAMSPEAK_ADDR=127.0.0.1:9987 pnpm tsx examples/flood-control.ts
 */

import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { floodWaitMs, type CommandLine, type LineMiddleware } from "@honeybbq/teamspeak";
import { Client, generateIdentitySync } from "@honeybbq/teamspeak/client";

/**
 * A token bucket every line waits on, with a pause that holds all of them.
 * 4 a second, a burst of 8, starting with 5: what the SDK used to do itself.
 */
export class Pacer {
  #perSecond: number;
  #burst: number;
  #tokens: number;
  #last = performance.now();
  #pausedUntil = 0;

  constructor(options: { perSecond?: number; burst?: number; start?: number } = {}) {
    this.#perSecond = options.perSecond ?? 4;
    this.#burst = options.burst ?? 8;
    this.#tokens = options.start ?? 5;
  }

  /** Change the rate and the burst, and start with a full bucket. */
  configure(options: { perSecond: number; burst: number }): void {
    this.#perSecond = options.perSecond;
    this.#burst = options.burst;
    this.#tokens = options.burst;
    this.#last = performance.now();
  }

  /** Hold every line for `ms`, and spend what had been saved up. */
  pause(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, performance.now() + ms);
    this.#tokens = 0;
  }

  /** Wait until `cost` tokens are there, and take them. Rejects when `signal` aborts. */
  async take(cost: number, signal: AbortSignal): Promise<void> {
    cost = Math.min(cost, this.#burst);
    for (;;) {
      signal.throwIfAborted();
      const now = performance.now();
      this.#tokens = Math.min(
        this.#burst,
        this.#tokens + ((now - this.#last) / 1000) * this.#perSecond,
      );
      this.#last = now;
      const paused = this.#pausedUntil - now;
      if (paused <= 0 && this.#tokens >= cost) {
        this.#tokens -= cost;
        return;
      }
      const refill = ((cost - this.#tokens) / this.#perSecond) * 1000;
      await sleep(Math.ceil(Math.max(paused, refill, 1)), undefined, { signal }).catch(() =>
        signal.throwIfAborted(),
      );
    }
  }
}

/** Recipe a: every line takes `cost` tokens from the pacer before it goes out. */
export function paced(pacer: Pacer, cost: (line: CommandLine) => number = () => 1): LineMiddleware {
  return (next) => async (line, options) => {
    await pacer.take(cost(line), options.signal);
    return next(line, options);
  };
}

/**
 * Recipe b: send a refused command again. The server named a wait; twice that
 * went through when a resend after exactly the wait was refused again. At most
 * `attempts` resends, all within the command's timeout and signal, and the pacer
 * holds every other line meanwhile. List it before `paced`, so a resend waits
 * for a token too.
 */
export function resendOnFlood(pacer: Pacer, attempts = 3): LineMiddleware {
  return (next) => async (line, options) => {
    for (let refused = 0; ; refused++) {
      try {
        return await next(line, options);
      } catch (error) {
        const wait = floodWaitMs(error);
        if (wait === undefined || refused >= attempts) throw error;
        pacer.pause(wait * 2);
        await sleep(wait * 2, undefined, { signal: options.signal }).catch(() =>
          options.signal.throwIfAborted(),
        );
      }
    }
  };
}

/**
 * Recipe c: what a command costs in antiflood points, as measured on TeamSpeak 3
 * 3.13.8 and TeamSpeak 6 6.0.0-beta13.1. A command not listed is charged 15, the
 * dearest measured here; some commands cost more on the third-party list the
 * docs link to.
 */
const COSTS: Readonly<Record<string, number>> = {
  servergetvariables: 0,
  permget: 5,
  channellist: 5,
  clientupdate: 15,
  sendtextmessage: 15,
};
export const costOf = (line: CommandLine): number => COSTS[line.name] ?? 15;

/**
 * Recipe c: read the thresholds with `servergetvariables` (free, and a fresh
 * guest may run it) and size the pacer to them: `tick_reduce` points a second,
 * and a burst of 80% of `command_block`. The tick is taken as one second. It was
 * not measured here; a third-party list says half a second, so one second errs
 * on the slow side.
 */
export async function sizeFromServer(pacer: Pacer, client: Client): Promise<void> {
  const [row] = await client.exec("servergetvariables");
  const tickReduce = Number(row?.["virtualserver_antiflood_points_tick_reduce"]);
  const commandBlock = Number(row?.["virtualserver_antiflood_points_needed_command_block"]);
  if (!(tickReduce > 0) || !(commandBlock > 0)) throw new Error("the server named no thresholds");
  pacer.configure({ perSecond: tickReduce, burst: commandBlock * 0.8 });
}

async function main(): Promise<void> {
  // Weighted by cost, resending what the server still refuses. Until the
  // thresholds are read, 5 points a second with a burst of 50.
  const pacer = new Pacer({ perSecond: 5, burst: 50, start: 50 });
  const client = new Client(
    generateIdentitySync(8),
    process.env["TEAMSPEAK_ADDR"] ?? "127.0.0.1:9987",
    "ts-js-flood",
    { lineMiddleware: [resendOnFlood(pacer), paced(pacer, costOf)] },
  );
  await client.connect();
  try {
    await sizeFromServer(pacer, client);
    for (let n = 0; n < 40; n++) await client.exec("clientupdate client_away=0");
    console.log("40 commands sent, none refused");
  } finally {
    await client.disconnect();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
