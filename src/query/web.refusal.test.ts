import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebQueryTransport } from "./web.js";

/**
 * A server that decides from the headers alone and closes, the way a WebQuery
 * server can refuse a request it has no use for the body of: either with a
 * 401 and the TeamSpeak refusal in it, or with nothing at all.
 */
function listen(
  onHeaders: (socket: Socket) => void,
): Promise<{ server: Server; url: string; connections: () => number }> {
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.on("error", () => {});
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      if (!seen.includes("\r\n\r\n")) return;
      socket.removeAllListeners("data");
      onHeaders(socket);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        connections: () => connections,
      }),
    ),
  );
}

const refusal = JSON.stringify({
  status: { code: 5120, message: "out of scope", extra_message: "command not in api key scope" },
});

describe("WebQuery transport, against a server that closes early", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function lines(url: string, line: string): Promise<string[]> {
    const transport = new WebQueryTransport({ url, apiKey: "key" });
    const got: string[] = [];
    transport.onLine = (l) => got.push(l);
    await transport.send(line);
    return got;
  }

  // A refusal is complete with the headers, so a server may write it and close
  // with the body unread, which makes the kernel send a reset. What the server
  // said must still reach the caller, however large the body it never read.
  it.each([100, 64 * 1024, 4 * 1024 * 1024])(
    "reads a 401 the server wrote and closed on, with a %i byte body unread",
    async (size) => {
      const { server, url } = await listen((socket) =>
        socket.end(
          `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${refusal}`,
        ),
      );
      servers.push(server);
      for (let i = 0; i < 25; i++) {
        const got = await lines(url, `sendtextmessage msg=${"x".repeat(size)}`);
        expect(got.at(-1)).toBe(
          "error id=5120 msg=out\\sof\\sscope extra_msg=command\\snot\\sin\\sapi\\skey\\sscope",
        );
      }
    },
    60_000,
  );

  // A connection that ends with no response byte does not say whether the
  // command ran, so the transport reports it and sends nothing a second time.
  it("reports a connection closed before any response, and does not send the command again", async () => {
    const { server, url, connections } = await listen((socket) => socket.destroy());
    servers.push(server);
    await expect(lines(url, "servergroupdel sgid=7 force=1")).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(connections()).toBe(1);
  });
});
