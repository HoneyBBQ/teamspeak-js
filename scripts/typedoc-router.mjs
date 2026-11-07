// @ts-check
/**
 * A TypeDoc router that renders `@honeybbq/teamspeak/versions` on one page.
 *
 * That entry point is a table: about 1,500 constants, one per client version,
 * each a platform, a version string and a signature. The default router gives
 * every exported variable a page of its own, which turns the table into 1,500
 * pages and as many sidebar entries. This router keeps the module's constants
 * on the module page, each with its own anchor, and routes everything else as
 * the default ("kind") router does.
 */

import { KindRouter, ReflectionKind } from "typedoc";

const VERSIONS = "@honeybbq/teamspeak/versions";

class TeamspeakRouter extends KindRouter {
  /** @param {import("typedoc").RouterTarget} target */
  getPageKind(target) {
    if (
      "kindOf" in target &&
      target.kindOf(ReflectionKind.Variable) &&
      target.parent?.kindOf(ReflectionKind.Module) &&
      target.parent.name === VERSIONS
    ) {
      return undefined;
    }
    return super.getPageKind(target);
  }
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.renderer.defineRouter("teamspeak", TeamspeakRouter);
}
