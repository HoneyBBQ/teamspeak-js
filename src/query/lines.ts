import { trimCarriageReturns } from "./trim.js";

/**
 * Splits a byte stream into the lines ServerQuery speaks.
 *
 * A line ends at `\n`. The server writes `\n\r`, so the `\r` belongs to the
 * start of the next line rather than the end of this one; both ends are
 * trimmed. Bytes are decoded as UTF-8 only once a whole line is in, so a
 * character split across two chunks arrives whole.
 */
export class LineReader {
  #pending = Buffer.alloc(0);

  /** Add a chunk and return the lines it completed, without their terminators. */
  push(chunk: Uint8Array): string[] {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const lines: string[] = [];
    for (;;) {
      const end = this.#pending.indexOf(0x0a);
      if (end < 0) break;
      const line = trimCarriageReturns(this.#pending.subarray(0, end).toString("utf8"));
      this.#pending = this.#pending.subarray(end + 1);
      lines.push(line);
    }
    return lines;
  }
}
