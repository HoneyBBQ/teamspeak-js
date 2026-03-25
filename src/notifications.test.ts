import { describe, it, expect } from "vitest";
import { handleNotification } from "./notifications.js";
import type { ClientInfo } from "./types.js";

function makeClients(): Map<number, ClientInfo> {
  return new Map();
}

describe("handleNotification", () => {
  describe("notifyclientpoke", () => {
    it("parses poke with message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "5",
          invokername: "Alice",
          invokeruid: "uid123",
          msg: "hello",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(5);
      expect(result.event.invokerName).toBe("Alice");
      expect(result.event.invokerUID).toBe("uid123");
      expect(result.event.message).toBe("hello");
    });

    it("parses poke with empty message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "3",
          invokername: "Bob",
          invokeruid: "uid456",
          msg: "",
        },
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.message).toBe("");
      expect(result.event.invokerName).toBe("Bob");
    });

    it("handles missing fields gracefully", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {},
      };
      const result = handleNotification(cmd, 1, makeClients(), "Bot");
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(0);
      expect(result.event.invokerName).toBe("");
      expect(result.event.invokerUID).toBe("");
      expect(result.event.message).toBe("");
    });
  });

  it("returns unknown for unrecognized notifications", () => {
    const cmd = {
      name: "notifysomethingelse",
      params: {},
    };
    const result = handleNotification(cmd, 1, makeClients(), "Bot");
    expect(result.kind).toBe("unknown");
  });
});
