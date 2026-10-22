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

  it("advanceAfter ignores a stale packet and advances past the current one", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    w.advance((1 << 16) + 10); // base 10 of generation 1

    w.advanceAfter(65535); // stale packet from generation 0
    expect(w.isOldPacket(65535)).toBe(true);
    expect(w.isOldPacket(10)).toBe(false);
    expect(w.getGeneration(10)).toBe(1);

    w.advanceAfter(20);
    expect(w.isOldPacket(20)).toBe(true);
    expect(w.isOldPacket(21)).toBe(false);
    expect(w.getGeneration(21)).toBe(1);
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

  // After the 16-bit id wraps, the ids the window has just left behind are at
  // the top of the range. A packet whose acknowledgement was lost is sent again
  // after the move, and it must read as old, and belong to the generation
  // before the window's, or it is neither acknowledged nor decrypted.
  describe("ids behind the base across the wrap", () => {
    const MOD = 1 << 16;
    const SIZE = 1024;
    interface Probe {
      name: string;
      id: number;
      index: number;
      generation: number;
      old: boolean;
      inside: boolean;
      future: boolean;
    }
    const probe = (
      name: string,
      id: number,
      index: number,
      generation: number,
      kind: "old" | "in" | "ahead",
    ): Probe => ({
      name,
      id,
      index,
      generation,
      old: kind === "old",
      inside: kind === "in",
      future: kind === "ahead",
    });
    const cases: Array<{ name: string; advance: number; probes: Probe[] }> = [
      {
        name: "just past the wrap",
        advance: MOD + 1,
        probes: [
          probe("base", 1, 0, 1, "in"),
          probe("zero", 0, -1, 1, "old"),
          probe("last id of the generation before", 65535, -2, 0, "old"),
          probe("furthest behind the window holds", 1 + MOD - SIZE, -SIZE, 0, "old"),
          probe("one further", MOD - SIZE, MOD - SIZE - 1, 1, "ahead"),
          probe("far ahead", 5000, 4999, 1, "ahead"),
        ],
      },
      {
        name: "exactly on the wrap",
        advance: MOD,
        probes: [
          probe("base", 0, 0, 1, "in"),
          probe("last id of the generation before", 65535, -1, 0, "old"),
          probe("furthest behind the window holds", MOD - SIZE, -SIZE, 0, "old"),
          probe("one further", MOD - SIZE - 1, MOD - SIZE - 1, 1, "ahead"),
        ],
      },
      {
        name: "window straddling the next wrap",
        advance: MOD + 65530,
        probes: [
          probe("base", 65530, 0, 1, "in"),
          probe("one behind", 65529, -1, 1, "old"),
          probe("first id of the next generation", 0, 6, 2, "in"),
          probe("last id of the window", 1017, 1023, 2, "in"),
        ],
      },
      {
        name: "two wraps on",
        advance: 2 * MOD + 10,
        probes: [
          probe("last id of the generation before", 65535, -11, 1, "old"),
          probe("behind within the generation", 3, -7, 2, "old"),
        ],
      },
      {
        name: "before the first wrap",
        advance: 1,
        probes: [
          probe("top of the range is not behind", 65535, 65534, 0, "ahead"),
          probe("zero is behind", 0, -1, 0, "old"),
        ],
      },
    ];

    for (const c of cases) {
      // oxlint-disable-next-line vitest/valid-title -- c.name is a string
      it(c.name, () => {
        const w = new GenerationWindow(MOD, SIZE);
        w.advance(c.advance);
        for (const p of c.probes) {
          const at = `${p.name}: id ${p.id}`;
          expect(w.mappedToIndex(p.id), `${at}: mappedToIndex`).toBe(p.index);
          expect(w.getGeneration(p.id), `${at}: getGeneration`).toBe(p.generation);
          expect(w.isOldPacket(p.id), `${at}: isOldPacket`).toBe(p.old);
          expect(w.isInWindow(p.id), `${at}: isInWindow`).toBe(p.inside);
          expect(w.isFuturePacket(p.id), `${at}: isFuturePacket`).toBe(p.future);
        }
      });
    }

    it("lists every id of a small window", () => {
      const w = new GenerationWindow(16, 4);
      w.advance(17); // base 1 of generation 1: the window is 1..4
      const want: Record<number, "old" | "ahead" | "in"> = {
        0: "old",
        15: "old",
        14: "old",
        13: "old",
        12: "ahead",
        11: "ahead",
        6: "ahead",
        5: "ahead",
        1: "in",
        2: "in",
        3: "in",
        4: "in",
      };
      for (const [id, kind] of Object.entries(want)) {
        const n = Number(id);
        const got = w.isOldPacket(n) ? "old" : w.isFuturePacket(n) ? "ahead" : "in";
        expect(got, `id ${id}`).toBe(kind);
      }
      expect(w.getGeneration(13)).toBe(0);
    });
  });

  it("reset restores to initial state", () => {
    const w = new GenerationWindow(1 << 16, 1024);
    w.advance(999);
    w.reset();
    expect(w.generation).toBe(0);
    expect(w.isInWindow(0)).toBe(true);
  });
});
