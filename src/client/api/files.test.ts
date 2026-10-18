import { createServer, type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ServerError, asChannelID } from "@honeybbq/teamspeak";
import type { CommandExecutor, CommandRequest } from "@honeybbq/teamspeak";
import { FileTransferError } from "../errors.js";
import { downloadFile, uploadFile } from "./files.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A stand-in for the file transfer port: `handle` gets each connection. */
async function transferPort(handle: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    // A client that is done may reset the connection; that is not a failure here.
    socket.on("error", () => {});
    handle(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A file transfer port that keeps what `count` connections send; `ended` resolves when all have. */
async function sink(count: number) {
  const received: Buffer[] = [];
  let remaining = count;
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const port = await transferPort((socket) => {
    socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
    socket.on("end", () => {
      socket.end();
      if (--remaining === 0) finish();
    });
  });
  return { received, port, ended };
}

/** Records commands and answers each with the next reply, as a connection would. */
function executor(...replies: Array<Array<Record<string, string>> | Error>) {
  const sent: CommandRequest[] = [];
  const client: CommandExecutor = {
    send: async (request) => {
      sent.push(request);
      const reply = replies.shift() ?? [];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, sent };
}

/** The first rows of what a negotiation answers with. */
const negotiated = (port: number, extra: Record<string, string> = {}) => [
  {
    clientftfid: "1",
    serverftfid: "9",
    ftkey: "KEY-0123456789abcdef",
    port: String(port),
    ...extra,
  },
];

const cid = asChannelID(3n);

describe("uploadFile", () => {
  it("negotiates, then sends the key and the bytes to the named host", async () => {
    const { received, port, ended } = await sink(1);
    const { client, sent } = executor(negotiated(port, { seekpos: "0" }));

    await uploadFile(client, cid, "dir/a.bin", Buffer.from("hello"), {
      host: "127.0.0.1",
      overwrite: true,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toBe("ftinitupload");
    const params = Object.fromEntries(sent[0]!.params ?? []);
    expect(params).toMatchObject({ name: "/dir/a.bin", cid: 3n, size: 5n, overwrite: true });
    expect(params).not.toHaveProperty("resume", true);
    await ended;
    expect(Buffer.concat(received).toString()).toBe("KEY-0123456789abcdefhello");
  });

  it("sends an empty file, and a stream of the size it was told", async () => {
    const { received, port, ended } = await sink(2);
    const { client, sent } = executor(negotiated(port), negotiated(port));

    await uploadFile(client, cid, "/empty", new Uint8Array(0), { host: "127.0.0.1" });
    await uploadFile(client, cid, "/s", Readable.from([Buffer.from("ab"), Buffer.from("cd")]), {
      host: "127.0.0.1",
      size: 4,
    });

    expect(Object.fromEntries(sent[0]!.params ?? [])).toMatchObject({ size: 0n });
    expect(Object.fromEntries(sent[1]!.params ?? [])).toMatchObject({ size: 4n });
    await ended;
    expect(Buffer.concat(received).toString()).toBe("KEY-0123456789abcdefKEY-0123456789abcdefabcd");
  });

  it("refuses what it cannot send before it negotiates anything", async () => {
    const { client, sent } = executor();
    // No size for a stream, a size that is not the bytes', and no host to dial.
    await expect(
      uploadFile(client, cid, "/a", Readable.from([]), { host: "127.0.0.1" }),
    ).rejects.toThrow(TypeError);
    await expect(
      uploadFile(client, cid, "/a", Buffer.from("abc"), { host: "127.0.0.1", size: 4 }),
    ).rejects.toThrow(TypeError);
    await expect(uploadFile(client, cid, "/a", Buffer.from("abc"), { size: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(uploadFile(client, cid, "/a", Buffer.from("abc"))).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("throws the server's refusal of the negotiation, and dials nothing", async () => {
    const { client } = executor(new ServerError(2050, "file already exists"));
    await expect(
      uploadFile(client, cid, "/a", Buffer.from("x"), { host: "127.0.0.1" }),
    ).rejects.toMatchObject({ code: 2050 });
  });

  it("uses a voice client's own host and transfer sockets when nothing is named", async () => {
    const calls: Array<{ host: string; key: string; size: bigint; idle: number | undefined }> = [];
    const { client: bare } = executor(negotiated(1234));
    const voice = Object.assign(bare, {
      host: "voice.example",
      async uploadFileData(
        host: string,
        info: { fileTransferKey: string },
        data: Readable,
        options: { idleTimeoutMs?: number | undefined },
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of data) chunks.push(Buffer.from(chunk as Uint8Array));
        calls.push({
          host,
          key: info.fileTransferKey,
          size: BigInt(Buffer.concat(chunks).length),
          idle: options.idleTimeoutMs,
        });
      },
      downloadFileData: async () => {},
    });

    await uploadFile(voice, cid, "/a", Buffer.from("abc"), { idleTimeoutMs: 5 });
    expect(calls).toEqual([
      { host: "voice.example", key: "KEY-0123456789abcdef", size: 3n, idle: 5 },
    ]);
  });
});

describe("downloadFile", () => {
  const serve = (body: Buffer) =>
    transferPort((socket) => {
      socket.once("data", () => {
        socket.end(body);
      });
    });

  it("returns the bytes of the file", async () => {
    const port = await serve(Buffer.from("hello world"));
    const { client, sent } = executor(negotiated(port, { size: "11" }));
    const bytes = await downloadFile(client, cid, "dir/a.bin", { host: "127.0.0.1" });
    expect(Buffer.from(bytes).toString()).toBe("hello world");
    expect(sent[0]?.command).toBe("ftinitdownload");
    expect(Object.fromEntries(sent[0]!.params ?? [])).toMatchObject({
      name: "/dir/a.bin",
      cid: 3n,
      seekpos: 0n,
    });
  });

  it("returns an empty file as no bytes", async () => {
    const port = await serve(Buffer.alloc(0));
    const { client } = executor(negotiated(port, { size: "0" }));
    expect(await downloadFile(client, cid, "/e", { host: "127.0.0.1" })).toHaveLength(0);
  });

  it("writes into a stream instead of holding the file, which maxSize does not limit", async () => {
    const port = await serve(Buffer.from("0123456789"));
    const { client } = executor(negotiated(port, { size: "10" }));
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    const result = await downloadFile(client, cid, "/a", { host: "127.0.0.1", dest, maxSize: 1 });
    expect(result).toBeUndefined();
    expect(Buffer.concat(chunks).toString()).toBe("0123456789");
  });

  it("refuses a file over maxSize before reading it", async () => {
    let dialled = false;
    const port = await transferPort(() => {
      dialled = true;
    });
    const { client } = executor(negotiated(port, { size: "11" }));
    await expect(
      downloadFile(client, cid, "/a", { host: "127.0.0.1", maxSize: 10 }),
    ).rejects.toBeInstanceOf(FileTransferError);
    expect(dialled).toBe(false);
    await expect(downloadFile(client, cid, "/a", { maxSize: -1 })).rejects.toThrow(RangeError);
  });

  it("throws the server's refusal, and a size announced but never sent", async () => {
    const refused = executor(new ServerError(2051, "file not found"));
    await expect(
      downloadFile(refused.client, cid, "/nope", { host: "127.0.0.1" }),
    ).rejects.toMatchObject({ code: 2051 });

    const port = await serve(Buffer.alloc(0));
    const { client } = executor(negotiated(port, { size: "10" }));
    await expect(downloadFile(client, cid, "/dir", { host: "127.0.0.1" })).rejects.toBeInstanceOf(
      FileTransferError,
    );
  });

  it("needs a host a bare connection does not give", async () => {
    const { client, sent } = executor();
    await expect(downloadFile(client, cid, "/a")).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });
});
