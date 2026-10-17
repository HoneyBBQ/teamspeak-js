/**
 * The Init1 puzzle: repeated squaring modulo n, solved in slices that give the
 * event loop back and stop when the connect is cancelled.
 */

import { describe, expect, it } from "vitest";
import { HandshakeError, PuzzleTooHardError } from "../errors.js";
import { Crypt, MAX_RSA_CHALLENGE_LEVEL, SQUARINGS_PER_SLICE } from "./crypt.js";
import { generateIdentitySync } from "./identity.js";

const crypt = new Crypt(generateIdentitySync(0));

function toBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 63; i >= 0; i--, value >>= 8n) out[i] = Number(value & 0xffn);
  return out;
}

/** x then n, 64 bytes each, as the server sends them. */
function puzzle(x: bigint, n: bigint): Uint8Array {
  return Uint8Array.from([...toBytes(x), ...toBytes(n)]);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (base %= modulus; exponent > 0n; exponent >>= 1n, base = (base * base) % modulus) {
    if (exponent & 1n) result = (result * base) % modulus;
  }
  return result;
}

const N = (1n << 511n) + 1_000_003n;
const X = 0x1234_5678_9abc_def0_1234_5678_9abc_def0n;
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("solveRsaChallenge", () => {
  it("squares x modulo n, level times", async () => {
    // x^(2^level) mod n, worked out another way, across the slice boundaries.
    for (const level of [
      0,
      1,
      2,
      10,
      SQUARINGS_PER_SLICE - 1,
      SQUARINGS_PER_SLICE,
      SQUARINGS_PER_SLICE + 1,
      2 * SQUARINGS_PER_SLICE + 7,
    ]) {
      const want = toBytes(modPow(X, 1n << BigInt(level), N));
      expect(await crypt.solveRsaChallenge(puzzle(X, N), 0, level), `level ${level}`).toEqual(want);
    }
  });

  it("reads the numbers at the offset", async () => {
    const data = Uint8Array.from([9, 9, 9, ...puzzle(3n, 1_000_003n)]);
    expect(await crypt.solveRsaChallenge(data, 3, 3)).toEqual(toBytes(modPow(3n, 8n, 1_000_003n)));
  });

  it("refuses a level that is no number, and a modulus of zero", async () => {
    for (const level of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await crypt.solveRsaChallenge(puzzle(X, N), 0, level).catch((e: unknown) => e);
      expect(error, `level ${level}`).toBeInstanceOf(HandshakeError);
    }
    await expect(crypt.solveRsaChallenge(puzzle(X, 0n), 0, 1)).rejects.toBeInstanceOf(
      HandshakeError,
    );
  });

  describe("the cap", () => {
    it("is above the highest level a server asks for", () => {
      expect(MAX_RSA_CHALLENGE_LEVEL).toBeGreaterThanOrEqual(1_000_000);
    });

    it("refuses one squaring more with a PuzzleTooHardError saying what was asked", async () => {
      const error = await crypt
        .solveRsaChallenge(puzzle(X, N), 0, MAX_RSA_CHALLENGE_LEVEL + 1)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PuzzleTooHardError);
      expect(error).toBeInstanceOf(HandshakeError);
      expect((error as PuzzleTooHardError).level).toBe(MAX_RSA_CHALLENGE_LEVEL + 1);
      expect((error as PuzzleTooHardError).maxLevel).toBe(MAX_RSA_CHALLENGE_LEVEL);
      await expect(crypt.solveRsaChallenge(puzzle(X, N), 0, 0xffffffff)).rejects.toBeInstanceOf(
        PuzzleTooHardError,
      );
    });

    it("accepts the cap itself", async () => {
      // Solved for real it takes seconds; a cancelled one shows the level was
      // taken as a puzzle, not refused as too hard.
      const reason = new Error("cancelled");
      const signal = AbortSignal.abort(reason);
      await expect(
        crypt.solveRsaChallenge(puzzle(X, N), 0, MAX_RSA_CHALLENGE_LEVEL, signal),
      ).rejects.toBe(reason);
    });
  });

  describe("cancelling", () => {
    it("rejects with the signal's reason at once if it is aborted already", async () => {
      const reason = new Error("gone");
      await expect(
        crypt.solveRsaChallenge(puzzle(X, N), 0, 10, AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
    });

    it("stops a large solve midway, within a slice", async () => {
      const controller = new AbortController();
      const reason = new Error("caller gave up");
      const started = performance.now();
      const solving = crypt.solveRsaChallenge(
        puzzle(X, N),
        0,
        MAX_RSA_CHALLENGE_LEVEL,
        controller.signal,
      );
      // Let several slices run, then cancel.
      await settle();
      await settle();
      const cancelledAt = performance.now();
      controller.abort(reason);
      await expect(solving).rejects.toBe(reason);
      const now = performance.now();
      // The whole solve is over a second; the stop takes one slice at most.
      expect(now - cancelledAt).toBeLessThan(250);
      expect(now - started).toBeLessThan(1_000);
    });
  });

  it("does not hold the event loop for longer than a slice", async () => {
    let last = performance.now();
    let longest = 0;
    let running = true;
    const tick = (): void => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const started = performance.now();
    await crypt.solveRsaChallenge(puzzle(X, N), 0, 600_000);
    const took = performance.now() - started;
    running = false;
    // Meaningful only if the solve was long next to what the loop waited.
    expect(took).toBeGreaterThan(longest * 2);
    expect(longest).toBeLessThan(250);
  });
});
