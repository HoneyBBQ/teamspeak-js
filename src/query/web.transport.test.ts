import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CommandTimeoutError } from "@honeybbq/teamspeak";
import { QueryClient } from "./client.js";
import { WebQueryHttpError, WebQueryTransport } from "./web.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const answer = (rows: unknown[]): string =>
  JSON.stringify({ body: rows, status: { code: 0, message: "ok" } });

async function linesOf(transport: WebQueryTransport, line: string): Promise<string[]> {
  const got: string[] = [];
  transport.onLine = (l) => got.push(l);
  await transport.send(line);
  return got;
}

describe("WebQuery transport requests", () => {
  it("does not follow a redirect, so the api key stays with the host it was for", async () => {
    let keys = 0;
    const other = await listen((req, res) => {
      if (req.headers["x-api-key"] !== undefined) keys++;
      res.end(answer([]));
    });
    const redirecting = await listen((req, res) => {
      res.writeHead(307, { location: `${other}${req.url}` }).end();
    });
    const transport = new WebQueryTransport({ url: redirecting, apiKey: "secret" });
    await expect(transport.send("version")).rejects.toMatchObject({
      constructor: WebQueryHttpError,
      status: 307,
    });
    expect(keys).toBe(0);
  });

  it("writes only what a row says: null, nested values and booleans as the server's text", async () => {
    const url = await listen((_req, res) => {
      res.end(answer([{ a: "x", n: 12, t: true, f: false, z: null, o: { k: 1 }, l: [1], e: "" }]));
    });
    const got = await linesOf(new WebQueryTransport({ url, apiKey: "k" }), "hostinfo");
    expect(got[0]).toBe("a=x n=12 t=1 f=0 z= o= l= e=");
  });

  it("ends the request with the command that stopped waiting, and the next gets its own answer", async () => {
    let aborted = 0;
    const url = await listen((req, res) => {
      if (req.url?.endsWith("/hostinfo") === true) {
        req.on("close", () => {
          if (!res.writableEnded) aborted++;
        });
        return; // never answered
      }
      res.end(answer([{ version: "3.13.8" }]));
    });
    const client = new QueryClient({
      transport: { kind: "custom", open: async () => new WebQueryTransport({ url, apiKey: "k" }) },
    });
    await client.connect();
    await expect(client.exec("hostinfo", { timeoutMs: 100 })).rejects.toBeInstanceOf(
      CommandTimeoutError,
    );
    const rows = await client.exec("version");
    expect(rows).toEqual([{ version: "3.13.8" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(1);
    await client.disconnect();
  });

  it("close() aborts a request in flight, and no line is delivered for it", async () => {
    const url = await listen(() => {});
    const transport = new WebQueryTransport({ url, apiKey: "k" });
    const got: string[] = [];
    transport.onLine = (l) => got.push(l);
    const sending = transport.send("hostinfo");
    await new Promise((r) => setTimeout(r, 30));
    await transport.close();
    await expect(sending).rejects.toThrow();
    expect(got).toEqual([]);
  });

  it("never delivers the answer of a request that was aborted, even from a fetch that ignores the signal", async () => {
    let release!: () => void;
    const late = new Promise<void>((r) => (release = r));
    const fetchIgnoringSignal = (async () => {
      await late;
      return new Response(answer([{ stale: "1" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new WebQueryTransport({
      url: "http://127.0.0.1:1",
      apiKey: "k",
      fetch: fetchIgnoringSignal,
    });
    const got: string[] = [];
    transport.onLine = (l) => got.push(l);
    const abort = new AbortController();
    const sending = transport.send("hostinfo", { signal: abort.signal });
    abort.abort();
    release();
    await expect(sending).rejects.toThrow();
    expect(got).toEqual([]);
  });
});
