import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { asClientID } from "@honeybbq/teamspeak";
import { StreamPayloadTooLargeError } from "./errors.js";
import {
  MAX_COMMAND_LINE_BYTES,
  assertFits,
  candidateJson,
  parseSignal,
  reasonOf,
  signalRequest,
  streamInfoFrom,
} from "./wire.js";

// Property tests over what the network hands the stream code: any text may
// arrive as a signalling message and any parameters as a notification.

describe("parseSignal", () => {
  it("never throws, and hands over what it cannot read with its text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (json) => {
        const parsed = parseSignal(json);
        if (parsed.kind === "raw") expect(parsed.signal.json).toBe(json);
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on JSON of any shape", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const parsed = parseSignal(JSON.stringify(value));
        expect(["offer", "answer", "candidate", "raw"]).toContain(parsed.kind);
      }),
      { numRuns: 500 },
    );
  });

  it("returns every candidate it sends, whatever its text", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.option(fc.string({ maxLength: 10 }), { nil: null }),
        fc.option(fc.nat({ max: 20 }), { nil: null }),
        (candidate, sdpMid, sdpMLineIndex) => {
          const parsed = parseSignal(candidateJson({ candidate, sdpMid, sdpMLineIndex }));
          expect(parsed).toEqual({
            kind: "candidate",
            candidate: { candidate, sdpMid, sdpMLineIndex },
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("streamInfoFrom", () => {
  const key = fc.constantFrom(
    "id",
    "clid",
    "name",
    "type",
    "access",
    "accessibility",
    "mode",
    "bitrate",
    "viewer_limit",
    "viewer",
    "audio",
    "return_code",
  );

  it("never throws on parameters of any shape", () => {
    fc.assert(
      fc.property(fc.dictionary(key, fc.string({ maxLength: 40 })), (params) => {
        const info = streamInfoFrom(params, undefined);
        if (info !== undefined) {
          expect(info.id).not.toBe("");
          expect(Number.isInteger(info.clientId)).toBe(true);
          const transport = info.transport;
          if (transport !== undefined && transport !== "p2p") {
            expect(Number.isInteger(transport)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("wire numbers", () => {
  it("accept a type, accessibility, mode and reason only as an unsigned 32-bit number", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (raw) => {
        const info = streamInfoFrom(
          { id: "a", type: raw, accessibility: raw, mode: raw },
          undefined,
        );
        for (const n of [info?.source, info?.accessibility, info?.transport]) {
          if (typeof n === "number") {
            expect(n).toBeGreaterThanOrEqual(0);
            expect(n).toBeLessThanOrEqual(0xffff_ffff);
            expect(raw).toMatch(/^\d+$/);
          }
        }
        const reason = reasonOf({ reason: raw });
        expect(reason).toBeGreaterThanOrEqual(0);
        expect(reason).toBeLessThanOrEqual(0xffff_ffff);
      }),
      { numRuns: 500 },
    );
  });

  it("accepts a candidate's media section index only as an unsigned 16-bit number", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (line) => {
        const parsed = parseSignal(
          JSON.stringify({ cmd: "iceCandidate", args: { sdp: "c", mLine: line } }),
        );
        if (parsed.kind !== "candidate") throw new Error("not a candidate");
        const index = parsed.candidate.sdpMLineIndex;
        if (index !== null) {
          expect(Number.isInteger(index)).toBe(true);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThanOrEqual(0xffff);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("assertFits", () => {
  // The check is on the escaped line: it throws exactly when the line is over.
  it("throws exactly for a signalling line over the limit", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12_000 }), (json) => {
        const request = signalRequest("id", asClientID(2), json);
        let size: number | undefined;
        try {
          assertFits(request);
        } catch (error) {
          expect(error).toBeInstanceOf(StreamPayloadTooLargeError);
          size = (error as StreamPayloadTooLargeError).size;
        }
        if (size !== undefined) expect(size).toBeGreaterThan(MAX_COMMAND_LINE_BYTES);
      }),
      { numRuns: 200 },
    );
  });
});
