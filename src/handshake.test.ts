import { describe, it, expect } from "vitest";
import { Client } from "./client.js";
import { generateIdentity } from "./crypto/identity.js";
import { sendClientInit } from "./handshake.js";
import { parseCommand } from "./command/parser.js";
import { PacketType } from "./transport/packet.js";
import type { ClientOptions } from "./types.js";

function captureClientInit(options: ClientOptions = {}) {
  const client = new Client(generateIdentity(0), "localhost", "TS Bot", options);
  let packetType: PacketType | undefined;
  let packetData: Uint8Array | undefined;
  let packetFlags: number | undefined;

  client.handler.sendPacket = ((type, data, flags) => {
    packetType = type;
    packetData = data;
    packetFlags = flags;
  }) as typeof client.handler.sendPacket;

  sendClientInit(client);

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

    expect(params["client_server_password"]).toBe("server secret");
    expect(params["client_default_channel"]).toBe("Lobby Alpha");
    expect(params["client_default_channel_password"]).toBe("channel secret");
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
      raw.indexOf("client_default_channel_password=channel\\ssecret"),
    );
    expect(raw.indexOf("client_default_channel_password=channel\\ssecret")).toBeLessThan(
      raw.indexOf("client_server_password=server\\ssecret"),
    );
    expect(raw.indexOf("client_server_password=server\\ssecret")).toBeLessThan(
      raw.indexOf("client_meta_data="),
    );
  });
});
