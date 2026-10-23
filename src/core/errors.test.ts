import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "./errorcode.js";
import fc from "fast-check";
import { ServerError, floodRetryDelayMs, parseErrorCode, parseServerError } from "./errors.js";

describe("parseServerError", () => {
  it("reads a permission named by WebQuery apart from an id", () => {
    const { err } = parseServerError({
      id: "2568",
      msg: "insufficient client permissions",
      failed_permission: "b_serverinstance_info_view",
    });
    expect(err?.failedPermission).toBe("b_serverinstance_info_view");
    expect(err?.failedPermissionID).toBeUndefined();
  });

  it("leaves failedPermission unset when the server named an id or none", () => {
    expect(parseServerError({ id: "2568", msg: "x", failed_permid: "236" }).err).toMatchObject({
      failedPermission: undefined,
      failedPermissionID: 236,
    });
    expect(parseServerError({ id: "1", msg: "x" }).err?.failedPermission).toBeUndefined();
  });

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

describe("reading an error line's numbers", () => {
  // The server sends unsigned 32-bit decimals. Anything else is not read as a
  // prefix or a wrapped value: "12abc" was error 12, and a 20-digit id some
  // code no one defined.
  it.each([
    "12abc",
    "",
    " 7",
    "7 ",
    "-1",
    "+5",
    "1.5",
    "0x10",
    "4294967296",
    "99999999999999999999",
  ])("reports the id %j as Undefined", (id) => {
    expect(parseErrorCode(id)).toBe(ErrorCode.Undefined);
    expect(parseServerError({ id, msg: "x" }).err?.code).toBe(ErrorCode.Undefined);
  });

  it("reads the edges, leading zeros included", () => {
    expect(parseErrorCode("2568")).toBe(2568);
    expect(parseErrorCode("4294967295")).toBe(4294967295);
    expect(parseErrorCode("0000000000000000000012")).toBe(12);
    expect(parseErrorCode(undefined)).toBe(ErrorCode.Undefined);
  });

  it("takes a return code only when it is an unsigned 32-bit number", () => {
    for (const rc of ["12abc", "", "-3", "1e3", "4294967296", " 4", "0x1"]) {
      expect(parseServerError({ id: "0", return_code: rc }).rc).toBeNull();
    }
    expect(parseServerError({ id: "0" }).rc).toBeNull();
    expect(parseServerError({ id: "0", return_code: "0" }).rc).toBe(0);
    expect(parseServerError({ id: "0", return_code: "4294967295" }).rc).toBe(4294967295);
  });

  it("takes a failed permission id the same way", () => {
    const failed = (id: string) =>
      parseServerError({ id: "2568", failed_permid: id }).err?.failedPermissionID;
    expect(failed("12abc")).toBeUndefined();
    expect(failed("4294967296")).toBeUndefined();
    expect(failed("00000000236")).toBe(236);
  });

  it("agrees with a strict reading for any text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (raw) => {
        const strict = /^[0-9]+$/.test(raw) && Number(raw) <= 0xffff_ffff;
        expect(parseErrorCode(raw)).toBe(strict ? Number(raw) : ErrorCode.Undefined);
        expect(parseServerError({ id: "0", return_code: raw }).rc).toBe(
          strict ? Number(raw) : null,
        );
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (id) => {
        expect(parseErrorCode(String(id))).toBe(id);
      }),
    );
  });
});

describe("floodRetryDelayMs", () => {
  const refusal = (id: string, extra?: string) =>
    parseServerError({ id, msg: "client is flooding", ...(extra ? { extra_msg: extra } : {}) })
      .err!;

  it("reads the wait of error 524", () => {
    expect(floodRetryDelayMs(refusal("524", "retry in 1985ms"))).toBe(1985);
    expect(floodRetryDelayMs(refusal("524", "retry in 0ms"))).toBe(0);
  });

  it("reads the wait a ServerQuery client is given, in whole seconds", () => {
    expect(floodRetryDelayMs(refusal("524", "please wait 1 seconds"))).toBe(1000);
    expect(floodRetryDelayMs(refusal("524", "please wait 600 seconds"))).toBe(600_000);
    expect(floodRetryDelayMs(refusal("524", "please wait 0 seconds"))).toBe(0);
  });

  it("is undefined for anything else", () => {
    expect(floodRetryDelayMs(refusal("524"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("524", "retry in 5 seconds"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("524", "retry in 99999999999ms"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("524", "please wait 1.5 seconds"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("524", "please wait seconds"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("524", "please wait 1 seconds now"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("3329", "please wait 5 seconds"))).toBeUndefined();
    expect(floodRetryDelayMs(refusal("1024", "retry in 10ms"))).toBeUndefined();
    expect(floodRetryDelayMs(new Error("retry in 10ms"))).toBeUndefined();
  });
});
