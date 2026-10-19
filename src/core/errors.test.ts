import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "./errorcode.js";
import { ServerError, parseServerError } from "./errors.js";

describe("parseServerError", () => {
  it("reads the code and the refusal's details", () => {
    const { err, rc } = parseServerError({
      id: "2568",
      msg: "insufficient client permissions",
      failed_permid: "236",
      extra_msg: "detail",
      return_code: "7",
    });
    expect(err).toBeInstanceOf(ServerError);
    expect(err?.code).toBe(ErrorCode.PermissionsClientInsufficient);
    expect(err?.failedPermissionID).toBe(236);
    expect(err?.extraMessage).toBe("detail");
    expect(rc).toBe(7);
  });

  it("treats id=0 as success", () => {
    expect(parseServerError({ id: "0", msg: "ok" }).err).toBeNull();
  });

  // An error line that does not say what went wrong has still not said that
  // nothing did.
  it("reports an error line without an id as Undefined", () => {
    expect(parseServerError({ msg: "no id" }).err?.code).toBe(ErrorCode.Undefined);
  });
});

describe("WebQuery access refusals", () => {
  it.each([
    ["out of scope", 5120, ErrorCode.APIKeyOutOfScope],
    ["invalid apikey", 5122, ErrorCode.APIKeyInvalid],
    ["missing apikey", 5124, ErrorCode.APIKeyMissing],
  ])("names the code of %s", (msg, id, name) => {
    const { err } = parseServerError({ id: String(id), msg });
    expect(err?.code).toBe(name);
    expect(name).toBe(id);
  });
});

describe("stream refusals", () => {
  it.each([
    ["Stream does not exist", 5635, ErrorCode.StreamNotFound],
    ["You are not participating in this stream", 5636, ErrorCode.StreamNotParticipating],
    ["You already joined this stream", 5638, ErrorCode.StreamAlreadyJoined],
    ["The join request was redacted", 5639, ErrorCode.StreamJoinRequestRedacted],
  ])("names the code of %s", (msg, id, name) => {
    const { err } = parseServerError({ id: String(id), msg });
    expect(err?.code).toBe(name);
    expect(name).toBe(id);
  });
});

describe("instanceof across copies of the package", () => {
  it("matches by kind, up the chain, and only with the brand", async () => {
    const core = await import("./errors.js");
    // A second installed copy: the same module, loaded again.
    vi.resetModules();
    const other = await import("./errors.js");
    expect(other.ServerError).not.toBe(core.ServerError);

    const refused = new other.ServerError(1, "x");
    expect(refused instanceof core.ServerError).toBe(true);
    expect(refused instanceof core.TeamspeakError).toBe(true);
    expect(refused instanceof core.NotConnectedError).toBe(false);
    expect(new core.NotConnectedError() instanceof other.NotConnectedError).toBe(true);

    class Impostor extends Error {}
    expect(new Impostor() instanceof core.ServerError).toBe(false);
    // What `instanceof` asks for a value that is not an object at all.
    expect(core.TeamspeakError[Symbol.hasInstance](null)).toBe(false);
  });
});

describe("exported tables", () => {
  it("are frozen, so no caller can change them for every other", async () => {
    const core = await import("./index.js");
    for (const table of [
      core.ErrorCode,
      core.PermissionName,
      core.CommandName,
      core.NotificationName,
      core.PropertyName,
      core.Reason,
      core.Codec,
      core.GroupType,
      core.HostMessageMode,
      core.noopLogger,
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(() => {
      (core.ErrorCode as { OK: number }).OK = 5;
    }).toThrow(TypeError);
  });
});

describe("host message modes", () => {
  it("name the numbers the server sends", async () => {
    const { HostMessageMode } = await import("./index.js");
    expect({ ...HostMessageMode }).toEqual({ None: 0, Log: 1, Modal: 2, ModalQuit: 3 });
  });
});

describe("error names", () => {
  it("are on the prototype, not an own enumerable property", async () => {
    const { TeamspeakError, CommandTimeoutError, NotConnectedError, NoDataError } =
      await import("./errors.js");
    const errors = [
      new TeamspeakError("x"),
      new ServerError(1, "bad"),
      new CommandTimeoutError("c"),
      new NotConnectedError(),
      new NoDataError("c"),
    ];
    for (const err of errors) {
      expect(Object.keys(err)).not.toContain("name");
      expect(Object.hasOwn(err, "name")).toBe(false);
      expect(err.name).toBe((err.constructor as unknown as { kind: string }).kind);
      expect(JSON.parse(JSON.stringify(err))).not.toHaveProperty("name");
    }
    const server = new ServerError(1, "bad");
    expect(String(server)).toBe("ServerError: TeamSpeak server error: bad (code 1)");
  });
});
