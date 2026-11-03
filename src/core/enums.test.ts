import { describe, expect, it } from "vitest";
import {
  BannerMode,
  BindingSubsystem,
  ClientStatus,
  CodecEncryptionMode,
  ErrorCode,
  VirtualServerStatus,
  isValueOf,
} from "./index.js";

describe("value tables", () => {
  it("are frozen and hold the values the servers use", () => {
    expect(Object.isFrozen(BannerMode)).toBe(true);
    expect(BannerMode).toEqual({ NoAdjust: 0, AdjustIgnoreAspect: 1, AdjustKeepAspect: 2 });

    expect(Object.isFrozen(CodecEncryptionMode)).toBe(true);
    expect(CodecEncryptionMode).toEqual({ PerChannel: 0, ForcedOff: 1, ForcedOn: 2 });

    expect(Object.isFrozen(VirtualServerStatus)).toBe(true);
    expect(VirtualServerStatus).toEqual({
      Online: "online",
      Offline: "offline",
      OnlineVirtual: "online virtual",
      BootingUp: "booting up",
      ShuttingDown: "shutting down",
    });

    expect(Object.isFrozen(BindingSubsystem)).toBe(true);
    expect(BindingSubsystem).toEqual({
      Voice: "voice",
      Query: "query",
      FileTransfer: "filetransfer",
    });
  });
});

describe("isValueOf", () => {
  it("is true for exactly the table's values", () => {
    expect([0, 1, 2].every((v) => isValueOf(BannerMode, v))).toBe(true);
    expect(isValueOf(BannerMode, 3)).toBe(false);
    expect(isValueOf(BindingSubsystem, "query")).toBe(true);
    expect(isValueOf(ClientStatus, "connected")).toBe(true);
    expect(isValueOf(ErrorCode, ErrorCode.OK)).toBe(true);
  });

  it("does not convert: text is not a number, and a member's name is not its value", () => {
    expect(isValueOf(BannerMode, "2")).toBe(false);
    expect(isValueOf(BannerMode, "AdjustKeepAspect")).toBe(false);
    expect(isValueOf(VirtualServerStatus, "virtual online")).toBe(false);
  });

  it("is false for anything that is not a value", () => {
    for (const v of [undefined, null, NaN, {}, [], 2n, true]) {
      expect(isValueOf(BannerMode, v)).toBe(false);
    }
  });
});
