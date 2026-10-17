import { describe, expect, it } from "vitest";
import {
  asAPIKeyID,
  asBanID,
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientFileTransferID,
  asClientID,
  asIconID,
  asMessageID,
  asPermissionID,
  asServerFileTransferID,
  asServerGroupID,
  asServerID,
  parseIconID,
} from "./ids.js";

describe("icon ids", () => {
  // The server sends an icon's CRC32 sometimes as a negative 32-bit number;
  // the icon file is named by the unsigned one, so both read the same.
  it("reads a signed and an unsigned id as the same unsigned value", () => {
    expect(parseIconID("-1528016466")).toBe(2766950830);
    expect(parseIconID("2766950830")).toBe(2766950830);
    expect(parseIconID(" 100 ")).toBe(100);
    expect(parseIconID("-1")).toBe(4294967295);
    expect(parseIconID("4294967295")).toBe(4294967295);
  });

  it("reads 0, garbage and out-of-range values as no icon", () => {
    for (const raw of [undefined, "", "0", "x", "1.5", "4294967296", "-2147483649"]) {
      expect(parseIconID(raw)).toBeUndefined();
    }
  });

  it("brands a signed value as its unsigned form", () => {
    expect(asIconID(-1528016466)).toBe(2766950830);
    expect(asIconID(2766950830)).toBe(2766950830);
  });
});

describe("id constructors", () => {
  const narrow = {
    asClientID: [asClientID, 0xffff],
    asClientFileTransferID: [asClientFileTransferID, 0xffff],
    asServerFileTransferID: [asServerFileTransferID, 0xffff],
    asPermissionID: [asPermissionID, 0xffff_ffff],
  } as const;
  const wide = {
    asChannelID,
    asClientDBID,
    asServerGroupID,
    asChannelGroupID,
    asAPIKeyID,
    asBanID,
    asMessageID,
    asServerID,
  } as const;

  // They used to brand whatever they were given: a fraction, a negative, a
  // clid no voice packet can carry.
  it.each(Object.entries(narrow))("%s takes integers in its wire width only", (_, [make, max]) => {
    expect(make(0)).toBe(0);
    expect(make(max)).toBe(max);
    for (const bad of [-1, max + 1, 1.5, Number.NaN, Infinity, "5" as unknown as number]) {
      expect(() => make(bad), String(bad)).toThrow(RangeError);
    }
  });

  it.each(Object.entries(wide))("%s takes integers from 0 to 2^64-1 only", (_, make) => {
    expect(make(0)).toBe(0n);
    expect(make(7)).toBe(7n);
    expect(make((1n << 64n) - 1n)).toBe((1n << 64n) - 1n);
    for (const bad of [-1, -1n, 1n << 64n, 1.5, Number.NaN, "5" as unknown as number]) {
      expect(() => make(bad), String(bad)).toThrow(RangeError);
    }
  });

  it("takes an icon id signed or unsigned, within 32 bits", () => {
    expect(asIconID(-1)).toBe(0xffff_ffff);
    for (const bad of [2 ** 32, -(2 ** 31) - 1, 0.5]) {
      expect(() => asIconID(bad), String(bad)).toThrow(RangeError);
    }
  });
});
