import { describe, it, expect } from "vitest";
import { escape, unescape, buildCommand, buildCommandOrdered } from "./command.js";
import { parseCommand } from "./parser.js";

describe("escape / unescape", () => {
  it("escapes spaces and pipes", () => {
    expect(escape("hello world")).toBe("hello\\sworld");
    expect(escape("a|b")).toBe("a\\pb");
  });

  it("escapes backslash first", () => {
    expect(escape("a\\b")).toBe("a\\\\b");
  });

  it("escapes slashes", () => {
    expect(escape("a/b")).toBe("a\\/b");
  });

  it("round-trips arbitrary strings", () => {
    const samples = [
      "hello world",
      "pipe|test",
      "back\\slash",
      "new\nline",
      "tab\there",
      "mix /|\\  \n",
    ];
    for (const s of samples) {
      expect(unescape(escape(s))).toBe(s);
    }
  });
});

describe("buildCommand", () => {
  it("produces name with escaped key=value pairs", () => {
    const result = buildCommand("sendtextmessage", { msg: "hello world" });
    expect(result).toContain("sendtextmessage");
    expect(result).toContain("msg=hello\\sworld");
  });
});

describe("buildCommandOrdered", () => {
  it("preserves parameter order", () => {
    const result = buildCommandOrdered("clientmove", [
      ["clid", "1"],
      ["cid", "5"],
    ]);
    expect(result).toBe("clientmove clid=1 cid=5");
  });
});

describe("parseCommand", () => {
  it("parses a simple command", () => {
    const cmd = parseCommand("error id=0 msg=ok return_code=1");
    expect(cmd?.name).toBe("error");
    expect(cmd?.params["id"]).toBe("0");
    expect(cmd?.params["msg"]).toBe("ok");
    expect(cmd?.params["return_code"]).toBe("1");
  });

  it("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull();
  });

  it("handles flag-style params (no value)", () => {
    const cmd = parseCommand("clientlist -uid -groups");
    expect(cmd?.name).toBe("clientlist");
    expect(cmd?.params["-uid"]).toBe("");
    expect(cmd?.params["-groups"]).toBe("");
  });

  it("unescapes values", () => {
    const cmd = parseCommand("sendtextmessage msg=hello\\sworld");
    expect(cmd?.params["msg"]).toBe("hello world");
  });

  it("skips leading non-printable bytes", () => {
    const cmd = parseCommand("\x01\x02error id=0 msg=ok");
    expect(cmd?.name).toBe("error");
  });

  // The server never echoes the command name on a response row, so a data line
  // has no name at all. Getting this wrong silently dropped the row's first
  // field — clientlist arrived as name="clid=6" and every column shifted.
  it("treats a response row as nameless data, keeping its first field", () => {
    const cmd = parseCommand("clid=10 cid=2 client_database_id=10 client_nickname=raw-probe1");
    expect(cmd?.name).toBe("");
    expect(cmd?.params["clid"]).toBe("10");
    expect(cmd?.params["cid"]).toBe("2");
    expect(cmd?.params["client_nickname"]).toBe("raw-probe1");
  });

  it("keeps the first field of every row in a batched response", () => {
    const rows = [
      ["cid=1 pid=0 channel_order=0 channel_name=Default\\sChannel", "1", "0"],
      ["cid=2 pid=0 channel_order=1 channel_name=Alpha", "2", "1"],
    ];
    for (const [row, cid, order] of rows) {
      const cmd = parseCommand(row!);
      expect(cmd?.name).toBe("");
      expect(cmd?.params["cid"]).toBe(cid);
      expect(cmd?.params["channel_order"]).toBe(order);
    }
  });

  it("treats negative feedback as data, not as a command named '-1'", () => {
    // "-<cmdId> <error>" names the command that was rejected; the line itself
    // is not a command.
    const cmd = parseCommand("-1 id=2 msg=bad\\scommand");
    expect(cmd?.name).toBe("");
    expect(cmd?.params["id"]).toBe("2");
    expect(cmd?.params["msg"]).toBe("bad command");
  });

  it("reads a TeamSpeak 6 name with underscores", () => {
    // Measured on TeamSpeak 6 6.0.0-beta13.1: the answer to s3ft_getpresignedurl.
    const cmd = parseCommand(
      "notify_presigned_urls return_code=2 url=https:\\/\\/b.s3\\/k key=\\/k",
    );
    expect(cmd?.name).toBe("notify_presigned_urls");
    expect(cmd?.params["url"]).toBe("https://b.s3/k");
    expect(cmd?.params["key"]).toBe("/k");
    const empty = parseCommand("notify_s3ft_file_list b64_json return_code=3");
    expect(empty?.name).toBe("notify_s3ft_file_list");
    expect(empty?.params["b64_json"]).toBe("");
  });

  it("still reads a real command name", () => {
    const cmd = parseCommand("clientlist -uid -away");
    expect(cmd?.name).toBe("clientlist");
    expect(cmd?.params["-uid"]).toBe("");
    expect(cmd?.params["-away"]).toBe("");
  });

  it("keeps a response that happens to carry a parameter name", () => {
    // A row's first field must not be mistaken for a command name just because
    // it is bare alphanumerics with no '='.
    const cmd = parseCommand("clientlistfinished");
    expect(cmd?.name).toBe("clientlistfinished");
    const err = parseCommand("error id=0 msg=ok");
    expect(err?.name).toBe("error");
    expect(err?.params["id"]).toBe("0");
  });
});

describe("buildCommand keys", () => {
  it("escapes keys as well as values, so a key cannot inject a parameter", () => {
    expect(buildCommand("x", { "a b=c": "1" })).toBe("x a\\sb=c=1");
    expect(buildCommandOrdered("x", [["a|b", "2"]])).toBe("x a\\pb=2");
  });
});
