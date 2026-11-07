/**
 * Fails when the built site leaves out an entry point or a long-form page.
 *
 * TypeDoc renders only the entry points listed in typedoc.jsonc, and names a
 * module after the `@module` tag in its entry file, or after the file when the
 * tag is missing. Neither mistake is a warning: a subpath export left out of
 * the list has no page, and an untagged one gets a page under a bare file
 * name. So this checks the output: every subpath that package.json exports has
 * a module page named for its import path, and every page in docs/ was
 * rendered. Run `pnpm docs:build` first, or use `pnpm check:site`, which does.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("dist/docs");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  exports: Record<string, string>;
};

const problems: string[] = [];

// TypeDoc's file name for a module: every character outside [A-Za-z0-9] is `_`.
const slug = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "_");

for (const subpath of Object.keys(pkg.exports)) {
  if (subpath === "./package.json") continue;
  const name = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  const page = `modules/${slug(name)}.html`;
  if (!existsSync(resolve(root, page))) {
    problems.push(
      `${name} has no module page (${page}): list its entry file in typedoc.jsonc and tag it \`@module ${name}\`.`,
    );
  }
}

for (const file of readdirSync("docs").filter((f) => f.endsWith(".md"))) {
  const page = `documents/${file.replace(/\.md$/, ".html")}`;
  if (!existsSync(resolve(root, page))) {
    problems.push(`docs/${file} was not rendered (${page}): add it to projectDocuments.`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("Every entry point has a module page and every page in docs/ is rendered.");
