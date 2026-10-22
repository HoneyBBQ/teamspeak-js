import { describe, expect, it } from "vitest";
import { trimCarriageReturns, trimTrailingSlashes } from "./trim.js";

describe("trimTrailingSlashes", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["////", ""],
    ["http://h", "http://h"],
    ["http://h/", "http://h"],
    ["http://h//", "http://h"],
    ["http://h/a/b//", "http://h/a/b"],
    ["/a", "/a"],
  ])("%j -> %j", (input, want) => {
    expect(trimTrailingSlashes(input)).toBe(want);
  });

  it("takes linear time on a long run that does not end the string", () => {
    const started = performance.now();
    expect(trimTrailingSlashes("/".repeat(100_000) + "x")).toBe("/".repeat(100_000) + "x");
    expect(trimTrailingSlashes("x" + "/".repeat(100_000))).toBe("x");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("trimCarriageReturns", () => {
  it.each([
    ["", ""],
    ["\r", ""],
    ["\r\r\r", ""],
    ["line", "line"],
    ["\rline", "line"],
    ["line\r", "line"],
    ["\r\rline\r\r", "line"],
    ["a\rb", "a\rb"],
    ["\r a \r", " a "],
  ])("%j -> %j", (input, want) => {
    expect(trimCarriageReturns(input)).toBe(want);
  });

  it("takes linear time on a long run of carriage returns", () => {
    const started = performance.now();
    expect(trimCarriageReturns("\r".repeat(100_000) + "x")).toBe("x");
    expect(trimCarriageReturns("x" + "\r".repeat(100_000) + "x")).toBe(
      "x" + "\r".repeat(100_000) + "x",
    );
    expect(trimCarriageReturns("\r".repeat(100_000))).toBe("");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
