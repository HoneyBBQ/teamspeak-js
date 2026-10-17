import { describe, expect, it } from "vitest";
import { PacketType } from "./packet.js";
import { RoundTripEstimator, TrafficMeter, trafficClassOf } from "./traffic.js";

describe("trafficClassOf", () => {
  it("counts voice as speech, ping and pong as keepalive, the rest as control", () => {
    expect(trafficClassOf(PacketType.Voice)).toBe("speech");
    expect(trafficClassOf(PacketType.VoiceWhisper)).toBe("speech");
    expect(trafficClassOf(PacketType.Ping)).toBe("keepalive");
    expect(trafficClassOf(PacketType.Pong)).toBe("keepalive");
    for (const t of [
      PacketType.Command,
      PacketType.CommandLow,
      PacketType.Ack,
      PacketType.AckLow,
      PacketType.Init1,
    ]) {
      expect(trafficClassOf(t)).toBe("control");
    }
  });
});

describe("TrafficMeter", () => {
  it("counts packets and bytes per direction and class", () => {
    const meter = new TrafficMeter();
    meter.recordSent(PacketType.Voice, 100, 1_000);
    meter.recordSent(PacketType.VoiceWhisper, 50, 1_100);
    meter.recordSent(PacketType.Ping, 11, 1_200);
    meter.recordReceived(PacketType.Command, 70, 1_300);
    const snap = meter.snapshot(1_400);
    expect(snap.sent.speech).toMatchObject({ packets: 2, bytes: 150 });
    expect(snap.sent.keepalive).toMatchObject({ packets: 1, bytes: 11 });
    expect(snap.sent.control).toMatchObject({ packets: 0, bytes: 0 });
    expect(snap.received.control).toMatchObject({ packets: 1, bytes: 70 });
  });

  it("reports the last full second and the minute's average per second", () => {
    const meter = new TrafficMeter();
    meter.recordSent(PacketType.Voice, 600, 10_100);
    meter.recordSent(PacketType.Voice, 60, 11_500);
    // At 12.2 s the last full second is 11 (60 bytes); the minute holds 660.
    const snap = meter.snapshot(12_200);
    expect(snap.sent.speech.bytesLastSecond).toBe(60);
    expect(snap.sent.speech.bytesPerSecondLastMinute).toBe(11);
    // A minute later the old traffic has left the window, the totals have not.
    const later = meter.snapshot(80_000);
    expect(later.sent.speech.bytesLastSecond).toBe(0);
    expect(later.sent.speech.bytesPerSecondLastMinute).toBe(0);
    expect(later.sent.speech.bytes).toBe(660);
  });
});

describe("RoundTripEstimator", () => {
  it("has nothing before the first sample", () => {
    expect(new RoundTripEstimator().get()).toBeNull();
  });

  it("reports the mean and the standard deviation of recent samples", () => {
    const rtt = new RoundTripEstimator();
    rtt.add(10);
    rtt.add(20);
    expect(rtt.get()).toEqual({ meanMs: 15, deviationMs: 5 });
  });

  it("keeps only the last ten", () => {
    const rtt = new RoundTripEstimator();
    for (let i = 0; i < 10; i++) rtt.add(1000);
    for (let i = 0; i < 10; i++) rtt.add(10);
    expect(rtt.get()).toEqual({ meanMs: 10, deviationMs: 0 });
  });
});
