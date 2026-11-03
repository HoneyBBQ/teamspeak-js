import { describe, expect, expectTypeOf, it } from "vitest";
import { QueryEventCategory } from "./index.js";

describe("QueryEventCategory", () => {
  it("is frozen and its type is exactly its values", () => {
    expect(Object.isFrozen(QueryEventCategory)).toBe(true);
    expectTypeOf<QueryEventCategory>().toEqualTypeOf<
      "server" | "channel" | "textserver" | "textchannel" | "textprivate" | "bans" | "tokenused"
    >();
  });
});
