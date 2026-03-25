import { describe, it, expect } from "vitest";
import { GenerationWindow } from "./generation-window.js";

describe("GenerationWindow", () => {
  it("starts with generation 0 and base 0", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    expect(w.generation).toBe(0);
  });

  it("isInWindow for values within the window", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    expect(w.isInWindow(0)).toBe(true);
    expect(w.isInWindow(1023)).toBe(true);
    expect(w.isInWindow(1024)).toBe(false);
  });

  it("advance moves the base", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    w.advance(100);
    expect(w.isInWindow(0)).toBe(false);
    expect(w.isInWindow(100)).toBe(true);
    expect(w.isInWindow(1123)).toBe(true);
    expect(w.isInWindow(1124)).toBe(false);
  });

  it("wraps generation on overflow", () => {
    const mod = 1 << 16;
    const w = new GenerationWindow(mod, 1024);
    w.advance(mod - 1);
    expect(w.generation).toBe(0);
    w.advance(1);
    expect(w.generation).toBe(1);
  });

  it("getGeneration returns correct generation for next-gen packets", () => {
    const mod = 1 << 16;
    const w = new GenerationWindow(mod, 1024);
    // Move near the end so that small IDs are in the next generation
    w.advance(mod - 10);
    expect(w.generation).toBe(0);
    // ID 5 is in the next generation
    expect(w.getGeneration(5)).toBe(1);
    // ID 65530+ still in current generation
    expect(w.getGeneration(65530)).toBe(0);
  });

  it("isOldPacket works", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    w.advance(500);
    expect(w.isOldPacket(0)).toBe(true);
    expect(w.isOldPacket(499)).toBe(true);
    expect(w.isOldPacket(500)).toBe(false);
  });

  it("reset restores to initial state", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    w.advance(999);
    w.reset();
    expect(w.generation).toBe(0);
    expect(w.isInWindow(0)).toBe(true);
  });
});
