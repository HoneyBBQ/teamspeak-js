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
});
