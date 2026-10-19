/**
 * Fails when a symbol a package exports has no doc comment, or when the
 * published declarations do not compile.
 *
 * Walks each public entry point with the TypeScript compiler API
 * over the built declarations, so it sees exactly what a user imports —
 * re-exports followed, internals that `stripInternal` removed left out — and
 * checks every exported symbol and its members. typedoc would do this, but
 * does not run on TypeScript 7. Run `pnpm build` first.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import type * as TS from "typescript";

// The compiler API ships with TypeScript 5's JavaScript implementation; the
// repository builds with TypeScript 7, which has none, so this loads the API
// the same way a bundler plugin would, from a 5.x copy.
const require = createRequire(import.meta.url);
const ts = require("typescript-api") as typeof TS;

const entries = [
  "dist/core/index.d.ts",
  "dist/client/index.d.ts",
  "dist/query/index.d.ts",
  "dist/stream/index.d.ts",
  "dist/versions/index.d.ts",
].map((p) => resolve(p));

const program = ts.createProgram(entries, { skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();

const undocumented = new Set<string>();
const seen = new Set<TS.Symbol>();

/** Declared in this repository, not in a dependency, Node or the lib. */
function ours(fileName: string): boolean {
  return fileName.startsWith(`${process.cwd()}/`) && !fileName.includes("/node_modules/");
}

function documented(symbol: TS.Symbol): boolean {
  if (symbol.getDocumentationComment(checker).length > 0) return true;
  // A symbol whose declarations sit outside these packages (a re-exported
  // Node or lib type) is not ours to document.
  return (symbol.declarations ?? []).every((d) => !ours(d.getSourceFile().fileName));
}

function where(symbol: TS.Symbol): string {
  const decl = symbol.declarations?.[0];
  if (!decl) return symbol.getName();
  const file = decl.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(decl.getStart());
  return `${file.fileName.replace(process.cwd() + "/", "")}:${line + 1}`;
}

function visit(symbol: TS.Symbol, name: string): void {
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (seen.has(symbol)) return;
  seen.add(symbol);
  if (!documented(symbol)) undocumented.add(`${where(symbol)}: ${name}`);

  const isContainer =
    symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum);
  if (!isContainer) return;
  for (const member of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
    const decl = member.valueDeclaration ?? member.declarations?.[0];
    if (!decl) continue;
    const modifiers = ts.getCombinedModifierFlags(decl);
    if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    if (member.getName().startsWith("__") || member.getName().startsWith("#")) continue;
    if (!documented(member)) undocumented.add(`${where(member)}: ${name}.${member.getName()}`);
  }
}

for (const entry of entries) {
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`cannot read ${entry}; run pnpm build first`);
  for (const exported of checker.getExportsOfModule(moduleSymbol))
    visit(exported, exported.getName());
}

// The declarations must also compile as a user's program sees them, without
// skipLibCheck: stripInternal can remove a symbol another file still
// re-exports, which breaks every consumer that type-checks its libraries.
const strict = ts.createProgram(entries, {
  noEmit: true,
  strict: true,
  types: ["node"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.esnext.disposable.d.ts"],
});
const broken = ts
  .getPreEmitDiagnostics(strict)
  .filter((d) => d.file !== undefined && ours(d.file.fileName))
  .map((d) => {
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
    const file = d.file!.fileName.replace(process.cwd() + "/", "");
    return `${file}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
for (const line of broken) console.log(line);
if (broken.length > 0) {
  console.log(`\n${broken.length} errors in the published declarations.`);
  process.exit(1);
}

for (const line of [...undocumented].sort()) console.log(line);
if (undocumented.size > 0) {
  console.log(`\n${undocumented.size} exported symbols have no doc comment.`);
  process.exit(1);
}
console.log("Every exported symbol is documented.");
