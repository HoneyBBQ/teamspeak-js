import { clientInternals } from "./client.js";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { defaultClientVersion, sendClientInit } from "./handshake.js";
import { Windows_3_6_3_1701166057, Windows_3_X_X_5680278000 } from "../versions/index.js";
import { parseCommand } from "../core/internal.js";
import { PacketType } from "./transport/packet.js";
import type { ClientOptions } from "./types.js";

function prepareClientPassword(password: string): string {
  if (password === "") return "";
  return createHash("sha1").update(password).digest().toString("base64");
}

function captureClientInit(options: ClientOptions = {}) {
  const client = new Client(generateIdentitySync(0), "localhost", "TS Bot", options);
  let packetType: PacketType | undefined;
  let packetData: Uint8Array | undefined;
  let packetFlags: number | undefined;

  clientInternals(client).handler.sendPacket = (type, data, flags) => {
    packetType = type;
    packetData = data;
    packetFlags = flags;
  };

  sendClientInit(clientInternals(client));

  expect(packetType).toBe(PacketType.Command);
  expect(packetFlags).toBe(0);
  expect(packetData).toBeDefined();

  const raw = Buffer.from(packetData!).toString("utf8");
  const cmd = parseCommand(raw);

  expect(cmd?.name).toBe("clientinit");

  return {
    raw,
    params: cmd?.params ?? {},
  };
}

describe("sendClientInit", () => {
  it("sends empty connection auth fields by default", () => {
    const { params } = captureClientInit();

    expect(params["client_default_channel"]).toBe("");
    expect(params["client_default_channel_password"]).toBe("");
    expect(params["client_server_password"]).toBe("");
  });

  it("includes configured server and default channel credentials", () => {
    const { params } = captureClientInit({
      serverPassword: "server secret",
      defaultChannel: "Lobby Alpha",
      defaultChannelPassword: "channel secret",
    });

    expect(params["client_server_password"]).toBe(prepareClientPassword("server secret"));
    expect(params["client_default_channel"]).toBe("Lobby Alpha");
    expect(params["client_default_channel_password"]).toBe(prepareClientPassword("channel secret"));
  });

  it("sends no privilege key and no meta data by default", () => {
    const { params } = captureClientInit();

    expect(params["client_default_token"]).toBe("");
    expect(params["client_meta_data"]).toBe("");
  });

  it("sends the privilege key and meta data it is given, escaped", () => {
    const { params } = captureClientInit({ privilegeKey: "abc DEF+/=", metaData: '{"a": 1}' });

    expect(params["client_default_token"]).toBe("abc DEF+/=");
    expect(params["client_meta_data"]).toBe('{"a": 1}');
  });

  it("preserves the clientinit parameter order", () => {
    const { raw } = captureClientInit({
      serverPassword: "server secret",
      defaultChannel: "Lobby Alpha",
      defaultChannelPassword: "channel secret",
    });

    expect(raw.indexOf("client_output_hardware=1")).toBeLessThan(
      raw.indexOf("client_default_channel=Lobby\\sAlpha"),
    );
    expect(raw.indexOf("client_default_channel=Lobby\\sAlpha")).toBeLessThan(
      raw.indexOf(`client_default_channel_password=${prepareClientPassword("channel secret")}`),
    );
    expect(
      raw.indexOf(`client_default_channel_password=${prepareClientPassword("channel secret")}`),
    ).toBeLessThan(raw.indexOf(`client_server_password=${prepareClientPassword("server secret")}`));
    expect(
      raw.indexOf(`client_server_password=${prepareClientPassword("server secret")}`),
    ).toBeLessThan(raw.indexOf("client_meta_data="));
  });
});

describe("the version option", () => {
  it("sends the default version unless told otherwise", () => {
    const { params } = captureClientInit();

    expect(params["client_platform"]).toBe("Windows");
    expect(params["client_version"]).toBe("3.?.? [Build: 5680278000]");
    expect(params["client_version_sign"]).toBe(defaultClientVersion.sign);
  });

  it("keeps the default equal to the table's entry", () => {
    expect(defaultClientVersion).toEqual(Windows_3_X_X_5680278000);
  });

  it("sends the platform, version and signature it is given", () => {
    const { params } = captureClientInit({ version: Windows_3_6_3_1701166057 });

    expect(params["client_platform"]).toBe(Windows_3_6_3_1701166057.platform);
    expect(params["client_version"]).toBe(Windows_3_6_3_1701166057.version);
    expect(params["client_version_sign"]).toBe(Windows_3_6_3_1701166057.sign);
  });

  it("rejects a version with an empty field when the client is made", () => {
    for (const field of ["platform", "version", "sign"] as const) {
      const version = { ...Windows_3_6_3_1701166057, [field]: "" };
      expect(() => new Client(generateIdentitySync(0), "localhost", "Bot", { version })).toThrow(
        TypeError,
      );
    }
  });

  it("rejects a signature that is not the base64 of 64 bytes", () => {
    for (const sign of ["AAAA", "not base64!", Buffer.alloc(63).toString("base64")]) {
      const version = { ...Windows_3_6_3_1701166057, sign };
      expect(() => new Client(generateIdentitySync(0), "localhost", "Bot", { version })).toThrow(
        RangeError,
      );
    }
  });

  it("is not changed by editing the object afterwards", () => {
    const version = { ...Windows_3_6_3_1701166057 };
    const client = new Client(generateIdentitySync(0), "localhost", "Bot", { version });
    version.platform = "Linux";

    expect(clientInternals(client).initOptions.version.platform).toBe("Windows");
  });
});
