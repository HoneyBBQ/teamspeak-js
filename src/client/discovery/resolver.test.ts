import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import {
  MAX_DISCOVERY_RESPONSE,
  Resolver,
  orderSrvRecords,
  lookupTSDNS,
  normalizeTSDNSEntries,
  resolveNickname,
} from "./resolver.js";

import { TeamspeakError } from "@honeybbq/teamspeak";
import { InvalidAddressError } from "../errors.js";
import { ResolveSource } from "../types.js";

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

  it("uses a custom fetch for the nickname lookup, not the global one", async () => {
    const global = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("10.0.0.9:9987"));
    const custom = vi.fn<typeof fetch>().mockResolvedValue(new Response("10.0.0.1:9987"));

    const answer = await new Resolver({ nicknameLookup: true, fetch: custom }).resolve("mybox");

    expect(answer[0]?.addr).toBe("10.0.0.1:9987");
    expect(custom).toHaveBeenCalledOnce();
    expect(custom.mock.calls[0]![0]).toBe("https://named.myteamspeak.com/lookup?name=mybox");
    expect(global).not.toHaveBeenCalled();
  });

  it("throws a TypeError for a resolveSrv or fetch that is not a function", () => {
    const bad = "nope" as never;
    expect(() => new Resolver({ resolveSrv: bad })).toThrow(TypeError);
    expect(() => new Resolver({ fetch: bad })).toThrow(TypeError);
  });

  describe("nicknameService", () => {
    const http: Array<{ close(): void }> = [];
    afterEach(() => {
      for (const server of http.splice(0)) server.close();
    });

    async function nicknames(answer: string): Promise<{ url: string; asked: string[] }> {
      const asked: string[] = [];
      const server = createHttpServer((req, res) => {
        asked.push(req.url ?? "");
        res.end(`${answer}\nignored`);
      });
      http.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return { url: `http://127.0.0.1:${port}/lookup`, asked };
    }

    it("is where a dot-less name is looked up", async () => {
      const { url, asked } = await nicknames("127.0.0.1:9999");
      const resolver = new Resolver({ nicknameLookup: true, nicknameService: url });
      expect(await resolver.resolve("mybox")).toEqual([
        expect.objectContaining({ addr: "127.0.0.1:9999", source: ResolveSource.Direct }),
      ]);
      expect(asked).toEqual(["/lookup?name=mybox"]);
    });

    it("is not called unless nicknameLookup is on", async () => {
      const { url, asked } = await nicknames("127.0.0.1:9999");
      const answer = await new Resolver({ nicknameService: new URL(url) }).resolve("mybox:9987");
      expect(answer[0]?.addr).toBe("mybox:9987");
      expect(asked).toEqual([]);
    });

    it("throws a TypeError for a URL that is not http: or https:", () => {
      expect(() => new Resolver({ nicknameService: "not a url" })).toThrow(TypeError);
      expect(() => new Resolver({ nicknameService: "ftp://nick.example/lookup" })).toThrow(
        TypeError,
      );
    });
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

  /** A TSDNS server that runs `onQuery` for each connection once it has been asked. */
  async function serving(onQuery: (socket: Socket) => void): Promise<string> {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => onQuery(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it("takes a TSDNS server's one-line answer", async () => {
    expect(await lookupTSDNS(await tsdns("10.0.0.1:9987\n"), "ts.example")).toEqual([
      "10.0.0.1:9987",
    ]);
  });

  it("sends the name alone, with a line break", async () => {
    let asked = "";
    const addr = await serving((socket) => socket.end("10.0.0.1\n"));
    const server = servers[servers.length - 1]!;
    server.on("connection", (socket) => socket.on("data", (d) => (asked += d.toString())));
    await lookupTSDNS(addr, "ts.example");
    expect(asked).toBe("ts.example\n");
  });

  it("reads an answer the server ends by closing the connection", async () => {
    const addr = await serving((socket) => socket.end("1.2.3.4:9987"));
    expect(await lookupTSDNS(addr, "ts.example")).toEqual(["1.2.3.4:9987"]);
  });

  it("has no record for a 404, an errors, or an empty answer", async () => {
    expect(await lookupTSDNS(await tsdns("404\n"), "ts.example")).toEqual([]);
    expect(await lookupTSDNS(await serving((s) => s.end("errors")), "ts.example")).toEqual([]);
    expect(await lookupTSDNS(await serving((s) => s.end()), "ts.example")).toEqual([]);
  });

  it("lists every target of an answer, as given", async () => {
    const addr = await tsdns("1.2.3.4:9987 [::1]:9988  5.6.7.8\n");
    expect(await lookupTSDNS(addr, "ts.example")).toEqual([
      "1.2.3.4:9987",
      "[::1]:9988",
      "5.6.7.8",
    ]);
  });

  it("rejects when the connection fails", async () => {
    const addr = await serving(() => {});
    servers.pop()!.close();
    await expect(lookupTSDNS(addr, "ts.example")).rejects.toThrow();
  });

  it("rejects with a TeamspeakError when no answer comes in time", async () => {
    vi.useFakeTimers();
    try {
      const addr = await serving(() => {});
      const pending = lookupTSDNS(addr, "ts.example");
      const settled = expect(pending).rejects.toBeInstanceOf(TeamspeakError);
      await vi.advanceTimersByTimeAsync(3_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects without connecting when the signal is already aborted", async () => {
    let connections = 0;
    const addr = await serving(() => {});
    servers[servers.length - 1]!.on("connection", () => connections++);
    const reason = new Error("stop");
    await expect(
      lookupTSDNS(addr, "ts.example", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connections).toBe(0);
  });

  it("rejects with the signal's reason when aborted mid-query", async () => {
    const addr = await serving(() => {});
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = lookupTSDNS(addr, "ts.example", { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 30);
    await expect(pending).rejects.toBe(reason);
  });

  it(`rejects a TSDNS server that sends ${MAX_DISCOVERY_RESPONSE} bytes without a line`, async () => {
    const started = Date.now();
    const addr = await tsdns("", "x".repeat(1024));
    await expect(lookupTSDNS(addr, "ts.example")).rejects.toBeInstanceOf(TeamspeakError);
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

    const answer = await resolveNickname("mybox", new URL("https://nick.example/lookup"));
    expect(answer).toHaveLength(MAX_DISCOVERY_RESPONSE);
    expect(pulled).toBeLessThan(4 * MAX_DISCOVERY_RESPONSE);
  });
});

describe("normalizeTSDNSEntries", () => {
  it("keeps a numeric port", () => {
    expect(normalizeTSDNSEntries(["1.2.3.4:5000", "[::1]:9988"], "4321")).toEqual([
      "1.2.3.4:5000",
      "[::1]:9988",
    ]);
  });

  it("gives an entry without a port 9987, whatever port was asked for", () => {
    expect(normalizeTSDNSEntries(["1.2.3.4", "[::1]", "ts.example"], "4321")).toEqual([
      "1.2.3.4:9987",
      "[::1]:9987",
      "ts.example:9987",
    ]);
  });

  it("gives the port $PORT the port of the address being resolved", () => {
    expect(
      normalizeTSDNSEntries(["1.2.3.4:$PORT", "[2001:db8::1]:$PORT", "ts.example:$PORT"], "4321"),
    ).toEqual(["1.2.3.4:4321", "[2001:db8::1]:4321", "ts.example:4321"]);
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

describe("ResolveSource", () => {
  it("is frozen and holds the values the resolver sets", async () => {
    expect(Object.isFrozen(ResolveSource)).toBe(true);
    expect(ResolveSource).toEqual({
      SRV: "SRV",
      TSDNSSRV: "TSDNS-SRV",
      TSDNSDirect: "TSDNS-Direct",
      Direct: "Direct",
    });
    const [answer] = await new Resolver().resolve("127.0.0.1:9987");
    expect(answer?.source).toBe(ResolveSource.Direct);
  });
});
