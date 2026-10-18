import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { handleNotification } from "./notifications.js";
import type { ClientEnterEvent } from "@honeybbq/teamspeak";

// Property tests over the notifications a server pushes. Every field comes
// from the network, so a notification of any shape must be read without
// throwing, and must change the client list only as it says it does.

const NAMES = [
  "notifycliententerview",
  "notifyclientleftview",
  "notifyclientmoved",
  "notifytextmessage",
  "notifyclientpoke",
  "notifyclientupdated",
  "notifyservergroupclientadded",
  "notifyservergroupclientdeleted",
  "notifyclientchannelgroupchanged",
  "notifychannelcreated",
  "notifychanneledited",
  "notifychannelmoved",
  "notifychanneldeleted",
  "notifychanneldescriptionchanged",
  "notifychannelpasswordchanged",
  "notifyserveredited",
  "notifychannelsubscribed",
  "notifychannelunsubscribed",
  "notifyplugincmd",
  "notifyclientchatcomposing",
  "notifyunknown",
] as const;

const KEYS = [
  "clid",
  "ctid",
  "cid",
  "target",
  "invokerid",
  "reasonid",
  "targetmode",
  "client_nickname",
  "client_unique_identifier",
  "client_type",
  "client_servergroups",
  "client_channel_group_id",
  "client_created",
  "client_lastconnected",
  "client_idle_time",
  "client_away",
  "msg",
  "invokername",
  "invokeruid",
  "reasonmsg",
  "sgid",
  "cgid",
  "cgi",
  "cluid",
  "name",
  "client_talk_power",
  "client_away_message",
  "client_input_muted",
  "client_icon_id",
  "client_talk_request",
  "cpid",
  "order",
  "data",
  "channel_name",
  "channel_flag_password",
  "channel_codec_quality",
  "channel_delete_delay",
  "virtualserver_name",
  "virtualserver_welcomemessage",
] as const;

/**
 * A value of any of the shapes the fields take: an id in range, none, text
 * that is not a number, a number with a fraction or an exponent, a group list.
 * A sign, a hex prefix or a width past 64 bits is left for the test of
 * ctid below, which is where such a value is read.
 */
const text = fc.oneof(
  fc.constant(""),
  fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map(String),
  fc.integer({ min: 0, max: 70_000 }).map(String),
  fc.constantFrom("abc", "1.5", "1e3", "--1", "1,2,x,3", "6,,7", "99999999999999999999,6"),
  fc.string({ unit: "binary", maxLength: 30 }).filter((s) => !/^\s*[-+]?(0[xXoObB])?\d/.test(s)),
);

const notification = fc.record({
  name: fc.constantFrom(...NAMES),
  params: fc
    .dictionary(fc.constantFrom(...KEYS), text, { maxKeys: KEYS.length })
    .map((dict) => Object.assign(Object.create(null) as Record<string, string>, dict)),
});

const known = fc.dictionary(
  fc.integer({ min: 1, max: 20 }),
  fc.record({
    id: fc.integer({ min: 1, max: 20 }),
    nickname: fc.string({ maxLength: 8 }),
  }),
);

/** A client list with the clients a test needs to exist already. */
function listOf(
  entries: Record<string, { id: number; nickname: string }>,
): Map<number, ClientEnterEvent> {
  const clients = new Map<number, ClientEnterEvent>();
  for (const [id, entry] of Object.entries(entries)) {
    clients.set(Number(id), {
      id: Number(id),
      nickname: entry.nickname,
      uid: "",
      channelID: 1n,
      type: 0,
      serverGroups: [6n],
      isAway: false,
      isRecording: false,
      isTalker: false,
      channelGroupID: 0n,
      createdAt: undefined,
      lastConnectedAt: undefined,
      idleTimeMs: undefined,
    } as unknown as ClientEnterEvent);
  }
  return clients;
}

describe("notifications from the server", () => {
  it("are read without throwing, whatever their fields", () => {
    fc.assert(
      fc.property(notification, known, fc.integer({ min: 0, max: 20 }), (cmd, entries, self) => {
        const clients = listOf(entries);
        const before = new Set(clients.keys());
        const result = handleNotification(cmd, self, clients);

        // The client list gains at most the client that entered, and loses
        // at most the one that left; nothing else touches its keys.
        const gained = [...clients.keys()].filter((id) => !before.has(id));
        const lost = [...before].filter((id) => !clients.has(id));
        if (result.kind === "clientEnter") {
          expect(result.info.id).toBeGreaterThanOrEqual(1);
          expect(result.info.id).toBeLessThanOrEqual(65535);
          // The roster keeps the record without what only the event carries.
          const { fromChannelID: _from, reason: _reason, ...record } = result.info;
          expect(clients.get(result.info.id)).toEqual(record);
          expect(Object.keys(clients.get(result.info.id) ?? {})).not.toContain("reason");
          expect(gained.length).toBeLessThanOrEqual(1);
          expect(lost).toEqual([]);
        } else if (result.kind === "clientLeave") {
          expect(clients.has(result.event.clientID)).toBe(false);
          expect(result.isSelf).toBe(result.event.clientID === self);
          expect(gained).toEqual([]);
          expect(lost.length).toBeLessThanOrEqual(1);
        } else {
          expect(gained).toEqual([]);
          expect(lost).toEqual([]);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it("move a known client to the channel they name, and only that client", () => {
    fc.assert(
      fc.property(
        known,
        fc.integer({ min: 1, max: 20 }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (entries, clid, ctid) => {
          const clients = listOf(entries);
          const others = new Map([...clients].map(([id, c]) => [id, c.channelID]));
          const params = Object.assign(Object.create(null) as Record<string, string>, {
            clid: String(clid),
            ctid: String(ctid),
          });
          const result = handleNotification({ name: "notifyclientmoved", params }, 0, clients);

          expect(result.kind).toBe("clientMoved");
          for (const [id, client] of clients) {
            expect(client.channelID).toBe(id === clid ? ctid : others.get(id));
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("give a text message the groups of the client it came from", () => {
    fc.assert(
      fc.property(
        known,
        fc.integer({ min: 0, max: 20 }),
        fc.string({ unit: "binary", maxLength: 20 }),
        (entries, invoker, msg) => {
          const clients = listOf(entries);
          const params = Object.assign(Object.create(null) as Record<string, string>, {
            invokerid: String(invoker),
            msg,
          });
          const result = handleNotification({ name: "notifytextmessage", params }, 0, clients);

          expect(result.kind).toBe("textMessage");
          if (result.kind !== "textMessage") return;
          expect(result.message.message).toBe(msg);
          expect(result.message.invokerGroups).toEqual(clients.get(invoker)?.serverGroups);
        },
      ),
      { numRuns: 500 },
    );
  });

  // handleClientMoved reads ctid with parseUint64, and asChannelID refuses what
  // is not 0 to 2^64-1 with a RangeError. A throw there would drop the rest of
  // the datagram's rows, and fail a connection still being set up.
  it("read a channel id out of range as 0 instead of throwing", () => {
    for (const ctid of ["-1", "18446744073709551616", "0x1ffffffffffffffff"]) {
      const params = Object.assign(Object.create(null) as Record<string, string>, {
        clid: "1",
        ctid,
      });
      expect(() =>
        handleNotification({ name: "notifyclientmoved", params }, 0, new Map()),
      ).not.toThrow();
    }
  });
});
