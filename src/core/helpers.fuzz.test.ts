import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCommand, isCommandName } from "./command/parser.js";
import { parseInt10, parseUint16, parseUint64, splitCommandRows } from "./helpers.js";

// Property tests over what the voice protocol sends in a batch: one line with
// several rows, separated by pipes. Its input comes from the network, and a
// server answering a clientlist or channellist sends exactly this.

/** A key a batch repeats from row to row, so that rows override one another. */
const key = fc.constantFrom("clid", "cid", "ctid", "client_nickname", "msg", "-away", "x");

/** An escaped value, as the server writes one: no raw space, pipe or control byte. */
const value = fc.stringMatching(/^([A-Za-z0-9=_.,:-]|\\s|\\p|\\\\|\\\/){0,12}$/);

const token = fc.oneof(
  fc.tuple(key, value).map(([k, v]) => `${k}=${v}`),
  key,
);

const row = fc.array(token, { minLength: 0, maxLength: 6 }).map((tokens) => tokens.join(" "));

/** A named, batched line. */
const batch = fc
  .tuple(fc.stringMatching(/^[A-Za-z0-9]{1,16}$/), fc.array(row, { minLength: 2, maxLength: 8 }))
  .map(([name, rows]) => ({ name, rows, line: `${name} ${rows.join("|")}` }));

describe("splitting a batched line into rows", () => {
  it("takes any line without throwing, and makes one row per part at most", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 400 }), (line) => {
        const rows = splitCommandRows(line);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.length).toBeLessThanOrEqual(line.split("|").length);
        for (const r of rows) parseCommand(r);
      }),
      { numRuns: 1000 },
    );
  });

  it("keeps the name on every row of a named line", () => {
    fc.assert(
      fc.property(batch, ({ name, line }) => {
        for (const r of splitCommandRows(line)) {
          expect(r.startsWith(`${name} `) || r === name).toBe(true);
          expect(parseCommand(r)?.name).toBe(name);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("gives each row every parameter its own part carried, with that part's value", () => {
    fc.assert(
      fc.property(batch, ({ name, rows, line }) => {
        const split = splitCommandRows(line);
        const parts = rows.filter((part) => part !== "");
        // A part with only a space or nothing is a row without parameters of
        // its own; the rows it inherits from the one before still come out.
        expect(split.length).toBe(parts.length === 0 ? 1 : parts.length);
        parts.forEach((part, i) => {
          const own = parseCommand(`${name} ${part}`)?.params ?? {};
          const got = parseCommand(split[i]!)?.params ?? {};
          for (const [k, v] of Object.entries(own)) expect(got[k]).toBe(v);
        });
      }),
      { numRuns: 1000 },
    );
  });

  it("takes a value holding a space-like character as one value", () => {
    // U+00A0, U+3000 and U+0085 are not separators in this format: only the
    // ASCII space is, and the server sends them unescaped.
    for (const c of ["\u00a0", "\u3000", "\u0085", "\u2003"]) {
      const rows = splitCommandRows(`cid=1 channel_name=a${c}b|cid=2 channel_name=x`);
      expect(parseCommand(rows[0]!)?.params["channel_name"]).toBe(`a${c}b`);
    }
  });

  // The rows of a batch inherit the fields a row leaves out, so a row that
  // names a new key each time must not carry every key before it: a line of n
  // rows would become n squared fields, and a server sending 1 MiB that way
  // would make the client hold gigabytes.
  it("keeps all the rows of a line within a fixed multiple of its size", () => {
    const line = `notifyfoo ${Array.from({ length: 200 }, (_, i) => `k${i}=1`).join("|")}`;
    const total = splitCommandRows(line).reduce((sum, r) => sum + r.length, 0);
    expect(total).toBeLessThanOrEqual(64 * line.length + 4096);
  });
});

describe("reading numbers off the wire", () => {
  it("reads a 16-bit id as an integer from 0 to 65535, and anything else as 0", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        const n = parseUint16(s);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(65535);
      }),
      { numRuns: 2000 },
    );
  });

  it("reads a signed decimal as an integer, and garbage as 0", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (s) => {
        expect(Number.isFinite(parseInt10(s))).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("reads a decimal 64-bit id as itself", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (n) => {
        expect(parseUint64(String(n))).toBe(n);
      }),
      { numRuns: 1000 },
    );
  });

  // The Go SDK, and the typed commands here, read a value outside 0 to 2^64-1
  // as 0. BigInt() takes a sign, a hex prefix and any width, so these would come
  // out as a negative or a 65-bit "unsigned id", which the id constructors
  // refuse with a RangeError where the notification handlers call them.
  it("reads a value outside 0 to 2^64-1 as 0", () => {
    for (const s of [
      "-1",
      "-18446744073709551616",
      "18446744073709551616",
      "0x1ffffffffffffffff",
    ]) {
      expect(parseUint64(s)).toBe(0n);
    }
  });

  it("names a command as a run of ASCII letters, digits and underscores", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 20 }), (s) => {
        expect(isCommandName(s)).toBe(/^[A-Za-z0-9_]+$/.test(s) && s.length > 0);
      }),
      { numRuns: 1000 },
    );
  });
});
