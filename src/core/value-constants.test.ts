import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ConnectionTrafficClass,
  ServerExtension,
  ServerFamily,
  serverFamilyForVersion,
} from "./index.js";

describe("ServerFamily", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(ServerFamily)).toBe(true);
    expectTypeOf<ServerFamily>().toEqualTypeOf<"ts3" | "ts6" | "unknown">();
  });

  it("is what serverFamilyForVersion returns", () => {
    expect(serverFamilyForVersion("3.13.8 [Build: 1]")).toBe(ServerFamily.TS3);
    expect(serverFamilyForVersion("6.0.0-beta13.1")).toBe(ServerFamily.TS6);
    expect(serverFamilyForVersion("")).toBe(ServerFamily.Unknown);
  });
});

describe("ServerExtension", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(ServerExtension)).toBe(true);
    expectTypeOf<ServerExtension>().toEqualTypeOf<"FILETIME" | "STREAM_P2P" | "s3">();
  });
});

describe("ConnectionTrafficClass", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(ConnectionTrafficClass)).toBe(true);
    expectTypeOf<ConnectionTrafficClass>().toEqualTypeOf<"speech" | "keepalive" | "control">();
  });
});
