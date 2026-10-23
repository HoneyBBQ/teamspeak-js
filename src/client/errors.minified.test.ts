import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Rolldown } from "vite";
import * as core from "@honeybbq/teamspeak";
import * as client from "./errors.js";

/**
 * Two copies of the SDK's errors, bundled the way a consumer's minifier would:
 * class names mangled, so a match by `constructor.name` cannot work.
 */
async function minifiedCopy(dir: string, name: string): Promise<Record<string, Function>> {
  const entry = join(dir, `${name}-entry.ts`);
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(fileURLToPath(new URL("./errors.ts", import.meta.url)))};`,
      `export { TeamspeakError, ServerError, CommandTimeoutError, NotConnectedError, NoDataError, AlreadyConnectedError } from ${JSON.stringify(fileURLToPath(new URL("../core/errors.ts", import.meta.url)))};`,
    ].join("\n"),
  );
  const result = (await build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: true, lib: { entry, formats: ["es"] } },
  })) as Rolldown.RolldownOutput[];
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, result[0]!.output[0].code);
  return (await import(pathToFileURL(file).href)) as Record<string, Function>;
}

const kinds = [
  "TeamspeakError",
  "ServerError",
  "CommandTimeoutError",
  "NotConnectedError",
  "NoDataError",
  "AlreadyConnectedError",
  "HandshakeError",
  "PuzzleTooHardError",
  "RemovedError",
] as const;

function make(classes: Record<string, Function>, kind: string): Error {
  const C = classes[kind] as new (...args: unknown[]) => Error;
  if (kind === "ServerError") return new C(1, "x");
  if (kind === "PuzzleTooHardError") return new C(5, 4);
  if (kind === "RemovedError") return new C(5, "bye", "admin");
  return new C("x");
}

describe("instanceof across minified copies", () => {
  it("matches by kind, up the chain, with the class names mangled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-errors-"));
    try {
      const a = await minifiedCopy(dir, "a");
      const b = await minifiedCopy(dir, "b");
      expect(a.ServerError).not.toBe(b.ServerError);
      expect(a.ServerError!.name).not.toBe("ServerError");

      const here = { ...core, ...client } as unknown as Record<string, Function>;
      for (const made of kinds) {
        for (const asked of kinds) {
          const want = make(here, made) instanceof (here[asked] as Function);
          expect(make(a, made) instanceof (b[asked] as Function), `${made} vs ${asked}`).toBe(want);
          expect(make(a, made) instanceof (here[asked] as Function), `${made} vs ${asked}`).toBe(
            want,
          );
        }
      }
      expect(make(a, "ServerError") instanceof (b.TeamspeakError as Function)).toBe(true);
      expect(make(a, "TeamspeakError") instanceof (b.ServerError as Function)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("client error names", () => {
  it("are on the prototype, not own properties", () => {
    const errors = [
      new core.AlreadyConnectedError(),
      new client.InvalidAddressError("a", "b"),
      new client.FileTransferError("x"),
      new client.HandshakeError("x"),
      new client.PuzzleTooHardError(5, 4),
      new client.InvalidIdentityError(),
      new client.ConnectionTimeoutError(),
      new client.ConnectionStalledError(),
      new client.RemovedError(1, "", ""),
    ];
    for (const err of errors) {
      expect(Object.keys(err)).not.toContain("name");
      expect(err.name).toBe((err.constructor as unknown as { kind: string }).kind);
    }
  });
});
