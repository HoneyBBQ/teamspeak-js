import { describe, expect, it } from "vitest";
import { handleNotification } from "./notifications.js";
import { applyClientChanges } from "./api/clients.js";
import { parseChannel } from "./api/command.js";
import { parseClient, parseClientChanges } from "./api/parse.js";
import type { ClientEntry } from "./api/clients.js";

// Payloads are the ones TS3 3.13.8 and TS6 6.0.0-beta13.1 sent.

const read = (
  name: string,
  params: Record<string, string>,
  clients = new Map<number, ClientEntry>(),
) => handleNotification({ name, params }, 1, clients);

describe("the channel a client came from and went to", () => {
  it("reads cfid on a TS6 move, and leaves it absent on a TS3 move", () => {
    const ts6 = read("notifyclientmoved", { cfid: "1", ctid: "9", reasonid: "1", clid: "7" });
    const ts3 = read("notifyclientmoved", { ctid: "9", reasonid: "1", clid: "7" });
    expect(ts6.kind === "clientMoved" && ts6.event.fromChannelID).toBe(1n);
    expect(ts6.kind === "clientMoved" && ts6.event.targetChannelID).toBe(9n);
    expect(ts3.kind === "clientMoved" && ts3.event.fromChannelID).toBeUndefined();
    expect(ts3.kind === "clientMoved" && "fromChannelID" in ts3.event).toBe(false);
  });

  it("reads cfid and ctid on a leave; ctid 0 is a client that left the server", () => {
    const left = read("notifyclientleftview", {
      cfid: "1",
      ctid: "0",
      reasonid: "8",
      reasonmsg: "Shutdown",
      clid: "7",
    });
    expect(left.kind === "clientLeave" && left.event.fromChannelID).toBe(1n);
    expect(left.kind === "clientLeave" && left.event.targetChannelID).toBe(0n);
    const bare = read("notifyclientleftview", { clid: "7", reasonid: "3" });
    expect(bare.kind === "clientLeave" && bare.event.fromChannelID).toBeUndefined();
    expect(bare.kind === "clientLeave" && bare.event.targetChannelID).toBeUndefined();
  });
});

describe("notifyclientchatclosed", () => {
  it("reads who closed the chat", () => {
    expect(read("notifyclientchatclosed", { clid: "16", cluid: "HM1D=" })).toEqual({
      kind: "clientChatClosed",
      event: { clientID: 16, uid: "HM1D=" },
    });
    expect(read("notifyclientchatclosed", { cluid: "x" }).kind).toBe("unknown");
  });
});

describe("notifycliententerview", () => {
  const enter = { clid: "7", ctid: "1", client_nickname: "A", client_unique_identifier: "u=" };

  it("carries where the client came from and why, on the event only", () => {
    const clients = new Map<number, ClientEntry>();
    const result = read("notifycliententerview", { cfid: "0", reasonid: "2", ...enter }, clients);
    expect(result.kind === "clientEnter" && result.info).toMatchObject({
      id: 7,
      nickname: "A",
      fromChannelID: 0n,
      reason: 2,
    });
    const stored = clients.get(7)!;
    expect(stored.nickname).toBe("A");
    expect("fromChannelID" in stored).toBe(false);
    expect("reason" in stored).toBe(false);
  });

  it("leaves both absent when the notification names neither", () => {
    const result = read("notifycliententerview", enter);
    expect(result.kind === "clientEnter" && "fromChannelID" in result.info).toBe(false);
    expect(result.kind === "clientEnter" && "reason" in result.info).toBe(false);
  });
});

describe("the talk request time", () => {
  it("reads client_talk_request as a time, and 0 as none", () => {
    expect(parseClient({ clid: "5", client_talk_request: "1792335820" }).talkRequestedAt).toEqual(
      new Date(1792335820 * 1000),
    );
    expect(parseClient({ clid: "5", client_talk_request: "0" }).talkRequestedAt).toBeUndefined();
  });

  it("clears it when the request is withdrawn", () => {
    const entry = parseClient({ clid: "5", client_talk_request: "1792335820" });
    const withdrawn = applyClientChanges(
      entry,
      parseClientChanges({ clid: "5", client_talk_request: "0", client_talk_request_msg: "" }),
    );
    expect(withdrawn.isRequestingTalk).toBe(false);
    expect(withdrawn.talkRequestedAt).toBeUndefined();
  });
});

describe("the channel's empty time, quota and path", () => {
  it("reads seconds_empty as milliseconds for an empty channel and not at all for an occupied one", () => {
    expect(parseChannel({ cid: "2", seconds_empty: "358" }).emptyForMs).toBe(358_000);
    expect(parseChannel({ cid: "2", seconds_empty: "0" }).emptyForMs).toBe(0);
    expect(parseChannel({ cid: "1", seconds_empty: "-1" }).emptyForMs).toBeUndefined();
    expect(parseChannel({ cid: "1" }).emptyForMs).toBeUndefined();
  });

  it("reads the storage quota and file path where the row has them", () => {
    const ts6 = parseChannel({
      cid: "2",
      channel_storage_quota: "4294967295",
      channel_filepath: "files/virtualserver_1/channel_2",
    });
    expect(ts6.storageQuota).toBe(4294967295);
    expect(ts6.filePath).toBe("files/virtualserver_1/channel_2");
    expect(parseChannel({ cid: "2" }).storageQuota).toBeUndefined();
  });
});
