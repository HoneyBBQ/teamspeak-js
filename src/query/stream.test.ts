import { createServer } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { LineReader } from "./lines.js";
import { StreamTransport, type QueryStream } from "./stream.js";
import { connectTcp } from "./tcp.js";
import { QueryClient } from "./client.js";

/** A stream that records what is written and lets the test feed it. */
class FakeStream implements QueryStream {
  written: string[] = [];
  ended = false;
  /** Whether the "server" ends the session when it is told to quit. */
  answersQuit = true;
  /** Fail every write, as a stream that is already gone does. */
  failWrites = false;
  #listeners: {
    data: Array<(chunk: Uint8Array) => void>;
    error: Array<(e: Error) => void>;
    close: Array<() => void>;
  } = { data: [], error: [], close: [] };

  write(data: string, callback: (error?: Error | null) => void): void {
    if (this.failWrites) {
      callback(new Error("write after end"));
      return;
    }
    this.written.push(data);
    callback();
    if (data === "quit\n" && this.answersQuit) queueMicrotask(() => this.emitClose());
  }
  end(): void {
    this.ended = true;
    this.emitClose();
  }
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "data" | "error" | "close", listener: never): unknown {
    (this.#listeners[event] as unknown[]).push(listener);
    return this;
  }
  emitData(text: string): void {
    for (const l of this.#listeners.data) l(Buffer.from(text));
  }
  emitError(error: Error): void {
    for (const l of this.#listeners.error) l(error);
  }
  emitClose(): void {
    for (const l of this.#listeners.close) l();
  }
}

const BANNER =
  'TS3\n\rWelcome to the TeamSpeak 3 ServerQuery interface, type "help" for a list.\n\r';

describe("LineReader", () => {
  it("trims the \\r the server puts after \\n, and keeps a partial line for the next chunk", () => {
    const reader = new LineReader();
    expect(reader.push(Buffer.from("a=1\n\rerror id=0 msg=o"))).toEqual(["a=1"]);
    expect(reader.push(Buffer.from("k\n\r"))).toEqual(["error id=0 msg=ok"]);
  });

  it("reads a character split across two chunks whole", () => {
    const reader = new LineReader();
    const bytes = Buffer.from("name=é\n");
    expect(reader.push(bytes.subarray(0, 6))).toEqual([]);
    expect(reader.push(bytes.subarray(6))).toEqual(["name=é"]);
  });

  it("accepts \\r\\n as well", () => {
    expect(new LineReader().push(Buffer.from("a\r\nb\r\n"))).toEqual(["a", "b"]);
  });
});

describe("StreamTransport", () => {
  it("drops the two banner lines and delivers the rest", () => {
    const stream = new FakeStream();
    const transport = new StreamTransport(stream);
    const lines: string[] = [];
    transport.onLine = (l) => lines.push(l);

    stream.emitData(BANNER.slice(0, 20));
    stream.emitData(BANNER.slice(20) + "error id=0 msg=ok\n\r");

    expect(lines).toEqual(["error id=0 msg=ok"]);
  });

  it("sends a line with its terminator", async () => {
    const stream = new FakeStream();
    const transport = new StreamTransport(stream);
    await transport.send("whoami");
    expect(stream.written).toEqual(["whoami\n"]);
  });

  it("reports a failure with the close, and nothing for close()", async () => {
    const failing = new FakeStream();
    const first = new StreamTransport(failing);
    const seen: Array<Error | undefined> = [];
    first.onClose = (e) => seen.push(e);
    failing.emitError(new Error("reset"));
    failing.emitClose();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe("reset");

    const quiet = new FakeStream();
    const second = new StreamTransport(quiet);
    second.onClose = (e) => seen.push(e);
    await second.close();
    expect(quiet.written).toEqual(["quit\n"]);
    expect(seen[1]).toBeUndefined();
    await expect(second.send("x")).rejects.toThrow("closed");
  });

  // A TeamSpeak 3 server can keep an SSH session whose client simply went
  // away, so the session is ended the way the protocol says to.
  it("says quit and lets the server end the session before it closes", async () => {
    const stream = new FakeStream();
    let released = 0;
    const lines: string[] = [];
    const transport = new StreamTransport(stream, () => released++);
    transport.onLine = (line) => lines.push(line);
    const closed: Array<Error | undefined> = [];
    transport.onClose = (error) => closed.push(error);

    await transport.close();

    expect(stream.written).toEqual(["quit\n"]);
    // The server's own close ended it: the stream was not also ended by hand.
    expect(stream.ended).toBe(false);
    expect(released).toBe(1);
    expect(closed).toEqual([undefined]);
  });

  it("hands the client nothing the server says after quit", async () => {
    const stream = new FakeStream();
    stream.answersQuit = false;
    const lines: string[] = [];
    const transport = new StreamTransport(stream);
    transport.onLine = (line) => lines.push(line);
    stream.emitData(BANNER);

    const closing = transport.close();
    stream.emitData("error id=0 msg=ok\n\r");
    stream.emitClose();
    await closing;

    expect(lines).toEqual([]);
  });

  it("closes without waiting when quit cannot be written", async () => {
    const stream = new FakeStream();
    stream.failWrites = true;
    let released = 0;
    const transport = new StreamTransport(stream, () => released++);

    await transport.close();

    expect(stream.ended).toBe(true);
    expect(released).toBe(1);
  });

  it("runs the release hook once the stream is closed", async () => {
    const stream = new FakeStream();
    let released = 0;
    const transport = new StreamTransport(stream, () => released++);
    await transport.close();
    stream.emitClose();
    expect(released).toBe(1);
  });

  // An SSH session channel is half-open: `end()` sends EOF and reports no
  // 'close', so a transport that only released on that event left the
  // connection underneath open and the process unable to exit.
  it("releases what it sits on when the stream ends without reporting it", async () => {
    const stream = new FakeStream();
    // The stream is ended but stays silent, as an SSH channel does, and the
    // server never answers `quit`.
    stream.answersQuit = false;
    stream.end = () => {
      stream.ended = true;
    };
    let released = 0;
    const closed: Array<Error | undefined> = [];
    const transport = new StreamTransport(stream, () => released++);
    transport.onClose = (error) => closed.push(error);

    vi.useFakeTimers();
    try {
      const closing = transport.close();
      await vi.advanceTimersByTimeAsync(1_500);
      await closing;
    } finally {
      vi.useRealTimers();
    }

    expect(stream.ended).toBe(true);
    expect(released).toBe(1);
    // A close() the caller asked for reports no failure, and a command sent
    // afterwards is refused rather than written to a stream that is gone.
    expect(closed).toEqual([undefined]);
    await expect(transport.send("x")).rejects.toThrow("closed");
  });

  it("still releases once when the stream reports the close as well", async () => {
    const stream = new FakeStream();
    let released = 0;
    const closed: Array<Error | undefined> = [];
    const transport = new StreamTransport(stream, () => released++);
    transport.onClose = (error) => closed.push(error);

    await transport.close();
    // The stream's own 'close' arriving afterwards is not a second close.
    stream.emitClose();

    expect(released).toBe(1);
    expect(closed).toEqual([undefined]);
  });

  it("reports the close as deliberate when the caller asks for it after a failure", async () => {
    const stream = new FakeStream();
    let released = 0;
    const closed: Array<Error | undefined> = [];
    const transport = new StreamTransport(stream, () => released++);
    transport.onClose = (error) => closed.push(error);

    // The connection failed, and the caller closes it anyway on the way out:
    // the close is theirs, so it is reported as deliberate and once.
    stream.emitError(new Error("reset"));
    await transport.close();
    stream.emitClose();

    expect(released).toBe(1);
    expect(closed).toEqual([undefined]);
  });
});

describe("connectTcp", () => {
  it("talks to a server over a socket, banner and all", async () => {
    const server = createServer((socket) => {
      socket.write(BANNER);
      socket.on("data", (data) => {
        if (data.toString().startsWith("version")) {
          socket.write("version=3.13.8 build=1 platform=Linux\n\rerror id=0 msg=ok\n\r");
        } else if (data.toString().startsWith("clientlist")) {
          socket.write("error id=1281 msg=database\\sempty\\sresult\\sset\n\r");
        } else if (data.toString().startsWith("servernotifyregister")) {
          socket.write("error id=0 msg=ok\n\r");
        } else if (data.toString().startsWith("whoami")) {
          socket.write("client_id=1 client_nickname=serveradmin\n\rerror id=0 msg=ok\n\r");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const client = new QueryClient({
        transport: { kind: "custom", open: () => connectTcp({ host: "127.0.0.1", port }) },
      });
      await client.connect();
      expect(await client.exec("whoami")).toEqual([
        { client_id: "1", client_nickname: "serveradmin" },
      ]);
      await client.disconnect();
    } finally {
      server.close();
    }
  });

  it("rejects when nothing listens", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    server.close();
    await once(server, "close");
    await expect(connectTcp({ host: "127.0.0.1", port })).rejects.toThrow();
  });
});
