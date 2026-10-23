import { describe, expect, it } from "vitest";
import { listFilesRecursive } from "./files.js";
import { asChannelID } from "../command/ids.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import { ErrorCode } from "../errorcode.js";
import { ServerError } from "../errors.js";

type Row = Record<string, string>;
const dir = (name: string): Row => ({ name, size: "0", datetime: "1700000000", type: "0" });
const file = (name: string, size = 1): Row => ({
  name,
  size: String(size),
  datetime: "1700000000",
  type: "1",
});

/** A file area: what `ftgetfilelist` answers for each directory, and every call it was asked. */
function area(tree: Record<string, Row[]>) {
  const asked: Array<{ path: string; cpw: unknown; options: CommandOptions | undefined }> = [];
  const client: CommandExecutor = {
    send: async (request, options) => {
      const params = Object.fromEntries(request.params ?? []);
      asked.push({ path: String(params["path"]), cpw: params["cpw"], options });
      // The server reads a trailing slash as the directory itself.
      const rows = tree[String(params["path"]).replace(/(.)\/$/, "$1")];
      if (rows === undefined) throw new ServerError(2051, "file not found");
      // An empty directory is the server's "empty result set".
      if (rows.length === 0) throw new ServerError(ErrorCode.DatabaseEmptyResult, "empty");
      return rows;
    },
  };
  return { client, asked };
}

const cid = asChannelID(2n);

describe("listFilesRecursive", () => {
  const tree = {
    "/": [dir("docs"), file("root.txt", 5), dir("empty")],
    "/docs": [file("a.txt", 10), dir("deep")],
    "/docs/deep": [file("b.txt", 20)],
    "/empty": [],
  };

  it("lists every entry with its full path, a directory before what it holds", async () => {
    const { client } = area(tree);
    const entries = await listFilesRecursive(client, cid, "/");
    expect(entries.map((e) => [e.path, e.isDirectory, e.size])).toEqual([
      ["/docs", true, 0n],
      ["/docs/a.txt", false, 10n],
      ["/docs/deep", true, 0n],
      ["/docs/deep/b.txt", false, 20n],
      ["/root.txt", false, 5n],
      ["/empty", true, 0n],
    ]);
    // Everything listFiles reports stays on the entry.
    expect(entries[1]).toMatchObject({ name: "a.txt", modifiedAt: new Date(1_700_000_000_000) });
  });

  it("starts anywhere, with or without the leading and trailing slash", async () => {
    const { client } = area(tree);
    for (const start of ["/docs", "docs", "/docs/"]) {
      const entries = await listFilesRecursive(client, cid, start);
      expect(entries.map((e) => e.path)).toEqual(["/docs/a.txt", "/docs/deep", "/docs/deep/b.txt"]);
    }
  });

  it("goes down no further than maxDepth: a directory at the bound is listed, not entered", async () => {
    const { client, asked } = area(tree);
    expect(
      (await listFilesRecursive(client, cid, "/", { maxDepth: 1 })).map((e) => e.path),
    ).toEqual(["/docs", "/root.txt", "/empty"]);
    expect(asked.map((a) => a.path)).toEqual(["/"]);

    const two = await listFilesRecursive(client, cid, "/", { maxDepth: 2 });
    expect(two.map((e) => e.path)).toEqual([
      "/docs",
      "/docs/a.txt",
      "/docs/deep",
      "/root.txt",
      "/empty",
    ]);
  });

  it("sends the password and the signal to every listing, and nothing it keeps for itself", async () => {
    const { client, asked } = area(tree);
    const { signal } = new AbortController();
    await listFilesRecursive(client, cid, "/", {
      password: "pw",
      signal,
      timeoutMs: 9,
      maxDepth: 6,
    });
    expect(asked).toHaveLength(4);
    for (const call of asked) {
      expect(call.cpw).toBe("pw");
      expect(call.options).toEqual({ signal, timeoutMs: 9 });
    }
  });

  it("refuses a depth that is not a positive integer, and ends at the first error", async () => {
    const { client } = area(tree);
    for (const maxDepth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(listFilesRecursive(client, cid, "/", { maxDepth })).rejects.toThrow(RangeError);
    }
    await expect(listFilesRecursive(client, cid, "/missing")).rejects.toMatchObject({ code: 2051 });
  });

  it("returns none for an empty directory", async () => {
    const { client } = area(tree);
    expect(await listFilesRecursive(client, cid, "/empty")).toEqual([]);
  });
});
