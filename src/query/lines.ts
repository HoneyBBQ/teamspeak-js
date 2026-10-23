import { LineTooLongError } from "./errors.js";
import { trimCarriageReturns } from "./trim.js";

/**
 * The longest line a connection reads, in bytes: 256 MiB. A line is a whole
 * answer, and a client database listing is about 240 bytes a client, so this
 * holds about a million of them; the permission list, the longest answer
 * measured on TeamSpeak 3 and 6, is under 50 KiB. See {@link LineTooLongError}.
 */
export const MAX_LINE_BYTES: number = 256 * 1024 * 1024;

/**
 * Splits a byte stream into the lines ServerQuery speaks.
 *
 * A line ends at `\n`. The server writes `\n\r`, so the `\r` belongs to the
 * start of the next line rather than the end of this one; both ends are
 * trimmed. Bytes are decoded as UTF-8 only once a whole line is in, so a
 * character split across two chunks arrives whole.
 *
 * Each byte is looked at once, however many chunks a line arrives in. A line
 * past the limit throws {@link LineTooLongError}.
 */
export class LineReader {
  /** The chunks of the line still being read; none holds a newline. */
  #parts: Uint8Array[] = [];
  #length = 0;
  readonly #limit: number;

  constructor(limit: number = MAX_LINE_BYTES) {
    this.#limit = limit;
  }

  /** Add a chunk and return the lines it completed, without their terminators. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const end = Buffer.prototype.indexOf.call(chunk, 0x0a, start) as number;
      if (end < 0) break;
      this.#add(chunk.subarray(start, end));
      lines.push(trimCarriageReturns(Buffer.concat(this.#parts, this.#length).toString("utf8")));
      this.#parts = [];
      this.#length = 0;
      start = end + 1;
    }
    this.#add(chunk.subarray(start));
    return lines;
  }

  #add(part: Uint8Array): void {
    this.#length += part.byteLength;
    if (this.#length > this.#limit) {
      this.#parts = [];
      this.#length = 0;
      throw new LineTooLongError(this.#limit);
    }
    if (part.byteLength > 0) this.#parts.push(part);
  }
}
