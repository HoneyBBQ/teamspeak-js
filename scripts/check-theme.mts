/**
 * Fails when the built API reference is not the Material theme.
 *
 * A theme plugin that does not load leaves no trace in the build: TypeDoc
 * renders with its default theme instead, exits 0 and warns about nothing, so
 * the only place the regression shows up is the output itself. Checking the
 * output is therefore the check. The theme copies `assets/material-style.css`
 * into the site and, on every page, inlines the Material system colours that
 * stylesheet reads — the stock theme does neither — so a page that loads that
 * asset and carries those properties can only have been rendered with the
 * theme in place. Run `pnpm docs:build` first, or use `pnpm check:site`, which
 * does.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve("dist/docs");
// The theme's own stylesheet, copied in at render end. Nothing else writes it.
const themeAsset = resolve(root, "assets/material-style.css");

try {
  if (statSync(themeAsset).size === 0) throw new Error("empty");
} catch {
  console.error(`${relative(process.cwd(), themeAsset)} is missing or empty.`);
  console.error("The Material theme did not load; run `pnpm docs:build` first.");
  process.exit(1);
}

const pages = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".html"))
  .map((path) => resolve(root, path));

if (pages.length === 0) {
  console.error(`${root} has no pages; run \`pnpm docs:build\` first.`);
  process.exit(1);
}

/** The stylesheet hrefs a page loads, wherever the attributes sit on the tag. */
function stylesheets(html: string): string[] {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  return links
    .filter((tag) => /\brel\s*=\s*["']?stylesheet\b/i.test(tag))
    .map((tag) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
    .filter((href): href is string => href !== undefined);
}

/** Where a page's href points, resolved from that page's own directory. */
function targetOf(page: string, href: string): string {
  // A page under `documents/` links `../assets/...`, the root one `assets/...`.
  // A leading slash would be site-absolute, so resolve it from the root.
  const path = href.split(/[?#]/)[0];
  return path.startsWith("/") ? resolve(root, path.slice(1)) : resolve(dirname(page), path);
}

const unthemed: string[] = [];
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const themed = stylesheets(html).some((href) => targetOf(page, href) === themeAsset);
  // The theme derives these from `themeColor`; without them the stylesheet it
  // loads has no colours to read, so a page needs both to be themed at all.
  const hasPalette = /--md-sys-color-[a-z0-9-]+\s*:/i.test(html);
  if (!themed || !hasPalette) unthemed.push(relative(root, page));
}

for (const page of unthemed) console.log(page);
if (unthemed.length > 0) {
  console.log(`\n${unthemed.length} pages are not rendered with the Material theme.`);
  process.exit(1);
}
console.log(`Every page is rendered with the Material theme (${pages.length} pages).`);
