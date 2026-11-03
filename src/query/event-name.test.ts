import { describe, expect, expectTypeOf, it } from "vitest";
import type { TextMessageEvent } from "@honeybbq/teamspeak";
import { type QueryClient, QueryEventName, type QueryEventMap } from "./index.js";

describe("QueryEventName", () => {
  it("is frozen and names each event once", () => {
    expect(Object.isFrozen(QueryEventName)).toBe(true);
    for (const [key, value] of Object.entries(QueryEventName)) {
      expect(key.toLowerCase()).toBe(value.toLowerCase());
      expect(key[0]).toBe(key[0]!.toUpperCase());
      expect(value[0]).toBe(value[0]!.toLowerCase());
    }
    expect(new Set(Object.values(QueryEventName)).size).toBe(Object.keys(QueryEventName).length);
  });

  it("is exactly the keys of QueryEventMap", () => {
    expectTypeOf<QueryEventName>().toEqualTypeOf<keyof QueryEventMap>();
  });

  it("types the listener's payload from the constant", () => {
    type OnText = typeof QueryClient.prototype.on<typeof QueryEventName.TextMessage>;
    type OnConnected = typeof QueryClient.prototype.on<typeof QueryEventName.Connected>;
    expectTypeOf<Parameters<OnText>[0]>().toEqualTypeOf<"textMessage">();
    expectTypeOf<Parameters<OnText>[1]>().toEqualTypeOf<(payload: TextMessageEvent) => void>();
    expectTypeOf<Parameters<OnConnected>[0]>().toEqualTypeOf<"connected">();
    expectTypeOf(QueryEventName.TextMessage).toEqualTypeOf<"textMessage">();
  });
});
