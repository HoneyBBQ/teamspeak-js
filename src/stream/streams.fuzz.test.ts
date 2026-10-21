import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Streams } from "./streams.js";
import { FakeClient, settle } from "./testing/fake-client.js";

// Property tests over what a server pushes at a Streams: notifications of any
// shape, in any order, must be taken without throwing and must leave it
// consistent: a stream listed has an id, and an ended stream is gone.

const NAMES = [
  "notifystreamstarted",
  "notifystreaminfo",
  "notifyjoinstreamrequest",
  "notifyrespondjoinstreamrequest",
  "notifystreamsignaling",
  "notifystreamclientjoined",
  "notifystreamclientleft",
  "notifystreamstopped",
  "notifyclientupdated",
  "notifyunknown",
] as const;

const KEYS = [
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
  "msg",
  "is_remove",
  "decision",
  "offer",
  "json",
  "reason",
  "return_code",
] as const;

const ids = fc.constantFrom("a", "b", "", "c d");
const value = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constantFrom("0", "1", "2", "7", "9", "-1", "65536", "99999999999999999999"),
  ids,
);
const params = fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 8 });
const notification = fc.record({ name: fc.constantFrom(...NAMES), params });

describe("Streams", () => {
  it("takes notifications of any shape without throwing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(notification, { maxLength: 40 }), async (notes) => {
        const client = new FakeClient();
        const streams = new Streams(client);
        const pub = streams.publish({ name: "mine" });
        pub.catch(() => {});
        await settle();
        for (const { name, params: p } of notes) client.notify(name, { ...p });
        await settle();
        for (const info of streams.list()) expect(info.id).not.toBe("");
        client.emit("disconnected", { error: undefined, willReconnect: false });
        expect(streams.list()).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("never sends stopstream for a stream it did not publish", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(notification, { maxLength: 40 }), async (notes) => {
        const client = new FakeClient();
        const streams = new Streams(client);
        for (const { name, params: p } of notes) client.notify(name, { ...p });
        streams.dispose();
        await settle();
        expect(client.commands("stopstream")).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
