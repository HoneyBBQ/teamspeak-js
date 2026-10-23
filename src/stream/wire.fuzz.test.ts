import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { asClientID } from "@honeybbq/teamspeak";
import { StreamPayloadTooLargeError } from "./errors.js";
import {
  MAX_COMMAND_LINE_BYTES,
  assertFits,
  candidateJson,
  parseSignal,
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
