import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandTimeoutError } from "@honeybbq/teamspeak";
import { within } from "./wait.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("within", () => {
  it("clears its timer when the promise settles", async () => {
    vi.useFakeTimers();
    await within(Promise.resolve(1), "c", 1000, undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer and its listener when the time runs out", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = within(new Promise<never>(() => {}), "c", 50, controller.signal);
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60);
    expect(await caught).toBeInstanceOf(CommandTimeoutError);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer when the signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const caught = within(new Promise<never>(() => {}), "c", 1000, controller.signal).catch(
      (e: unknown) => e,
    );
    controller.abort(new Error("stop"));
    expect(((await caught) as Error).message).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects at once for a signal that has aborted, without a timer or a listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(new Error("already"));
    const add = vi.spyOn(controller.signal, "addEventListener");
    await expect(within(Promise.resolve(1), "c", 1000, controller.signal)).rejects.toThrow(
      "already",
    );
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
