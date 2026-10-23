import { describe, expect, it } from "vitest";
import { encodeRequest } from "./request.js";

describe("encodeRequest", () => {
  const request = {
    command: "clientmove",
    params: [
      ["clid", 7],
      ["cid", 42n],
      ["cpw", "hunter2"],
    ],
    passwords: ["cpw"],
  } as const;

  // The voice protocol hashes a channel password; ServerQuery sends it as is.
  // The request only says which parameter is a password.
  it("leaves password encoding to the transport", () => {
    expect(encodeRequest(request, (pw) => `hashed(${pw})`)).toBe(
      "clientmove clid=7 cid=42 cpw=hashed(hunter2)",
    );
    expect(encodeRequest(request, (pw) => pw)).toBe("clientmove clid=7 cid=42 cpw=hunter2");
  });

  it("sends an empty password as is, in every encoding", () => {
    const open = { ...request, params: [["cpw", ""]] as const };
    expect(encodeRequest(open, (pw) => `hashed(${pw})`)).toBe("clientmove cpw=");
  });

  it.each([
    "virtualserver_name x=1",
    "a\nlogout",
    "a|b",
    "a=b",
    "",
    "a b",
    "-",
    "a\\sb",
    "näme",
    "a\rb",
  ])("refuses the parameter name %j instead of putting it on the line", (key) => {
    const bad = { command: "serveredit", params: [[key, "v"]] } as const;
    expect(() => encodeRequest(bad, (pw) => pw)).toThrow(TypeError);
    const inRow = { command: "x", rows: [[[key, "v"]]] } as const;
    expect(() => encodeRequest(inRow, (pw) => pw)).toThrow(TypeError);
  });

  it("sends the keys a server names", () => {
    expect(
      encodeRequest(
        {
          command: "serveredit",
          params: [
            ["virtualserver_hostbanner_gfx_interval", 1],
            ["-uid", true],
          ],
        },
        (pw) => pw,
      ),
    ).toBe("serveredit virtualserver_hostbanner_gfx_interval=1 -uid");
  });

  it("omits unset parameters and sends flags bare", () => {
    expect(
      encodeRequest(
        {
          command: "clientlist",
          params: [
            ["-uid", true],
            ["-away", false],
            ["x", undefined],
          ],
        },
        (pw) => pw,
      ),
    ).toBe("clientlist -uid");
  });
});
