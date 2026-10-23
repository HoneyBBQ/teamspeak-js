import { describe, it, expect } from "vitest";
import {
  backoffDelay,
  defaultBackoffPolicy,
  jitteredDelay,
  resolveBackoffPolicy,
  type BackoffPolicy,
} from "./reconnect.js";

const policy = (overrides: Partial<BackoffPolicy> = {}): BackoffPolicy => ({
  ...defaultBackoffPolicy,
  jitter: 0,
  ...overrides,
});

describe("backoffDelay", () => {
  it("doubles from the initial delay", () => {
    const p = policy({ initialDelayMs: 100, factor: 2, maxDelayMs: 10_000 });
    expect(backoffDelay(p, 1)).toBe(100);
    expect(backoffDelay(p, 2)).toBe(200);
    expect(backoffDelay(p, 3)).toBe(400);
    expect(backoffDelay(p, 4)).toBe(800);
  });

  it("never exceeds the ceiling", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 5_000 });
    expect(backoffDelay(p, 10)).toBe(5_000);
    expect(backoffDelay(p, 50)).toBe(5_000);
  });

  // TeamSpeak bans an IP after roughly three rapid connects, so a retry loop
  // that returns 0 — or a tiny delay — bans itself and cannot recover.
  it("is never zero, so a retry cannot hammer the server", () => {
    const p = policy({ initialDelayMs: 1, factor: 1, maxDelayMs: 1 });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(backoffDelay(p, attempt)).toBeGreaterThan(0);
    }
  });

  it("keeps the delay near the target when jittered", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 60_000, jitter: 0.2 });
    for (const random of [0, 0.5, 1]) {
      const delay = jitteredDelay(p, 1, () => random);
      // Within 20% either side of 1000ms.
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1_200);
    }
  });

  it("keeps a jittered delay under the ceiling", () => {
    const p = policy({ initialDelayMs: 1_000, factor: 2, maxDelayMs: 4_000, jitter: 0.5 });
    expect(jitteredDelay(p, 10, () => 1)).toBe(4_000);
  });

  it("spreads peers rather than letting them retry in lockstep", () => {
    const p = policy({ initialDelayMs: 1_000, jitter: 0.5 });
    const low = jitteredDelay(p, 1, () => 0);
    const high = jitteredDelay(p, 1, () => 1);
    expect(low).not.toBe(high);
  });
});

describe("defaultBackoffPolicy", () => {
  it("cannot be changed for every client in the process", () => {
    expect(Object.isFrozen(defaultBackoffPolicy)).toBe(true);
  });
});

describe("resolveBackoffPolicy", () => {
  it("applies overrides over the defaults", () => {
    const p = resolveBackoffPolicy({ backoff: { initialDelayMs: 5_000 } });
    expect(p.initialDelayMs).toBe(5_000);
    expect(p.maxDelayMs).toBe(defaultBackoffPolicy.maxDelayMs);
  });
});

describe("resolveBackoffPolicy validation", () => {
  const refused: Array<[string, Record<string, number>]> = [
    ["a zero initial delay", { initialDelayMs: 0 }],
    ["a negative initial delay", { initialDelayMs: -1 }],
    ["a NaN initial delay", { initialDelayMs: NaN }],
    ["an infinite initial delay", { initialDelayMs: Infinity }],
    ["a zero maximum delay", { maxDelayMs: 0 }],
    ["a maximum below the initial delay", { initialDelayMs: 500, maxDelayMs: 100 }],
    ["a NaN factor", { factor: NaN }],
    ["a factor that shrinks the delay", { factor: 0.5 }],
    ["a zero factor", { factor: 0 }],
    ["a NaN jitter", { jitter: NaN }],
    ["a jitter above 1", { jitter: 1.5 }],
    ["a negative attempt limit", { maxAttempts: -1 }],
    ["a fractional attempt limit", { maxAttempts: 1.5 }],
    ["a NaN attempt limit", { maxAttempts: NaN }],
  ];
  it.each(refused)("refuses %s", (_name, backoff) => {
    expect(() => resolveBackoffPolicy({ backoff })).toThrow(RangeError);
  });

  it("accepts the edges, and an unset field keeps its default", () => {
    expect(
      resolveBackoffPolicy({
        backoff: { initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: 0, maxAttempts: 0 },
      }),
    ).toEqual({ initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: 0, maxAttempts: 0 });
    expect(resolveBackoffPolicy({ backoff: { jitter: -1, maxDelayMs: undefined } }).jitter).toBe(
      -1,
    );
    expect(resolveBackoffPolicy({}).initialDelayMs).toBe(defaultBackoffPolicy.initialDelayMs);
  });

  it("raises an unset ceiling to a larger initial delay", () => {
    const p = resolveBackoffPolicy({ backoff: { initialDelayMs: 120_000 } });
    expect(p.maxDelayMs).toBe(120_000);
  });
});
