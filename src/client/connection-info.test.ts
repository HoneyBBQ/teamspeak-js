import { describe, expect, it } from "vitest";
import { buildSetConnectionInfo } from "./connection-info.js";
import { parseCommand } from "../core/internal.js";
import { TrafficMeter } from "./transport/traffic.js";
import { PacketType } from "./transport/packet.js";

describe("buildSetConnectionInfo", () => {
  const meter = new TrafficMeter();
  meter.recordSent(PacketType.Voice, 120, 1_000);
  meter.recordSent(PacketType.Command, 80, 1_000);
  meter.recordReceived(PacketType.Pong, 13, 1_500);
  const traffic = meter.snapshot(3_000);

  it("sends the counters of every class and direction", () => {
    const params = parseCommand(buildSetConnectionInfo(traffic, null))!.params;
    expect(params["connection_packets_sent_speech"]).toBe("1");
    expect(params["connection_bytes_sent_speech"]).toBe("120");
    expect(params["connection_packets_sent_control"]).toBe("1");
    expect(params["connection_bytes_received_keepalive"]).toBe("13");
    expect(params["connection_packets_received_speech"]).toBe("0");
    expect(Object.keys(params)).toHaveLength(12 + 12);
  });

  it("leaves the ping out until a pong has come back, then sends it with four decimals", () => {
    expect(parseCommand(buildSetConnectionInfo(traffic, null))!.params).not.toHaveProperty(
      "connection_ping",
    );
    const params = parseCommand(
      buildSetConnectionInfo(traffic, { meanMs: 12.34567, deviationMs: 0.5 }),
    )!.params;
    expect(params["connection_ping"]).toBe("12.3457");
    expect(params["connection_ping_deviation"]).toBe("0.5000");
  });

  it("never sends figures it does not track", () => {
    const text = buildSetConnectionInfo(traffic, { meanMs: 1, deviationMs: 1 });
    expect(text).not.toContain("packetloss");
    expect(text).not.toContain("filetransfer");
    expect(text).not.toContain("connected_time");
    expect(text).not.toContain("connection_client_");
  });

  it("sends whole numbers for the counters and bandwidths", () => {
    const params = parseCommand(buildSetConnectionInfo(traffic, null))!.params;
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("connection_")) expect(value, key).toMatch(/^\d+$/);
    }
  });
});
