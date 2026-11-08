import { describe, it, expect } from "vitest";
import { splitCommandRows, parseUint64, parseUint16, parseInt10 } from "./helpers.js";

describe("splitCommandRows", () => {
  it("returns single-element array for commands without pipe", () => {
    expect(splitCommandRows("error id=0 msg=ok")).toEqual(["error id=0 msg=ok"]);
  });

  it("expands pipe-separated rows", () => {
    const rows = splitCommandRows("clientlist clid=1 cid=5|clid=2 cid=6");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe("clientlist clid=1 cid=5");
    expect(rows[1]).toBe("clientlist clid=2 cid=6");
  });

  // TeamSpeak 6 6.0.0-beta13.1 answers a presign request of two rows with one
  // line of two rows, under a name with underscores.
  it("keeps a name with underscores on every row", () => {
    expect(
      splitCommandRows("notify_presigned_urls return_code=2 url=a key=\\/a|url=b key=\\/b"),
    ).toEqual([
      "notify_presigned_urls return_code=2 url=a key=\\/a",
      "notify_presigned_urls return_code=2 url=b key=\\/b",
    ]);
  });

  it("inherits omitted fields from the previous row", () => {
    const rows = splitCommandRows(
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=7 client_nickname=Alice|clid=8 client_nickname=Bob",
    );

    expect(rows).toEqual([
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=7 client_nickname=Alice",
      "notifycliententerview cfid=0 ctid=1 reasonid=2 clid=8 client_nickname=Bob",
    ]);
  });

  it("preserves explicitly changed fields and escaped values", () => {
    const rows = splitCommandRows(
      "clientlist cid=1 client_nickname=Alice\\sspeaker|cid=2 client_nickname=Bob\\pAdmin",
    );

    expect(rows).toEqual([
      "clientlist cid=1 client_nickname=Alice\\sspeaker",
      "clientlist cid=2 client_nickname=Bob\\pAdmin",
    ]);
  });

  // Response rows carry no name. Treating the first field as one copied it onto
  // every row, and a batch with no space in it was never split at all.
  it("splits a nameless batch without inventing a name", () => {
    expect(splitCommandRows("clid=1 cid=5|clid=2 cid=6")).toEqual(["clid=1 cid=5", "clid=2 cid=6"]);
  });

  it("splits one-field rows", () => {
    expect(splitCommandRows("cldbid=1|cldbid=2|cldbid=3")).toEqual([
      "cldbid=1",
      "cldbid=2",
      "cldbid=3",
    ]);
  });

  it("inherits omitted fields in nameless rows too", () => {
    expect(splitCommandRows("cid=1 name=a|name=b")).toEqual(["cid=1 name=a", "cid=1 name=b"]);
  });

  it("returns original for command with no space", () => {
    expect(splitCommandRows("ping")).toEqual(["ping"]);
  });

  // ctid is sent once, on the first row of a notifycliententerview batch, and
  // holds for the rows after it.
  it("gives every row of an enter batch the channel the first row named", () => {
    expect(splitCommandRows("notifycliententerview cfid=0 ctid=2 clid=10|clid=11|clid=12")).toEqual(
      [
        "notifycliententerview cfid=0 ctid=2 clid=10",
        "notifycliententerview cfid=0 ctid=2 clid=11",
        "notifycliententerview cfid=0 ctid=2 clid=12",
      ],
    );
  });

  // A value a row changes holds for the rows after it, until another changes it.
  it("carries a value a row changed to the next row", () => {
    expect(
      splitCommandRows(
        "notifycliententerview ctid=2 clid=10|ctid=5 clid=11|clid=12|clid=13 ctid=2",
      ),
    ).toEqual([
      "notifycliententerview ctid=2 clid=10",
      "notifycliententerview ctid=5 clid=11",
      "notifycliententerview ctid=5 clid=12",
      "notifycliententerview clid=13 ctid=2",
    ]);
  });

  // A field that first appears on a later row holds for the rows after it, as
  // any field the row before had does.
  it("carries a field first seen on a later row", () => {
    expect(splitCommandRows("notifycliententerview ctid=2 clid=10|clid=11 away=1|clid=12")).toEqual(
      [
        "notifycliententerview ctid=2 clid=10",
        "notifycliententerview ctid=2 clid=11 away=1",
        "notifycliententerview ctid=2 away=1 clid=12",
      ],
    );
  });

  // The first row of a permission list is a marker with a field of its own, and
  // the rows after it carry the fields that follow.
  it("carries fields across a marker row", () => {
    expect(
      splitCommandRows(
        "notifypermissionlist group_id_end=0|permname=a permdesc=x|permname=b|permdesc=y",
      ),
    ).toEqual([
      "notifypermissionlist group_id_end=0",
      "notifypermissionlist group_id_end=0 permname=a permdesc=x",
      "notifypermissionlist group_id_end=0 permdesc=x permname=b",
      "notifypermissionlist group_id_end=0 permname=b permdesc=y",
    ]);
  });

  /** The most the rows of a line of `n` characters may hold together. */
  const dropLimit = (n: number): number => Math.min(2 * Math.max(4 * n, 64 * 1024), 64 * n);
  const size = (rows: string[]): number => rows.reduce((sum, row) => sum + row.length, 0);

  // Rows with a key of their own each would inherit every key before them, and
  // the rows together would grow with the square of the line. They are held to
  // the budget, and the rows after it carry their own tokens only.
  it("holds the rows of distinct keys to the budget", () => {
    const count = 2000;
    const line = `notifyfoo ${Array.from({ length: count }, (_, i) => `k${i}=1`).join("|")}`;

    const rows = splitCommandRows(line);

    expect(rows).toHaveLength(count);
    expect(size(rows)).toBeLessThanOrEqual(dropLimit(line.length));
    expect(rows[2]).toBe("notifyfoo k0=1 k1=1 k2=1");
    expect(rows[count - 1]).toBe("notifyfoo k1999=1");
  });

  // A first row of many fields followed by many short rows would give rows of
  // the first row's size each; once the budget is passed they carry their own
  // tokens.
  it("stops inheriting once the rows pass the budget", () => {
    const first = Array.from({ length: 3000 }, (_, i) => `f${i}=1`).join(" ");
    const line = `notifyfoo ${first}${"|g=2".repeat(3000)}`;

    const rows = splitCommandRows(line);

    expect(rows).toHaveLength(3001);
    expect(size(rows)).toBeLessThanOrEqual(dropLimit(line.length));
    expect(rows[1]).toContain(" f2999=1");
    expect(rows[rows.length - 1]).toBe("notifyfoo g=2");
  });

  // The name is on every row, so a long name over many short rows grows the same
  // way, with nothing to stop inheriting; what does not fit is dropped.
  it("drops the rows past the budget", () => {
    const line = `n${"a".repeat(4000)} ${"a=1|".repeat(4000)}`;

    const rows = splitCommandRows(line);

    expect(size(rows)).toBeLessThanOrEqual(dropLimit(line.length));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(4000);
  });

  it("splits a row on the space alone", () => {
    for (const space of ["\t", "\u00a0", "\u0085", "\u3000", "\v"]) {
      const rows = splitCommandRows(
        `notifycliententerview clid=2 client_nickname=a${space}clid=1|clid=3`,
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toBe(`notifycliententerview clid=2 client_nickname=a${space}clid=1`);
    }
  });
});

describe("parse helpers", () => {
  it("parseUint64", () => {
    expect(parseUint64("12345")).toBe(12345n);
    expect(parseUint64("")).toBe(0n);
    expect(parseUint64("abc")).toBe(0n);
  });

  it("parseUint64 reads the whole range of 0 to 2^64-1", () => {
    expect(parseUint64("0")).toBe(0n);
    expect(parseUint64("18446744073709551615")).toBe(18446744073709551615n);
    expect(parseUint64("000000000000000000000000000000042")).toBe(42n);
  });

  it("parseUint64 reads anything but plain decimal digits as 0", () => {
    for (const s of [
      "-1",
      "-0",
      "+5",
      "0x10",
      "0b11",
      "0o7",
      "1e3",
      "1.5",
      " 5",
      "5 ",
      "5\n",
      "1_000",
      "\u0663",
      "18446744073709551616",
      "99999999999999999999999",
      "-18446744073709551616",
      "0x1ffffffffffffffff",
      "9".repeat(100_000),
    ]) {
      expect(parseUint64(s), JSON.stringify(s.slice(0, 30))).toBe(0n);
    }
  });

  it("parseUint16", () => {
    expect(parseUint16("65535")).toBe(65535);
    expect(parseUint16("0")).toBe(0);
    expect(parseUint16("abc")).toBe(0);
  });

  it("parseInt10", () => {
    expect(parseInt10("42")).toBe(42);
    expect(parseInt10("-5")).toBe(-5);
    expect(parseInt10("x")).toBe(0);
  });
});
