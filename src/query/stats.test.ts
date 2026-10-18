import { createServer } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { QueryClient } from "./client.js";
import { StreamTransport, type QueryStream } from "./stream.js";
import { connectTcp } from "./tcp.js";
import { WebQueryTransport } from "./web.js";
import type { QueryTransport } from "./transport.js";

class Stream implements QueryStream {
  data: Array<(chunk: Uint8Array) => void> = [];
  close: Array<() => void> = [];
  write(_data: string, callback: (error?: Error | null) => void): void {
    callback();
  }
  end(): void {
    for (const l of this.close) l();
  }
  on(event: "data" | "error" | "close", listener: never): unknown {
    if (event === "data") this.data.push(listener);
    if (event === "close") this.close.push(listener);
    return this;
  }
}

describe("QueryClient.stats", () => {
  it("is the zero value before a connection", () => {
    const client = new QueryClient({
      transport: { kind: "tcp", host: "127.0.0.1", port: 1 },
    });
    expect(client.stats).toEqual({
      connectedAt: undefined,
      transport: undefined,
      address: "",
      bytesSent: 0,
      bytesReceived: 0,
    });
  });

  it("is the zero value for a custom transport that keeps no counts", async () => {
    const transport: QueryTransport = {
      supportsNotifications: false,
      onLine: null,
      onClose: null,
      async send(line) {
        if (line.startsWith("version")) this.onLine?.("version=3.13.8 build=1 platform=Linux");
        this.onLine?.("error id=0 msg=ok");
      },
      async close() {},
    };
    const client = new QueryClient({
      transport: { kind: "custom", open: async () => transport },
    });
    await client.connect();
    expect(client.stats).toEqual({
      connectedAt: undefined,
      transport: undefined,
      address: "",
      bytesSent: 0,
      bytesReceived: 0,
    });
  });
});

describe("transport stats", () => {
  it("counts a stream's lines out with their terminator, and every byte in", async () => {
    const stream = new Stream();
    const transport = new StreamTransport(stream, undefined, {
      transport: "ssh",
      address: "u@h:1",
    });
    await transport.send("version");
    await transport.send("héllo");
    for (const l of stream.data) l(Buffer.from("TS3\nWelcome\n"));
    const stats = transport.stats();
    expect(stats).toMatchObject({
      transport: "ssh",
      address: "u@h:1",
      bytesSent: "version\n".length + Buffer.byteLength("héllo") + 1,
      bytesReceived: "TS3\nWelcome\n".length,
    });
    expect(stats.connectedAt).toBeInstanceOf(Date);
  });

  it("names a raw TCP connection by host and port", async () => {
    const server = createServer((socket) => socket.end("TS3\nWelcome\n"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const transport = await connectTcp({ host: "127.0.0.1", port });
    try {
      expect(transport.stats()).toMatchObject({ transport: "tcp", address: `127.0.0.1:${port}` });
    } finally {
      await transport.close();
      server.close();
    }
  });

  it("counts WebQuery bodies and leaves a user, password and api key out of the address", async () => {
    const answer = '{"body":[{"a":"b"}],"status":{"code":0,"message":"ok"}}';
    const transport = new WebQueryTransport({
      url: "http://user:pw@127.0.0.1:10080/",
      apiKey: "secret-key",
      fetch: (async () => new Response(answer)) as unknown as typeof fetch,
    });
    await transport.send("whoami");
    const stats = transport.stats();
    expect(stats.transport).toBe("web");
    expect(stats.address).toBe("http://127.0.0.1:10080");
    expect(JSON.stringify(stats)).not.toMatch(/secret-key|pw/);
    expect(stats.bytesSent).toBe(Buffer.byteLength("{}"));
    expect(stats.bytesReceived).toBe(Buffer.byteLength(answer));
  });
});
