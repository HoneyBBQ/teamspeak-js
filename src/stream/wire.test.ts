import { describe, expect, it } from "vitest";
import { asClientID, escape } from "@honeybbq/teamspeak";
import { StreamPayloadTooLargeError } from "./errors.js";
import {
  MAX_COMMAND_LINE_BYTES,
  accessibilityToWire,
  assertFits,
  candidateJson,
  parseSignal,
  reasonOf,
  respondRequest,
  setupRequest,
  signalRequest,
  sourceToWire,
  streamInfoFrom,
} from "./wire.js";

describe("value tables", () => {
  it("number the names as the server does", () => {
    expect(["none", "camera", "screen", "window", "session"].map(sourceToWire)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(["none", "public", "contacts", "private"].map(accessibilityToWire)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(sourceToWire("hologram")).toBeUndefined();
    expect(accessibilityToWire("secret")).toBeUndefined();
  });

  // The server stores any integer, so a stream from another client may carry one.
  it("pass a number with no name through", () => {
    const info = streamInfoFrom(
      { id: "a", clid: "2", type: "9", accessibility: "4", mode: "2" },
      undefined,
    );
    expect(info?.source).toBe(9);
    expect(info?.accessibility).toBe(4);
    expect(info?.transport).toBe(2);
  });
});

describe("setupRequest", () => {
  it("sends all seven parameters, in peer to peer mode", () => {
    const request = setupRequest({
      name: "n",
      source: 2,
      bitrate: 1,
      accessibility: 1,
      viewerLimit: 0,
      audio: false,
    });
    expect(request.params?.map(([k]) => k)).toEqual([
      "name",
      "type",
      "bitrate",
      "accessibility",
      "mode",
      "viewer_limit",
      "audio",
    ]);
    expect(request.params?.find(([k]) => k === "mode")?.[1]).toBe(1);
  });
});

describe("respondRequest", () => {
  // Without an offer the server answers 1542, a refusal included.
  it("always carries the offer, empty on a refusal", () => {
    const deny = respondRequest("id", asClientID(3), "no", "", false);
    expect(deny.params?.find(([k]) => k === "offer")).toEqual(["offer", ""]);
    expect(deny.params?.find(([k]) => k === "decision")).toEqual(["decision", false]);
  });
});

describe("parseSignal", () => {
  it("reads an answer", () => {
    expect(parseSignal('{"cmd":"answer","args":{"answer":"v=0\\r\\n"}}')).toEqual({
      kind: "answer",
      sdp: "v=0\r\n",
    });
  });

  it("reads an ICE candidate, with the browser's field names", () => {
    const json = '{"cmd":"iceCandidate","args":{"sdp":"candidate:1","mid":"0","mLine":0}}';
    expect(parseSignal(json)).toEqual({
      kind: "candidate",
      candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
    });
  });

  it("reads a candidate without a mid or a line as null", () => {
    const parsed = parseSignal('{"cmd":"iceCandidate","args":{"sdp":"c"}}');
    expect(parsed).toEqual({
      kind: "candidate",
      candidate: { candidate: "c", sdpMid: null, sdpMLineIndex: null },
    });
  });

  it.each([
    ["a string", '{"cmd":"offer","args":"sdp"}'],
    ["an offer key", '{"cmd":"offer","args":{"offer":"sdp"}}'],
    ["an sdp key", '{"cmd":"reconnectOffer","args":{"sdp":"sdp"}}'],
  ])("reads a renegotiation offer given as %s", (_name, json) => {
    expect(parseSignal(json)).toEqual({ kind: "offer", sdp: "sdp" });
  });

  // A wrong shape is relayed by the server and dropped by the receiver, so it
  // must come out as something the application can see.
  it.each([
    ["an answer as a bare string", '{"cmd":"answer","args":"sdp"}', "answer"],
    ["an answer under the wrong key", '{"cmd":"answer","args":{"sdp":"sdp"}}', "answer"],
    ["a candidate without a line", '{"cmd":"iceCandidate","args":{"mid":"0"}}', "iceCandidate"],
    ["a command it does not know", '{"cmd":"mute","args":{"on":true}}', "mute"],
  ])("hands over %s as a raw signal", (_name, json, cmd) => {
    const parsed = parseSignal(json);
    expect(parsed.kind).toBe("raw");
    if (parsed.kind === "raw") {
      expect(parsed.signal.cmd).toBe(cmd);
      expect(parsed.signal.json).toBe(json);
    }
  });

  it.each(["not json", "", "[1,2]", "null", '"text"', '{"args":{}}', '{"cmd":7}'])(
    "hands over %j, which is no signalling message, with its text",
    (json) => {
      const parsed = parseSignal(json);
      expect(parsed.kind).toBe("raw");
      if (parsed.kind === "raw") {
        expect(parsed.signal.cmd).toBe("");
        expect(parsed.signal.json).toBe(json);
      }
    },
  );

  it("survives the escaper with an SDP's whitespace, pipes and quotes", () => {
    const candidate = {
      candidate: 'a b|c\\d/e"f\r\n日本 ü',
      sdpMid: "audio",
      sdpMLineIndex: 1,
    };
    const request = signalRequest("id", asClientID(2), candidateJson(candidate));
    const line = String(request.params?.find(([k]) => k === "json")?.[1]);
    expect(parseSignal(line)).toEqual({ kind: "candidate", candidate });
    expect(escape(line)).not.toMatch(/[ |\r\n]/);
  });
});

describe("streamInfoFrom", () => {
  it("reads the announcement, which names the accessibility `access`", () => {
    const info = streamInfoFrom(
      {
        clid: "5",
        id: "u-1",
        name: "Demo",
        type: "2",
        access: "1",
        mode: "1",
        bitrate: "58208",
        viewer_limit: "0",
        audio: "1",
      },
      undefined,
    );
    expect(info).toEqual({
      id: "u-1",
      clientId: 5,
      name: "Demo",
      source: "screen",
      audio: true,
      bitrate: 58208,
      accessibility: "public",
      transport: "p2p",
      viewerLimit: 0,
      viewers: undefined,
    });
  });

  it("reads the info, which adds the viewers and keeps what it lacks", () => {
    const known = streamInfoFrom({ clid: "5", id: "u-1", name: "Demo", type: "3" }, undefined);
    const info = streamInfoFrom({ id: "u-1", viewer: "2", accessibility: "3" }, known);
    expect(info?.viewers).toBe(2);
    expect(info?.accessibility).toBe("private");
    expect(info?.name).toBe("Demo");
    expect(info?.source).toBe("window");
    expect(info?.clientId).toBe(5);
  });

  it("keeps the mode it knew when a row lacks it, and takes a new one", () => {
    const known = streamInfoFrom({ clid: "5", id: "u-1", mode: "1" }, undefined);
    expect(known?.transport).toBe("p2p");
    expect(streamInfoFrom({ id: "u-1" }, known)?.transport).toBe("p2p");
    expect(streamInfoFrom({ id: "u-1", mode: "2" }, known)?.transport).toBe(2);
    expect(streamInfoFrom({ id: "u-1" }, undefined)?.transport).toBeUndefined();
    expect(streamInfoFrom({ id: "u-1", mode: "x" }, undefined)?.transport).toBeUndefined();
  });

  // The server answers a client that streams nothing with a bare row.
  it("takes the empty answer as no stream", () => {
    expect(streamInfoFrom({ return_code: "4" }, undefined)).toBeUndefined();
    expect(streamInfoFrom({ id: "" }, undefined)).toBeUndefined();
  });
});

describe("assertFits", () => {
  const offer = (n: number): string => "a".repeat(n);
  const line = (n: number) => respondRequest("id", asClientID(2), "", offer(n), true);

  it("lets an offer of a few kilobytes through", () => {
    expect(() => assertFits(line(4000))).not.toThrow();
  });

  it("measures the escaped line, not the characters", () => {
    // 3,000 spaces are 6,000 bytes escaped, so 5,000 of them are over.
    const spaces = (n: number) => respondRequest("id", asClientID(2), "", " ".repeat(n), true);
    expect(() => assertFits(spaces(3000))).not.toThrow();
    expect(() => assertFits(spaces(5000))).toThrow(StreamPayloadTooLargeError);
  });

  it("refuses a line over the limit, saying how big it is", () => {
    try {
      assertFits(line(MAX_COMMAND_LINE_BYTES));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StreamPayloadTooLargeError);
      const err = error as StreamPayloadTooLargeError;
      expect(err.command).toBe("respondjoinstreamrequest");
      expect(err.limit).toBe(MAX_COMMAND_LINE_BYTES);
      expect(err.size).toBeGreaterThan(MAX_COMMAND_LINE_BYTES);
    }
  });

  it("counts UTF-8 bytes", () => {
    // Three bytes each: 3,100 of them are over the limit though they are few characters.
    expect(() =>
      assertFits(respondRequest("id", asClientID(2), "", "日".repeat(3100), true)),
    ).toThrow(StreamPayloadTooLargeError);
  });
});

describe("unsigned wire numbers", () => {
  it("read a type, accessibility and mode as an unsigned 32-bit number, as the Go SDK does", () => {
    const read = (value: string): unknown =>
      streamInfoFrom({ id: "a", type: value, accessibility: value, mode: value }, undefined);
    const of = (value: string) => {
      const info = read(value) as ReturnType<typeof streamInfoFrom>;
      return [info?.source, info?.accessibility, info?.transport];
    };
    expect(of("4294967295")).toEqual([4294967295, 4294967295, 4294967295]);
    for (const bad of ["4294967296", "-1", "+1", "1.5", "", "1234567890123456", "0x1"]) {
      expect(of(bad)).toEqual([undefined, undefined, undefined]);
    }
  });

  it("read a stop reason the same way", () => {
    expect(reasonOf({ reason: "4294967295" })).toBe(4294967295);
    expect(reasonOf({ reason: "4294967296" })).toBe(0);
    expect(reasonOf({ reason: "-3" })).toBe(0);
    expect(reasonOf({})).toBe(0);
    expect(reasonOf({ reason: "0000000000000000007" })).toBe(7);
  });

  it("read a candidate's media section index as an unsigned 16-bit number", () => {
    const line = (value: string): unknown =>
      (
        parseSignal(`{"cmd":"iceCandidate","args":{"sdp":"c","mLine":${value}}}`) as {
          candidate: { sdpMLineIndex: number | null };
        }
      ).candidate.sdpMLineIndex;
    expect(line("0")).toBe(0);
    expect(line("65535")).toBe(65535);
    expect(line("65536")).toBeNull();
    expect(line("-1")).toBeNull();
    expect(line("-0")).toBeNull();
    expect(line("1.5")).toBeNull();
    expect(line('"1"')).toBeNull();
  });
});
