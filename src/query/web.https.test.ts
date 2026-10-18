import { readFileSync } from "node:fs";
import { once } from "node:events";
import { Agent, createServer, globalAgent, request, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { rootCertificates } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "./client.js";
import { WebQueryTransport } from "./web.js";

// Test-only material: see test/fixtures/tls/README.md.
const dir = new URL("../../test/fixtures/tls/", import.meta.url);
const ca = readFileSync(new URL("ca.pem", dir));
const cert = readFileSync(new URL("server.pem", dir));
const key = readFileSync(new URL("server.key", dir));

const answers: Record<string, unknown[]> = {
  version: [{ version: "3.13.8", build: "1", platform: "Linux" }],
  whoami: [{ virtualserver_status: "online", client_id: "1", client_nickname: "serveradmin" }],
};

let server: Server | undefined;
afterEach(async () => {
  if (server === undefined) return;
  const closing = once(server, "close");
  server.close();
  await closing;
  server = undefined;
});

/** An HTTPS WebQuery stand-in on a free port; its URL. */
async function listen(): Promise<string> {
  server = createServer({ cert, key }, (req, res) => {
    const name = (req.url ?? "").split("/").pop() ?? "";
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ body: answers[name] ?? [], status: { code: 0, message: "ok" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A `fetch` that trusts one CA, over `node:https`. This is the example the
 * option's documentation gives for a private CA.
 */
function fetchTrusting(trusted: Buffer): typeof fetch {
  const agent = new Agent({ ca: trusted });
  return ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        { method: init.method, headers: init.headers as Record<string, string>, agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })),
          );
        },
      );
      req.on("error", reject);
      req.end(init.body as string);
    })) as unknown as typeof fetch;
}

describe("WebQuery over HTTPS", () => {
  it("answers over HTTPS through a fetch that trusts the CA", async () => {
    const url = await listen();
    const client = new QueryClient({
      transport: { kind: "web", url, apiKey: "k", fetch: fetchTrusting(ca) },
    });
    await client.connect();
    expect(client.serverFamily).toBe("ts3");
  });

  it("answers through the default fetch once Node trusts the CA", async () => {
    const url = await listen();
    const before = globalAgent.options.ca;
    globalAgent.options.ca = [...rootCertificates, ca.toString()];
    try {
      const client = new QueryClient({ transport: { kind: "web", url, apiKey: "k" } });
      await client.connect();
      expect(client.serverFamily).toBe("ts3");
    } finally {
      globalAgent.options.ca = before;
    }
  });

  it("refuses a certificate the default fetch does not trust, and fails closed", async () => {
    const url = await listen();
    const client = new QueryClient({ transport: { kind: "web", url, apiKey: "k" } });
    const failure = await client.connect().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    const text = `${failure?.message} ${(failure?.cause as Error | undefined)?.message ?? ""}`;
    expect(text).toMatch(/certificate|issuer/i);
  });

  it("refuses with a caller fetch whose CA is not the server's", async () => {
    const url = await listen();
    const other = Buffer.from(cert); // the leaf alone is not the issuer
    const client = new QueryClient({
      transport: { kind: "web", url, apiKey: "k", fetch: fetchTrusting(other) },
    });
    await expect(client.connect()).rejects.toThrow();
  });

  it("refuses a scheme the default fetch does not speak, at construction", () => {
    for (const url of ["ftp://h", "ws://h", "file:///x"]) {
      expect(() => new WebQueryTransport({ url, apiKey: "k" })).toThrow(TypeError);
    }
    expect(() => new WebQueryTransport({ url: "not a url", apiKey: "k" })).toThrow(TypeError);
  });

  it("accepts http: and https: URLs, and any scheme when the caller brings a fetch", () => {
    expect(() => new WebQueryTransport({ url: "http://h:10080", apiKey: "k" })).not.toThrow();
    expect(() => new WebQueryTransport({ url: "https://h:10443", apiKey: "k" })).not.toThrow();
    const fetchFn = (() => Promise.reject(new Error("unused"))) as unknown as typeof fetch;
    expect(
      () => new WebQueryTransport({ url: "unix://h", apiKey: "k", fetch: fetchFn }),
    ).not.toThrow();
  });
});
