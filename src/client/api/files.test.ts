import { createServer, type Server, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const KEY = "KEY-0123456789abcdef";

/**
 * A file transfer port that keeps what its connections send, one per entry of
 * `sizes`, and closes each once it holds the key and that many bytes, as the
 * server does with a whole file; `ended` resolves when all have.
 */
async function sink(...sizes: number[]) {
  const received: Buffer[] = [];
  const pending = [...sizes];
  let remaining = sizes.length;
  let finish: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const port = await transferPort((socket) => {
    let got = 0;
    const want = KEY.length + (pending.shift() ?? 0);
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      got += chunk.length;
      if (got >= want) {
        socket.end();
        if (--remaining === 0) finish();
      }
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
    ftkey: KEY,
    port: String(port),
    ...extra,
  },
];

/** What `ftgetfileinfo` answers with for a file of `size` bytes. */
const held = (size: number) => [{ name: "f", size: String(size), datetime: "0", type: "1" }];

const cid = asChannelID(3n);

describe("uploadFile", () => {
  it("negotiates, then sends the key and the bytes to the named host", async () => {
    const { received, port, ended } = await sink(5);
    const { client, sent } = executor(negotiated(port, { seekpos: "0" }), held(5));

    await uploadFile(client, cid, "dir/a.bin", Buffer.from("hello"), {
      host: "127.0.0.1",
      overwrite: true,
    });

    expect(sent.map((r) => r.command)).toEqual(["ftinitupload", "ftgetfileinfo"]);
    expect(Object.fromEntries(sent[1]!.params ?? [])).toMatchObject({
      cid: 3n,
      name: "/dir/a.bin",
    });
    const params = Object.fromEntries(sent[0]!.params ?? []);
    expect(params).toMatchObject({
      name: "/dir/a.bin",
      cid: 3n,
      size: 5n,
      overwrite: true,
    });
    expect(params).toMatchObject({ resume: false });
    await ended;
    expect(Buffer.concat(received).toString()).toBe(`${KEY}hello`);
  });

  it("sends an empty file, and a stream of the size it was told", async () => {
    const { received, port, ended } = await sink(0, 4);
    const { client, sent } = executor(negotiated(port), held(0), negotiated(port), held(4));

    await uploadFile(client, cid, "/empty", new Uint8Array(0), {
      host: "127.0.0.1",
    });
    await uploadFile(client, cid, "/s", Readable.from([Buffer.from("ab"), Buffer.from("cd")]), {
      host: "127.0.0.1",
      size: 4,
    });

    expect(Object.fromEntries(sent[0]!.params ?? [])).toMatchObject({
      size: 0n,
    });
    expect(Object.fromEntries(sent[2]!.params ?? [])).toMatchObject({
      size: 4n,
    });
    await ended;
    expect(Buffer.concat(received).toString()).toBe(`${KEY}${KEY}abcd`);
  });

  it("resumes: asks for it, and sends only the bytes the server does not hold", async () => {
    const { received, port, ended } = await sink(2, 2);
    const { client, sent } = executor(
      negotiated(port, { seekpos: "3" }),
      held(5),
      negotiated(port, { seekpos: "3" }),
      held(5),
    );

    await uploadFile(client, cid, "/a", Buffer.from("hello"), {
      host: "127.0.0.1",
      resume: true,
    });
    // A stream is the whole file as well, and its first bytes are skipped.
    await uploadFile(client, cid, "/b", Readable.from([Buffer.from("he"), Buffer.from("llo")]), {
      host: "127.0.0.1",
      resume: true,
      size: 5,
    });

    expect(Object.fromEntries(sent[0]!.params ?? [])).toMatchObject({
      size: 5n,
      resume: true,
    });
    await ended;
    expect(Buffer.concat(received).toString()).toBe(`${KEY}lo${KEY}lo`);
  });

  it("fails a stream shorter or longer than its size", async () => {
    const { port } = await sink(0, 0);
    const { client } = executor(negotiated(port), negotiated(port));
    await expect(
      uploadFile(client, cid, "/short", Readable.from([Buffer.from("abc")]), {
        host: "127.0.0.1",
        size: 4,
      }),
    ).rejects.toBeInstanceOf(FileTransferError);
    await expect(
      uploadFile(client, cid, "/long", Readable.from([Buffer.from("abcde")]), {
        host: "127.0.0.1",
        size: 4,
      }),
    ).rejects.toBeInstanceOf(FileTransferError);
  });

  it("refuses what it cannot send before it negotiates anything", async () => {
    const { client, sent } = executor();
    // No size for a stream, a size that is not the bytes', and no host to dial.
    await expect(
      uploadFile(client, cid, "/a", Readable.from([]), { host: "127.0.0.1" }),
    ).rejects.toThrow(TypeError);
    await expect(
      uploadFile(client, cid, "/a", Buffer.from("abc"), {
        host: "127.0.0.1",
        size: 4,
      }),
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
    const calls: Array<{
      host: string;
      key: string;
      size: bigint;
      idle: number | undefined;
    }> = [];
    const { client: bare } = executor(negotiated(1234), held(3));
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

    await uploadFile(voice, cid, "/a", Buffer.from("abc"), {
      idleTimeoutMs: 5,
    });
    expect(calls).toEqual([{ host: "voice.example", key: KEY, size: 3n, idle: 5 }]);
  });
});

describe("uploadFile, once the connection closed", () => {
  it("fails when the server holds fewer bytes than were sent", async () => {
    const { port } = await sink(5);
    const { client } = executor(negotiated(port), held(2));
    await expect(
      uploadFile(client, cid, "/a", Buffer.from("hello"), {
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(/holds 2 of the 5 bytes/);
  });

  it("fails when the server has no such file", async () => {
    const { port } = await sink(5, 5);
    for (const code of [2051, 2052]) {
      const { client } = executor(negotiated(port), new ServerError(code, "x"));
      await expect(
        uploadFile(client, cid, "/a", Buffer.from("hello"), {
          host: "127.0.0.1",
        }),
      ).rejects.toBeInstanceOf(FileTransferError);
    }
  });

  it("resolves when the client may not look at the file (2568), and throws any other failure", async () => {
    const { port } = await sink(5, 5);
    const denied = executor(negotiated(port), new ServerError(2568, "insufficient"));
    await uploadFile(denied.client, cid, "/a", Buffer.from("hello"), {
      host: "127.0.0.1",
    });
    const broken = executor(negotiated(port), new ServerError(524, "flooding"));
    await expect(
      uploadFile(broken.client, cid, "/a", Buffer.from("hello"), {
        host: "127.0.0.1",
      }),
    ).rejects.toMatchObject({ code: 524 });
  });
});

describe("a transfer whose dial fails", () => {
  /** A port nothing listens on. */
  const closedPort = async (): Promise<number> => {
    const port = await transferPort(() => {});
    for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
    return port;
  };

  it("stops the negotiated transfer after a refused connection, and keeps the dial's error", async () => {
    const port = await closedPort();
    for (const run of [
      (c: CommandExecutor) => uploadFile(c, cid, "/a", Buffer.from("x"), { host: "127.0.0.1" }),
      (c: CommandExecutor) => downloadFile(c, cid, "/a", { host: "127.0.0.1" }),
      (c: CommandExecutor) =>
        downloadFile(c, cid, "/a", {
          host: "127.0.0.1",
          dest: new Writable({ write: (_c, _e, d) => d() }),
        }),
    ]) {
      const { client, sent } = executor(negotiated(port, { size: "1" }), new Error("stop failed"));
      const error = await run(client).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FileTransferError);
      expect((error as Error).message).toMatch(/connection failed/);
      expect(sent.map((r) => r.command).slice(0, 2)).toEqual([sent[0]!.command, "ftstop"]);
      expect(Object.fromEntries(sent[1]!.params ?? [])).toMatchObject({
        serverftfid: 9,
      });
    }
  });

  it("does not stop it once the connection opened, nor when the caller ended it", async () => {
    // Opens, takes the key, and drops the connection: the server may hold the transfer.
    const open = await transferPort((socket) => socket.once("data", () => socket.destroy()));
    const dropped = executor(negotiated(open, { size: "1" }));
    await expect(
      downloadFile(dropped.client, cid, "/a", { host: "127.0.0.1" }),
    ).rejects.toBeInstanceOf(FileTransferError);
    expect(dropped.sent.map((r) => r.command)).toEqual(["ftinitdownload"]);

    const port = await closedPort();
    const aborted = executor(negotiated(port));
    await expect(
      uploadFile(aborted.client, cid, "/a", Buffer.from("x"), {
        host: "127.0.0.1",
        signal: AbortSignal.abort(new Error("caller")),
      }),
    ).rejects.toThrow();
    expect(aborted.sent.map((r) => r.command)).toEqual(["ftinitupload"]);
  });

  it("does not stop a transfer the server has probably dropped by itself", async () => {
    const port = await closedPort();
    const { client, sent } = executor(negotiated(port));
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValue(6_000);
    try {
      await expect(
        uploadFile(client, cid, "/a", Buffer.from("x"), { host: "127.0.0.1" }),
      ).rejects.toBeInstanceOf(FileTransferError);
    } finally {
      now.mockRestore();
    }
    expect(sent.map((r) => r.command)).toEqual(["ftinitupload"]);
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
    const bytes = await downloadFile(client, cid, "dir/a.bin", {
      host: "127.0.0.1",
    });
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
    const result = await downloadFile(client, cid, "/a", {
      host: "127.0.0.1",
      dest,
      maxSize: 1,
    });
    expect(result).toBeUndefined();
    expect(Buffer.concat(chunks).toString()).toBe("0123456789");
  });

  it("downloads from a seek position: the bytes to the end of the file", async () => {
    const port = await serve(Buffer.from("456789"));
    const { client, sent } = executor(negotiated(port, { size: "10" }));
    const bytes = await downloadFile(client, cid, "/a", {
      host: "127.0.0.1",
      seekPosition: 4n,
    });
    expect(Buffer.from(bytes).toString()).toBe("456789");
    expect(Object.fromEntries(sent[0]!.params ?? [])).toMatchObject({
      seekpos: 4n,
    });
  });

  it("takes several downloads into one stream, ending none", async () => {
    const port = await serve(Buffer.from("0123456789"));
    const { client } = executor(negotiated(port, { size: "10" }), negotiated(port, { size: "10" }));
    const chunks: Buffer[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    await downloadFile(client, cid, "/a", { host: "127.0.0.1", dest });
    await downloadFile(client, cid, "/a", { host: "127.0.0.1", dest });
    expect(dest.writableEnded).toBe(false);
    expect(dest.destroyed).toBe(false);
    expect(Buffer.concat(chunks).toString()).toBe("01234567890123456789");
  });

  it("refuses a file over maxSize before reading it, and stops the transfer it negotiated", async () => {
    let dialled = false;
    const port = await transferPort(() => {
      dialled = true;
    });
    const { client, sent } = executor(negotiated(port, { size: "11" }), []);
    await expect(
      downloadFile(client, cid, "/a", { host: "127.0.0.1", maxSize: 10 }),
    ).rejects.toBeInstanceOf(FileTransferError);
    expect(dialled).toBe(false);
    expect(sent.map((r) => r.command)).toEqual(["ftinitdownload", "ftstop"]);
    expect(Object.fromEntries(sent[1]!.params ?? [])).toMatchObject({
      serverftfid: 9,
    });
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
