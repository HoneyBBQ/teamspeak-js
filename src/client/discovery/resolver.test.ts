import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import {
  MAX_DISCOVERY_RESPONSE,
  Resolver,
  orderSrvRecords,
  queryTSDNS,
  resolveNickname,
} from "./resolver.js";

import { InvalidAddressError } from "../errors.js";

// The machine's resolver may take seconds to say a made-up name has no SRV
// record, longer than a test may run. These tests are about what the resolver
// does with the answers, so every SRV lookup here finds none at once.
vi.mock("node:dns/promises", () => ({
  resolveSrv: () =>
    Promise.reject(Object.assign(new Error("no SRV record"), { code: "ENOTFOUND" })),
}));

afterEach(() => vi.restoreAllMocks());

describe("Resolver", () => {
  it("does not send a dot-less name to the nickname service unless asked", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("10.0.0.1:9987"));

    const plain = await new Resolver().resolve("mybox:9987");
    expect(fetch).not.toHaveBeenCalled();
    expect(plain[0]?.addr).toBe("mybox:9987");

    const looked = await new Resolver({ nicknameLookup: true }).resolve("mybox");
    expect(fetch).toHaveBeenCalledOnce();
    expect(looked[0]?.addr).toBe("10.0.0.1:9987");
  });

  it("rejects an empty address with InvalidAddressError", async () => {
    await expect(new Resolver().resolve("")).rejects.toBeInstanceOf(InvalidAddressError);
  });

  it("answers an IP address directly", async () => {
    const answer = await new Resolver().resolve("127.0.0.1:9988");
    expect(answer).toEqual([{ addr: "127.0.0.1:9988", source: "Direct" }]);
  });
});

describe("discovery reads", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  /** A TSDNS server that answers every query with `answer`, then keeps sending `flood`. */
  async function tsdns(answer: string, flood = ""): Promise<string> {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.write(answer);
      if (!flood) return;
      const timer = setInterval(() => socket.write(flood), 1);
      socket.on("close", () => clearInterval(timer));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return `127.0.0.1:${port}`;
  }

  it("takes a TSDNS server's one-line answer", async () => {
    expect(await queryTSDNS(await tsdns("10.0.0.1:9987\n"), "ts.example")).toBe("10.0.0.1:9987");
  });

  it(`gives up on a TSDNS server that sends ${MAX_DISCOVERY_RESPONSE} bytes without a line`, async () => {
    const started = Date.now();
    const addr = await tsdns("", "x".repeat(1024));
    expect(await queryTSDNS(addr, "ts.example")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it(`reads at most ${MAX_DISCOVERY_RESPONSE} bytes of the nickname service's answer`, async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024;
        controller.enqueue(new Uint8Array(1024).fill(0x61));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(endless));

    const answer = await resolveNickname("mybox");
    expect(answer).toHaveLength(MAX_DISCOVERY_RESPONSE);
    expect(pulled).toBeLessThan(4 * MAX_DISCOVERY_RESPONSE);
  });
});

describe("orderSrvRecords", () => {
  const rec = (name: string, priority: number, weight: number) => ({ name, priority, weight });
  const names = (records: Array<{ name: string }>) => records.map((r) => r.name);

  it("tries the lowest priority first, whatever order DNS gave", () => {
    const out = orderSrvRecords([rec("c", 20, 1), rec("a", 5, 1), rec("b", 10, 1)], () => 0);
    expect(names(out)).toEqual(["a", "b", "c"]);
  });

  it("picks within a priority by weight, and puts weight 0 last", () => {
    const records = [rec("zero", 1, 0), rec("light", 1, 1), rec("heavy", 1, 3)];
    // sum 4: [0,1) selects light, [1,4) selects heavy.
    expect(names(orderSrvRecords(records, () => 0.1))).toEqual(["light", "heavy", "zero"]);
    expect(names(orderSrvRecords(records, () => 0.5))).toEqual(["heavy", "light", "zero"]);
  });

  it("is first-choice proportional to weight", () => {
    const records = [rec("light", 1, 1), rec("heavy", 1, 3)];
    let heavyFirst = 0;
    for (let i = 0; i < 100; i++) {
      if (orderSrvRecords(records, () => i / 100)[0]!.name === "heavy") heavyFirst++;
    }
    expect(heavyFirst).toBe(75);
  });

  it("keeps all-zero weights in the order given", () => {
    const out = orderSrvRecords([rec("x", 1, 0), rec("y", 1, 0)], () => 0.9);
    expect(names(out)).toEqual(["x", "y"]);
  });
});
