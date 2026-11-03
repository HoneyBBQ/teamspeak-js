import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommandName } from "./command-name.js";

/**
 * Commands the client sends before command middleware exists: the handshake
 * writes them straight to the connection, so no `CommandRequest` carries them.
 */
const handshake = new Set(["clientinit", "clientinitiv", "clientek"]);

/**
 * Names that are not commands the SDK sends. `error` is the reply line the
 * query transport builds for a request, and the empty name is what
 * `buildCommandOrdered("", …)` takes to format only the fields of a row.
 */
const notCommands = new Set(["error", ""]);

const root = new URL("../", import.meta.url);

function sourceFiles(dir: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (entry.name.endsWith(".ts") && !/\.(test|typetest)\.ts$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

const patterns = [
  /\b(?:exec|list|query)\(\s*(?:client|this|executor)[\w.#]*\s*,\s*"([^"]*)"/g,
  /\bbuildCommand(?:Ordered)?\(\s*"([^"]*)"/g,
  /\bcommand:\s*"([^"]*)"/g,
];

function sentCommands(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        found.set(match[1]!, file.pathname);
      }
    }
  }
  return found;
}

describe("CommandName", () => {
  it("names every command the SDK sends", () => {
    const names = new Set<string>(Object.values(CommandName));
    const sent = sentCommands();
    expect(sent.size).toBeGreaterThan(50);
    const missing = [...sent]
      .filter(([name]) => !handshake.has(name) && !notCommands.has(name) && !names.has(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });
});
