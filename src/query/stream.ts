import { LineReader } from "./lines.js";
import type { QueryTransport } from "./transport.js";

/**
 * The part of a duplex byte stream a line transport uses. A `node:net` socket
 * is one; so is an SSH shell channel, or a test double.
 */
export interface QueryStream {
  /** Write bytes to the peer; `callback` runs once they are flushed, with the failure if any. */
  write(data: string, callback: (error?: Error | null) => void): unknown;
  /** Close the stream. */
  end(): unknown;
  /** Listen for each chunk received. */
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  /** Listen for a failure, which ends the connection. */
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Listen for the stream closing. */
  on(event: "close", listener: () => void): unknown;
}

/** How long `close()` waits for the server to end the session after `quit`. */
const QUIT_WAIT_MS = 1_000;

/**
 * A {@link QueryTransport} over a byte stream: raw TCP, or an SSH shell.
 *
 * Both greet with a two-line banner, `TS3` and a welcome sentence, before any
 * answer. It is skipped, so the client sees only answers and notifications.
 */
export class StreamTransport implements QueryTransport {
  /** A raw TCP connection and an SSH session both carry pushed notifications. */
  readonly supportsNotifications = true;
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;

  #stream: QueryStream;
  #reader = new LineReader();
  #onEnd: (() => void) | undefined;
  /** How many of the two banner lines are still to come. */
  #banner = 2;
  #closing = false;
  #ended = false;
  /** Wakes a `close()` that is waiting for the server to end the session. */
  #onEnded: (() => void) | undefined;
  #error: Error | undefined;

  /**
   * `onEnd` runs once the stream is closed, to release what the stream sits
   * on: an SSH session's connection, say.
   */
  constructor(stream: QueryStream, onEnd?: () => void) {
    this.#stream = stream;
    this.#onEnd = onEnd;
    stream.on("data", (chunk) => this.#handleData(chunk));
    stream.on("error", (error) => {
      this.#error = error;
    });
    stream.on("close", () => this.#handleClose());
  }

  send(line: string): Promise<void> {
    if (this.#ended) return Promise.reject(new Error("the query connection is closed"));
    return new Promise((resolve, reject) => {
      this.#stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Say `quit`, give the server a moment to end the session, and close.
   *
   * Ending the connection without it is not always noticed: a TeamSpeak 3
   * server can keep an SSH session, and its slot among the few each address
   * gets, long after the client has gone. `quit` is the command that ends a
   * session, and the server answers it by closing the stream.
   */
  async close(): Promise<void> {
    if (this.#ended) return;
    this.#closing = true;
    // Whatever the server still says, it is no longer anyone's answer.
    this.onLine = null;
    const closed = new Promise<void>((resolve) => {
      this.#onEnded = resolve;
    });
    const said = await this.send("quit").then(
      () => true,
      () => false,
    );
    if (said) {
      let timer: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_WAIT_MS);
      });
      await Promise.race([closed, patience]);
      clearTimeout(timer);
    }
    if (this.#ended) return;
    // Ending the stream is not enough to hear it close. An SSH session channel
    // is half-open, so `end()` sends EOF and stops there without reporting
    // 'close', and the hook that releases the connection underneath would never
    // run; the close is owed here as well as from the stream's own event.
    this.#stream.end();
    this.#handleClose();
  }

  #handleData(chunk: Uint8Array): void {
    for (const line of this.#reader.push(chunk)) {
      if (this.#banner > 0) {
        this.#banner--;
        continue;
      }
      this.onLine?.(line);
    }
  }

  #handleClose(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#onEnded?.();
    this.#onEnd?.();
    this.onClose?.(this.#closing ? undefined : this.#error);
  }
}
