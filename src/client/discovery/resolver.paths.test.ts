import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as nodeNet from "node:net";
import { createServer, type Server } from "node:net";
import { Resolver, resolveNickname } from "./resolver.js";
import { ResolveSource } from "../types.js";

// The resolver's SRV and TSDNS steps, end to end. SRV answers come from the
// table below instead of the machine's resolver, and a connection to a TSDNS
// server is redirected to a local one, so the resolver's own code runs
// unchanged: a name in `tsdnsServers` answers from 127.0.0.1, any other
// refuses.
const dns = vi.hoisted(() => ({
  srv: new Map<string, Array<{ name: string; port: number; priority: number; weight: number }>>(),
  srvLookups: [] as string[],
  tsdnsServers: new Map<string, number>(),
  dialled: [] as string[],
}));

vi.mock("node:dns/promises", () => ({
  resolveSrv: (name: string) => {
    dns.srvLookups.push(name);
    const records = dns.srv.get(name);
    return records
      ? Promise.resolve(records)
      : Promise.reject(Object.assign(new Error("no SRV record"), { code: "ENOTFOUND" }));
  },
}));

vi.mock("node:net", async (importOriginal) => {
  const net = await importOriginal<typeof nodeNet>();
  return {
    ...net,
    createConnection: (options: { host: string; port: number }, listener?: () => void) => {
      const asked = `${options.host}:${options.port}`;
      dns.dialled.push(asked);
      // Port 1 on loopback refuses at once.
      const port = dns.tsdnsServers.get(asked) ?? 1;
      return net.createConnection({ ...options, host: "127.0.0.1", port }, listener);
    },
  };
});

const servers: Server[] = [];
const queries: string[] = [];

