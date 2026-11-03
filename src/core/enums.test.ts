import { describe, expect, it } from "vitest";
import { BannerMode, BindingSubsystem, CodecEncryptionMode, VirtualServerStatus } from "./index.js";

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
