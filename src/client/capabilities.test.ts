import { describe, it, expect } from "vitest";
import { HostMessageMode } from "@honeybbq/teamspeak";
import { serverFamilyForVersion } from "@honeybbq/teamspeak";
import { MAX_SECURITY_LEVEL, uidAlgorithmForVersion } from "./index.js";
import { parseServerCapabilities, unknownServerCapabilities } from "./capabilities.js";

describe("parseServerCapabilities", () => {
  it("identifies TS3 and the SHA-1 uid hash it uses", () => {
    const caps = parseServerCapabilities("3.13.8 [Build: 1779874471]");
    expect(caps.family).toBe("ts3");
    expect(caps.major).toBe(3);
    expect(caps.uidAlgorithm).toBe("sha1");
    expect(caps.version).toBe("3.13.8 [Build: 1779874471]");
  });

  it("identifies TS6 and the SHA-256 uid hash it uses", () => {
    const caps = parseServerCapabilities("6.0.0-beta13.1 [Build: 1790080330]");
    expect(caps.family).toBe("ts6");
    expect(caps.major).toBe(6);
    expect(caps.uidAlgorithm).toBe("sha256");
  });

  // The uid hash is the reason this type exists: reading the family is only
  // useful if it agrees with the hash the server actually applies.
  it("agrees with the uid algorithm the server uses", () => {
    for (const [version, algorithm] of [
      ["3.13.8", "sha1"],
      ["3.0.11", "sha1"],
      ["6.0.0-beta13.1", "sha256"],
      ["6.1.0", "sha256"],
      ["7.0.0", "sha256"],
    ] as const) {
      expect(parseServerCapabilities(version).uidAlgorithm).toBe(algorithm);
    }
  });

  it("treats an unparseable version as unknown rather than throwing", () => {
    for (const version of ["", "unknown", "beta"]) {
      const caps = parseServerCapabilities(version);
      expect(caps.family).toBe("unknown");
      expect(caps.major).toBe(0);
      // Stays SHA-1, the protocol's original assumption, so an unrecognised
      // server behaves exactly as it did before TS6 support existed.
      expect(caps.uidAlgorithm).toBe("sha1");
    }
  });

  it("does not mistake a TS4 or TS5 version for TS3", () => {
    // TeamSpeak never shipped a server for these, but a version string should
    // not silently be read as the older generation.
    expect(parseServerCapabilities("4.0.0").family).toBe("unknown");
    expect(parseServerCapabilities("5.0.0").family).toBe("unknown");
  });

  // After EchoSixHIYA/teamspeak-js (0979775, 956d29c, by illusia).
  it("reads the welcome message from initserver", () => {
    const caps = parseServerCapabilities({
      virtualserver_version: "3.13.8 [Build: 1779874471]",
      virtualserver_welcomemessage: "Welcome!",
    });
    expect(caps.family).toBe("ts3");
    expect(caps.welcomeMessage).toBe("Welcome!");
  });

  it("reads the extensions in the server's order, each once, without blanks", () => {
    // As TeamSpeak 6 6.0.0-beta13.1 and TeamSpeak 3 3.13 send them.
    expect(
      parseServerCapabilities({ virtualserver_capability_extensions: "FILETIME,STREAM_P2P" })
        .extensions,
    ).toEqual(["FILETIME", "STREAM_P2P"]);
    expect(parseServerCapabilities({ virtualserver_capability_extensions: "" }).extensions).toEqual(
      [],
    );
    expect(parseServerCapabilities({}).extensions).toEqual([]);
    expect(
      parseServerCapabilities({ virtualserver_capability_extensions: " B ,,A,B, " }).extensions,
    ).toEqual(["B", "A"]);
  });

  it("freezes the extensions", () => {
    const caps = parseServerCapabilities({ virtualserver_capability_extensions: "STREAM_P2P" });
    expect(Object.isFrozen(caps.extensions)).toBe(true);
    expect(caps.extensions.includes("STREAM_P2P")).toBe(true);
  });

  it("types the host message mode, and passes an unnamed value through", () => {
    const mode = (value: string) =>
      parseServerCapabilities({ virtualserver_hostmessage_mode: value }).hostMessageMode;
    expect(mode("2")).toBe(HostMessageMode.Modal);
    expect(mode("")).toBe(HostMessageMode.None);
    expect(mode("9")).toBe(9);
  });

  it("reports an honest unknown family but keeps the SHA-1 default", () => {
    const caps = unknownServerCapabilities();
    // Nothing has identified the server yet, so the family is unknown rather
    // than assumed — but the uid hash stays at the protocol's original SHA-1,
    // so pre-connect behaviour is unchanged from before TS6 support.
    expect(caps.family).toBe("unknown");
    expect(caps.uidAlgorithm).toBe("sha1");
    expect(caps.version).toBe("");
    expect(caps.extensions).toEqual([]);
  });
});

describe("serverFamilyForVersion", () => {
  it("names the family a version string belongs to", () => {
    expect(serverFamilyForVersion("3.13.8 [Build: 1779874471]")).toBe("ts3");
    expect(serverFamilyForVersion("6.0.0-beta13.1")).toBe("ts6");
    expect(serverFamilyForVersion("7.1.0")).toBe("ts6");
    expect(serverFamilyForVersion("5.0.0")).toBe("unknown");
    expect(serverFamilyForVersion("")).toBe("unknown");
    expect(serverFamilyForVersion("x")).toBe("unknown");
  });

  it("is what the capabilities use", () => {
    expect(parseServerCapabilities("6.0.0-beta13.1").family).toBe(
      serverFamilyForVersion("6.0.0-beta13.1"),
    );
  });
});

describe("the identity helpers of the client entry", () => {
  it("exports the UID algorithm picker and the highest security level", () => {
    expect(uidAlgorithmForVersion("3.13.8")).toBe("sha1");
    expect(uidAlgorithmForVersion("6.0.0-beta13.1")).toBe("sha256");
    expect(MAX_SECURITY_LEVEL).toBe(160);
  });
});