/** A TSDNS server that answers as the official one does: no line break, then close. */
async function tsdnsAt(name: string, answer: string): Promise<void> {
  const server = createServer((socket) => {
    socket.once("data", (query) => {
      queries.push(`${name} ${query.toString().trim()}`);
      socket.end(answer);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  dns.tsdnsServers.set(name, address.port);
}

beforeEach(() => {
  dns.srv.clear();
  dns.srvLookups.length = 0;
  dns.tsdnsServers.clear();
  dns.dialled.length = 0;
  queries.length = 0;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  vi.restoreAllMocks();
});

describe("Resolver", () => {
  it("takes a _ts3._udp SRV record first", async () => {
    dns.srv.set("_ts3._udp.example.com", [
      { name: "voice.example.com.", port: 10000, priority: 10, weight: 0 },
      { name: "backup.example.com.", port: 10001, priority: 20, weight: 0 },
    ]);

    const resolved = await new Resolver().resolve("example.com");

    expect(resolved.map(({ addr, source }) => ({ addr, source }))).toEqual([
      { addr: "voice.example.com:10000", source: ResolveSource.SRV },
      { addr: "backup.example.com:10001", source: ResolveSource.SRV },
    ]);
    expect(dns.dialled).toEqual([]);
  });

  it("asks the TSDNS servers a _tsdns._tcp record names, in turn, until one answers", async () => {
    dns.srv.set("_tsdns._tcp.voice.example.com", [
      { name: "down.example.com.", port: 41000, priority: 10, weight: 0 },
      { name: "up.example.com.", port: 41001, priority: 20, weight: 0 },
    ]);
    await tsdnsAt("up.example.com:41001", "1.2.3.4:$PORT [::1]");

    const resolved = await new Resolver().resolve("voice.example.com:4321");

    expect(resolved.map(({ addr, source }) => ({ addr, source }))).toEqual([
      { addr: "1.2.3.4:4321", source: ResolveSource.TSDNSSRV },
      { addr: "[::1]:9987", source: ResolveSource.TSDNSSRV },
    ]);
    expect(dns.dialled).toEqual(["down.example.com:41000", "up.example.com:41001"]);
    // The query is the name alone, without the port.
    expect(queries).toEqual(["up.example.com:41001 voice.example.com"]);
  });

  it("asks a TSDNS server on each domain of the name at 41144, the most specific answer winning", async () => {
    await tsdnsAt("example.com:41144", "5.6.7.8:9000");

    const resolved = await new Resolver().resolve("a.voice.example.com");

    expect(resolved.map(({ addr, source }) => ({ addr, source }))).toEqual([
      { addr: "5.6.7.8:9000", source: ResolveSource.TSDNSDirect },
    ]);
    expect(dns.dialled).toEqual([
      "a.voice.example.com:41144",
      "voice.example.com:41144",
      "example.com:41144",
    ]);

    await tsdnsAt("voice.example.com:41144", "9.9.9.9:9001");
    const closer = await new Resolver().resolve("a.voice.example.com");
    expect(closer.map(({ addr }) => addr)).toEqual(["9.9.9.9:9001"]);
  });

  it("uses the address as given when nothing answers", async () => {
    await tsdnsAt("example.com:41144", "404");

    const resolved = await new Resolver().resolve("voice.example.com:4000");

    expect(resolved.map(({ addr, source }) => ({ addr, source }))).toEqual([
      { addr: "voice.example.com:4000", source: ResolveSource.Direct },
    ]);
  });

  it("keeps an answer for ten minutes", async () => {
    await tsdnsAt("example.com:41144", "5.6.7.8:9000");
    const resolver = new Resolver();

    const first = await resolver.resolve("voice.example.com");
    const lookups = dns.srvLookups.length;
    const again = await resolver.resolve("voice.example.com");

    expect(again).toEqual(first);
    expect(dns.srvLookups.length).toBe(lookups);
    expect(first[0]?.expiry?.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });
});

describe("Resolver with a custom resolveSrv", () => {
  it("asks it instead of the system, with the full name and a signal", async () => {
    const calls: Array<{ name: string; signal: AbortSignal }> = [];
    const resolveSrv = async (name: string, options: { readonly signal: AbortSignal }) => {
      calls.push({ name, signal: options.signal });
      return [
        { name: "backup.example.com.", port: 10001, priority: 20, weight: 0 },
        { name: "voice.example.com.", port: 10000, priority: 10, weight: 0 },
      ];
    };

    const answer = await new Resolver({ resolveSrv }).resolve("example.com");

    expect(answer.map((a) => [a.addr, a.source])).toEqual([
      ["voice.example.com:10000", ResolveSource.SRV],
      ["backup.example.com:10001", ResolveSource.SRV],
    ]);
    expect(calls.map((c) => c.name)).toEqual(["_ts3._udp.example.com"]);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(dns.srvLookups).toEqual([]);
  });

  it("answers the _tsdns._tcp lookups too", async () => {
    await tsdnsAt("tsdns.example.com:41144", "1.2.3.4:9987");
    const asked: string[] = [];
    const resolveSrv = async (name: string) => {
      asked.push(name);
      return name === "_tsdns._tcp.example.com"
        ? [{ name: "tsdns.example.com.", port: 41144, priority: 0, weight: 0 }]
        : [];
    };

    const answer = await new Resolver({ resolveSrv }).resolve("ts.example.com");

    expect(answer.map((a) => [a.addr, a.source])).toEqual([
      ["1.2.3.4:9987", ResolveSource.TSDNSSRV],
    ]);
    expect(asked).toEqual([
      "_ts3._udp.ts.example.com",
      "_tsdns._tcp.ts.example.com",
      "_tsdns._tcp.example.com",
    ]);
    expect(dns.srvLookups).toEqual([]);
  });

  it("takes a rejection or an empty list as no record", async () => {
    const rejecting = new Resolver({ resolveSrv: () => Promise.reject(new Error("refused")) });
    expect((await rejecting.resolve("a.example.com:9988"))[0]).toMatchObject({
      addr: "a.example.com:9988",
      source: ResolveSource.Direct,
    });

    const empty = new Resolver({ resolveSrv: () => Promise.resolve([]) });
    expect((await empty.resolve("b.example.com"))[0]).toMatchObject({
      addr: "b.example.com:9987",
      source: ResolveSource.Direct,
    });
  });

  it("cannot hold resolution up when it ignores the signal", async () => {
    const resolver = new Resolver({ resolveSrv: () => new Promise(() => {}) });
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = resolver.resolve("example.com", { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("resolveNickname", () => {
  const service = new URL("https://named.example.com/lookup");

  it("has no answer when the service refuses, fails, or sends nothing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    fetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await resolveNickname("mybox", service)).toBeNull();

    fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await resolveNickname("mybox", service)).toBeNull();

    fetch.mockResolvedValueOnce(new Response(null));
    expect(await resolveNickname("mybox", service)).toBeNull();
  });
});
