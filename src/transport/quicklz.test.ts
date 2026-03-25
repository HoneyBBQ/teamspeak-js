import { describe, it, expect } from "vitest";
import { Qlz } from "./quicklz.js";

describe("Qlz", () => {
  it("decompresses an uncompressed payload (flag bit 0 = 0)", () => {
    // Build a small "uncompressed" QuickLZ packet:
    // flags = 0x04 (level 1, not compressed, small header)
    // compressedSize = 3 (header only)
    // decompressedSize = 5
    const payload = new Uint8Array([0x04, 5, 5, 0x61, 0x62, 0x63, 0x64, 0x65]);
    const qlz = new Qlz();
    const result = qlz.decompress(payload);
    expect(result).toEqual(new Uint8Array([0x61, 0x62, 0x63, 0x64, 0x65]));
  });

  it("throws on unsupported level", () => {
    // level field is bits 3-2 of flags byte
    // level 2 = 0x08
    const bad = new Uint8Array([0x08, 0, 0]);
    expect(() => new Qlz().decompress(bad)).toThrow("only level 1");
  });

  it("throws on data too short", () => {
    expect(() => new Qlz().decompress(new Uint8Array([0x04]))).toThrow();
  });
});
