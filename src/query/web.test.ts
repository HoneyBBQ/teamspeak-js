import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ErrorCode, ServerError, listBans, listChannels } from "@honeybbq/teamspeak";
import { QueryClient } from "./client.js";
import { WebQueryHttpError, WebQueryTransport } from "./web.js";
import type { QueryTransport } from "./transport.js";

/**
 * A client over a WebQuery transport, connected: this is how the built-in
 * `web` transport kind is reached, since the client builds its transport from
 * the options rather than being handed one.
 *
 * `setup` is how many requests connecting makes, which are then dropped from
 * `calls` so that a test sees its own.
 */
async function webClient(transport: WebQueryTransport, calls: Call[]): Promise<QueryClient> {
  const client = new QueryClient({
    transport: { kind: "custom", open: async (): Promise<QueryTransport> => transport },
  });
  await client.connect();
  calls.length = 0;
  return client;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records requests and answers each with the next reply. */
function fakeFetch(replies: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Call[] = [];
  let answeredWhoami = false;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    // `version` and `whoami` are asked for on every connection, so the setup's
    // are answered from here rather than from the queue each test fills. A
    // later `whoami` is the test's own.
    const setupWhoami = url.endsWith("/whoami") && !answeredWhoami;
    if (setupWhoami) answeredWhoami = true;
    const reply = url.endsWith("/version")
      ? versionOK
      : setupWhoami
        ? whoamiOK
        : (replies.shift() ?? {});
    const status = reply.status ?? 200;
    return new Response(reply.text ?? JSON.stringify(reply.json), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const ok = (body: unknown[] = []) => ({ json: { body, status: { code: 0, message: "ok" } } });

/** The answer to `version`, which the setup asks for on every connection. */
const versionOK: { status?: number; json?: unknown; text?: string } = {
  json: {
    body: [{ version: "3.13.8", build: "1", platform: "Linux" }],
    status: { code: 0, message: "ok" },
  },
};

/** The answer to `whoami`, which the setup asks for on every connection. */
const whoamiOK: { status?: number; json?: unknown; text?: string } = {
  json: { body: [{ client_id: "1" }], status: { code: 0, message: "ok" } },
};

describe("WebQueryTransport", () => {
  it("posts the command with its parameters as JSON and the api key", async () => {
    const { calls, fetchFn } = fakeFetch([ok([{ cid: "1", channel_name: "Lobby", pid: "0" }])]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h:10080/", apiKey: "KEY", serverID: 1, fetch: fetchFn }),
      calls,
    );

    const channels = await listChannels(client);

    expect(channels.map((c) => c.name)).toEqual(["Lobby"]);
    expect(calls[0]?.url).toBe("http://h:10080/1/channellist");
    expect(calls[0]?.headers["x-api-key"]).toBe("KEY");
    expect(calls[0]?.body).toEqual({
      "-topic": "",
      "-flags": "",
      "-voice": "",
      "-limits": "",
      "-icon": "",
      "-secondsempty": "",
      "-banners": "",
    });
  });

  it("sends no api key for a guest, and refuses a missing one otherwise", async () => {
    const { calls, fetchFn } = fakeFetch([ok([{ cid: "1", channel_name: "Lobby", pid: "0" }])]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", guest: true, serverID: 1, fetch: fetchFn }),
      calls,
    );

    await listChannels(client);

    expect(calls[0]?.headers).not.toHaveProperty("x-api-key");
    const missing = (options: object): WebQueryTransport =>
      new WebQueryTransport({ url: "http://h", ...options } as never);
    expect(() => missing({})).toThrow("guest");
    expect(() => missing({ apiKey: "" })).toThrow("guest");
    expect(() => missing({ apiKey: "K", guest: true })).toThrow(TypeError);
  });

  it("sends the rows of a list as an array", async () => {
    const { calls, fetchFn } = fakeFetch([ok()]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", serverID: 1, fetch: fetchFn }),
      calls,
    );
    await client.exec("ftdeletefile cid=1 cpw= name=/a|name=/b");
    expect(calls[0]?.body).toEqual([
      { cid: "1", cpw: "", name: "/a" },
      { cid: "1", cpw: "", name: "/b" },
    ]);
  });

  it("answers a refusal with the server's error, as a raw connection would", async () => {
    const { calls, fetchFn } = fakeFetch([
      { status: 400, json: { status: { code: 768, message: "invalid channelID" } } },
    ]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", serverID: 1, fetch: fetchFn }),
      calls,
    );
    const answered = client.exec("channelinfo cid=9");
    await expect(answered).rejects.toBeInstanceOf(ServerError);
    await expect(answered).rejects.toMatchObject({ code: ErrorCode.ChannelInvalidID });
  });

  it("reads 1281 as an empty list", async () => {
    const { calls, fetchFn } = fakeFetch([
      { json: { status: { code: 1281, message: "database empty result set" } } },
    ]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", serverID: 1, fetch: fetchFn }),
      calls,
    );
    expect(await listBans(client)).toEqual([]);
  });

  it("keeps the extra message of an error", async () => {
    const { calls, fetchFn } = fakeFetch([
      {
        status: 400,
        json: {
          status: { code: 1538, message: "invalid parameter", extra_message: "unknown command" },
        },
      },
    ]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: fetchFn }),
      calls,
    );
    await expect(client.exec("nosuch")).rejects.toMatchObject({
      code: 1538,
      extraMessage: "unknown command",
    });
  });

  it("treats an HTTP failure with no TeamSpeak code as a transport error", async () => {
    const { calls, fetchFn } = fakeFetch([{ status: 401, text: "unauthorized" }]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "bad", fetch: fetchFn }),
      calls,
    );
    const answered = client.exec("whoami");
    await expect(answered).rejects.toBeInstanceOf(WebQueryHttpError);
    await expect(answered).rejects.not.toBeInstanceOf(ServerError);
    await expect(answered).rejects.toMatchObject({ status: 401 });
  });

  it("keeps working after a transport error", async () => {
    const { calls, fetchFn } = fakeFetch([{ status: 502, text: "bad gateway" }, ok([{ a: "1" }])]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: fetchFn }),
      calls,
    );
    await expect(client.exec("whoami")).rejects.toBeInstanceOf(WebQueryHttpError);
    expect(await client.exec("whoami")).toEqual([{ a: "1" }]);
  });

  it("answers use itself, and addresses what it names", async () => {
    const { calls, fetchFn } = fakeFetch([ok(), ok(), ok()]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: fetchFn }),
      calls,
    );
    await client.exec("version");
    await client.use({ id: 2 });
    await client.exec("serverinfo");
    await client.use({ port: 9987 });
    await client.exec("serverinfo");
    expect(calls.map((c) => c.url)).toEqual([
      "http://h/version",
      "http://h/2/serverinfo",
      "http://h/byport/9987/serverinfo",
    ]);
  });

  it("rejects a use that names no server", async () => {
    const { calls, fetchFn } = fakeFetch([]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: fetchFn }),
      calls,
    );
    await expect(client.exec("use")).rejects.toBeInstanceOf(ServerError);
  });

  it("escapes values it turns back into rows", async () => {
    const { calls, fetchFn } = fakeFetch([ok([{ name: "a b|c", n: 5 }])]);
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: fetchFn }),
      calls,
    );
    expect(await client.exec("x")).toEqual([{ name: "a b|c", n: "5" }]);
  });

  it("honours the timeout while the request is in flight", async () => {
    // `version` and `whoami` answered, so the connection is made; everything
    // after them hangs.
    const hang = ((url: string) =>
      url.endsWith("/version") || url.endsWith("/whoami")
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                body: [{ version: "3.13.8", client_id: "1" }],
                status: { code: 0 },
              }),
              { status: 200 },
            ),
          )
        : new Promise<Response>(() => {})) as unknown as typeof fetch;
    const client = await webClient(
      new WebQueryTransport({ url: "http://h", apiKey: "K", fetch: hang }),
      [],
    );
    await expect(client.exec("serverinfo", { timeoutMs: 10 })).rejects.toMatchObject({
      name: "CommandTimeoutError",
    });
  });

  it("reaches a server over node:http when no fetch is given", async () => {
    let seen: { url?: string | undefined; key?: string | string[] | undefined; body: string } = {
      body: "",
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        seen = { url: req.url, key: req.headers["x-api-key"], body };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            body: req.url?.endsWith("/version") ? [{ version: "3.13.8" }] : [{ a: "1" }],
            status: { code: 0, message: "ok" },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const client = await webClient(
        new WebQueryTransport({ url: `http://127.0.0.1:${port}`, apiKey: "K", serverID: 1 }),
        [],
      );
      expect(await client.exec("whoami x=1")).toEqual([{ a: "1" }]);
      expect(seen.url).toBe("/1/whoami");
      expect(seen.key).toBe("K");
      expect(JSON.parse(seen.body)).toEqual({ x: "1" });
    } finally {
      server.close();
    }
  });
});
