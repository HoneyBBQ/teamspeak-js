import { describe, expect, expectTypeOf, it } from "vitest";
import {
  JoinRequestCloseCause,
  JoinRequestEventName,
  type JoinRequestEvents,
  JoinRequestState,
  PeerCloseCause,
  PeerEventName,
  type PeerEvents,
  PublishedStreamEventName,
  type PublishedStreamEvents,
  StreamAccessibility,
  StreamEndCause,
  StreamSource,
  StreamTransport,
  StreamWarningCode,
  StreamsEventName,
  type StreamsEventMap,
  type StreamStoppedEvent,
} from "./index.js";

const eventNames = {
  StreamsEventName,
  PublishedStreamEventName,
  JoinRequestEventName,
  PeerEventName,
};

const valueTables = {
  StreamSource,
  StreamAccessibility,
  StreamTransport,
  PeerCloseCause,
  JoinRequestState,
  JoinRequestCloseCause,
  StreamEndCause,
  StreamWarningCode,
};

describe("event names", () => {
  for (const [name, table] of Object.entries(eventNames)) {
    it(`${name} is frozen and names each event once`, () => {
      expect(Object.isFrozen(table)).toBe(true);
      for (const [key, value] of Object.entries(table)) {
        expect(key.toLowerCase()).toBe(value.toLowerCase());
        expect(key[0]).toBe(key[0]!.toUpperCase());
        expect(value[0]).toBe(value[0]!.toLowerCase());
      }
      expect(new Set(Object.values(table)).size).toBe(Object.keys(table).length);
    });
  }

  it("are exactly the keys of their maps", () => {
    expectTypeOf<StreamsEventName>().toEqualTypeOf<keyof StreamsEventMap>();
    expectTypeOf<PublishedStreamEventName>().toEqualTypeOf<keyof PublishedStreamEvents>();
    expectTypeOf<JoinRequestEventName>().toEqualTypeOf<keyof JoinRequestEvents>();
    expectTypeOf<PeerEventName>().toEqualTypeOf<keyof PeerEvents>();
  });
});

describe("value tables", () => {
  for (const [name, table] of Object.entries(valueTables)) {
    it(`${name} is frozen and names each value once`, () => {
      expect(Object.isFrozen(table)).toBe(true);
      for (const [key, value] of Object.entries(table)) {
        expect(key[0]).toBe(key[0]!.toUpperCase());
        expect(key.toLowerCase()).toBe(value.replaceAll("-", ""));
      }
      expect(new Set(Object.values(table)).size).toBe(Object.keys(table).length);
    });
  }

  it("have exactly their values as types", () => {
    expectTypeOf<StreamSource>().toEqualTypeOf<
      "none" | "camera" | "screen" | "window" | "session"
    >();
    expectTypeOf<StreamAccessibility>().toEqualTypeOf<"none" | "public" | "contacts" | "private">();
    expectTypeOf<StreamTransport>().toEqualTypeOf<"p2p">();
    expectTypeOf<PeerCloseCause>().toEqualTypeOf<
      "closed" | "left" | "stopped" | "disconnected" | "disposed"
    >();
    expectTypeOf<JoinRequestState>().toEqualTypeOf<
      "pending" | "accepted" | "denied" | "failed" | "withdrawn" | "ended"
    >();
    expectTypeOf<JoinRequestCloseCause>().toEqualTypeOf<"withdrawn" | "ended">();
    expectTypeOf<StreamEndCause>().toEqualTypeOf<
      "stopped" | "server" | "gone" | "disconnected" | "disposed"
    >();
    expectTypeOf<StreamWarningCode>().toEqualTypeOf<"offer-without-audio">();
    expectTypeOf<StreamStoppedEvent["cause"]>().toEqualTypeOf<"server" | "stopped" | "gone">();
  });
});
