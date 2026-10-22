import { describe, expect, it } from "vitest";
import { Emitter, MAX_KEPT } from "./emitter.js";

type Events = { a: number; plain: number };

describe("Emitter", () => {
  it("keeps events for the first listener", () => {
    const emitter = new Emitter<Events>(["a"]);
    emitter.emit("a", 1);
    emitter.emit("a", 2);
    const got: number[] = [];
    emitter.on("a", (n) => got.push(n));
    expect(got).toEqual([1, 2]);
  });

  it("keeps events again once the last listener has unsubscribed", () => {
    const emitter = new Emitter<Events>(["a"]);
    const first: number[] = [];
    const off = emitter.on("a", (n) => first.push(n));
    emitter.emit("a", 1);
    off();
    emitter.emit("a", 2);
    emitter.emit("a", 3);
    const second: number[] = [];
    emitter.on("a", (n) => second.push(n));
    expect(first).toEqual([1]);
    expect(second).toEqual([2, 3]);
  });

  it("does not keep while another listener remains", () => {
    const emitter = new Emitter<Events>(["a"]);
    const kept: number[] = [];
    const offOne = emitter.on("a", () => {});
    emitter.on("a", (n) => kept.push(n));
    offOne();
    emitter.emit("a", 1);
    expect(kept).toEqual([1]);
  });

  it("bounds what it keeps after the last listener and reports the overflow", () => {
    const dropped: string[] = [];
    const emitter = new Emitter<Events>(["a"], (event) => dropped.push(event));
    emitter.on("a", () => {})();
    for (let i = 0; i < MAX_KEPT + 3; i++) emitter.emit("a", i);
    expect(dropped).toHaveLength(3);
    const got: number[] = [];
    emitter.on("a", (n) => got.push(n));
    expect(got).toHaveLength(MAX_KEPT);
    expect(got[0]).toBe(3);
  });

  it("never keeps an event not named", () => {
    const emitter = new Emitter<Events>(["a"]);
    emitter.on("plain", () => {})();
    emitter.emit("plain", 1);
    const got: number[] = [];
    emitter.on("plain", (n) => got.push(n));
    expect(got).toEqual([]);
  });
});
