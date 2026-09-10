import { describe, expect, it } from "vitest";
import { isIpAddress, joinHostPort, splitHostPort } from "./address.js";

describe("TeamSpeak address helpers", () => {
  it("keeps bracketed IPv6 normalized when adding a port", () => {
    expect(splitHostPort("[2001:db8::1]:9987")).toEqual({ host: "2001:db8::1", port: "9987" });
    expect(joinHostPort("[2001:db8::1]", "9987")).toBe("[2001:db8::1]:9987");
    expect(isIpAddress("[2001:db8::1]")).toBe(true);
  });

  it("does not treat the final IPv6 segment as a port", () => {
    expect(splitHostPort("2001:db8::1")).toEqual({ host: "2001:db8::1", port: "9987" });
  });

  it("keeps ordinary host and port parsing unchanged", () => {
    expect(splitHostPort("voice.example.com:9988")).toEqual({
      host: "voice.example.com",
      port: "9988",
    });
    expect(joinHostPort("voice.example.com", "9988")).toBe("voice.example.com:9988");
  });
});
