import { describe, expect, expectTypeOf, it } from "vitest";
import { FileTransferStage, UIDAlgorithm, ViewStatus } from "./index.js";

describe("UIDAlgorithm", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(UIDAlgorithm)).toBe(true);
    expectTypeOf<UIDAlgorithm>().toEqualTypeOf<"sha1" | "sha256">();
  });
});

describe("ViewStatus", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(ViewStatus)).toBe(true);
    expectTypeOf<ViewStatus>().toEqualTypeOf<"empty" | "loading" | "live" | "stale">();
  });
});

describe("FileTransferStage", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(FileTransferStage)).toBe(true);
    expectTypeOf<FileTransferStage>().toEqualTypeOf<"dial" | "transfer">();
  });
});
