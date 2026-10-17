/**
 * Fails when a changeset is where `changeset version` will not look for it, or
 * says something it will reject.
 *
 * The repository is in pre-release mode. `changeset version` turns the entries
 * in `.changeset/*.md` into a release and moves them into `.changeset/pre/`;
 * files that are already in `.changeset/pre/` are taken to be released and are
 * skipped without a word, so a changeset put there by hand is missing from the
 * changelog. A file is added to `.changeset/pre/` legitimately only by the
 * release commit, and that commit is the one that bumps the version in
 * package.json. A feature pull request adds its changesets to `.changeset/`.
 *
 * The change is measured from the merge base with the base ref, `origin/main`
 * unless CHANGESET_BASE names another, to the working tree. That needs history:
 * a shallow clone has no merge base.
 *
 * The front matter of each pending changeset is checked too, so that a wrong
 * package name or bump is found in the pull request and not at release time.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const base = process.env.CHANGESET_BASE ?? "origin/main";
const bumps = new Set(["major", "minor", "patch"]);
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const problems: string[] = [];

let mergeBase: string;
try {
  mergeBase = git("merge-base", base, "HEAD").trim();
} catch {
  console.error(
    `No merge base with ${base}: fetch it, with enough history to reach the fork point.`,
  );
  process.exit(1);
}

// Everything the change adds, committed or not. Renames are reported as
// additions, so moving a file into the folder is caught like writing one there.
const added = [
  ...git("diff", "--no-renames", "--name-only", "--diff-filter=A", mergeBase).split("\n"),
  ...git("ls-files", "--others", "--exclude-standard").split("\n"),
].filter((file) => file.startsWith(".changeset/pre/"));

const baseVersion = (JSON.parse(git("show", `${mergeBase}:package.json`)) as { version: string })
  .version;
const isRelease = pkg.version !== baseVersion;

if (added.length > 0 && !isRelease) {
  problems.push(
    `Added under .changeset/pre/ without a version bump (package.json is still ${baseVersion}):`,
    ...added.map((file) => `  ${file}`),
    "`changeset version` skips files in that folder, so they would be left out of the changelog.",
    "Move them to .changeset/. Only the release commit, which bumps the version, writes to .changeset/pre/.",
  );
}

for (const name of readdirSync(".changeset").filter(
  (n) => n.endsWith(".md") && n !== "README.md",
)) {
  const file = `.changeset/${name}`;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n?---(?:\n|$)/.exec(text);
  if (!match) {
    problems.push(`${file}: no front matter between --- lines.`);
    continue;
  }
  for (const line of match[1].split("\n").filter((l) => l.trim() !== "")) {
    const entry = /^\s*["']?([^"':]+)["']?\s*:\s*(\S+)\s*$/.exec(line);
    if (!entry) {
      problems.push(`${file}: cannot read front matter line \`${line}\`.`);
      continue;
    }
    if (entry[1] !== pkg.name) {
      problems.push(`${file}: names package \`${entry[1]}\`, the only package is \`${pkg.name}\`.`);
    }
    if (!bumps.has(entry[2])) {
      problems.push(`${file}: bump \`${entry[2]}\` is not major, minor or patch.`);
    }
  }
}

if (problems.length > 0) {
  for (const line of problems) console.error(line);
  process.exit(1);
}
console.log(`changesets ok (base ${mergeBase.slice(0, 9)}${isRelease ? ", release" : ""})`);
