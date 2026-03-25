import { describe, it, expect } from "vitest";
import { CommandThrottle } from "./throttle.js";

describe("CommandThrottle", () => {
  it("allows immediate calls when tokens are available", async () => {
    const t = new CommandThrottle();
    const start = Date.now();
    await t.wait();
    await t.wait();
    await t.wait();
    await t.wait();
    await t.wait();
    // 5 calls should succeed instantly (initial tokens = 5)
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("throttles when bucket is exhausted", async () => {
    const t = new CommandThrottle();
    // Exhaust initial 5 tokens
    for (let i = 0; i < 5; i++) await t.wait();
    const start = Date.now();
    // One more token should require ~250ms at rate 4/s
    await t.wait();
    expect(Date.now() - start).toBeGreaterThan(50);
  });

  it("respects AbortSignal", async () => {
    const t = new CommandThrottle();
    // Exhaust tokens
    for (let i = 0; i < 5; i++) await t.wait();

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("aborted")), 50);

    await expect(t.wait(controller.signal)).rejects.toThrow("aborted");
  });
});
