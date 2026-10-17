import { describe, it, expect } from "vitest";
import { handleNotification } from "./notifications.js";
import { applyChannelChanges } from "./api/command.js";
import type { Channel } from "./api/command.js";
import { Reason } from "./reason.js";
import type { ClientEnterEvent } from "@honeybbq/teamspeak";

// The payloads below are the ones TeamSpeak 3 and TeamSpeak 6 sent, with the
// two servers' differences kept as variants.

const read = (name: string, params: Record<string, string>) =>
  handleNotification({ name, params }, 1, new Map<number, ClientEnterEvent>());

const admin = { invokerid: "413", invokername: "b2-adm", invokeruid: "serveradmin" };

/** The keys of `changes`, none of which may hold `undefined`. */
function keysOf(changes: object): string[] {
  for (const [key, value] of Object.entries(changes)) expect(value, key).not.toBeUndefined();
  return Object.keys(changes).sort();
}

describe("notifychannelcreated", () => {
  it("reads a temporary channel: only the name and the order", () => {
    const result = read("notifychannelcreated", {
      cid: "247",
      cpid: "0",
      channel_name: "b2m-tmp",
      channel_order: "246",
      ...admin,
    });

    expect(result.kind).toBe("channelCreated");
    if (result.kind !== "channelCreated") return;
    expect(result.event).toMatchObject({
      channelID: 247n,
      parentID: 0n,
      invokerID: 413,
      invokerName: "b2-adm",
      invokerUID: "serveradmin",
    });
    expect(keysOf(result.event.changes)).toEqual(["name", "order", "parentID"]);
    expect(result.event.changes).toMatchObject({ name: "b2m-tmp", order: 246n });
  });

  it("reads a full channel, and a TeamSpeak 6 one with its unique id", () => {
    const result = read("notifychannelcreated", {
      cid: "9",
      cpid: "2",
      channel_name: "b2m-full",
      channel_topic: "tp",
      channel_codec_quality: "7",
      channel_maxclients: "5",
      channel_order: "3",
      channel_flag_permanent: "1",
      channel_unique_identifier: "96fd8883-d846-4c13-88a8-680c2d4cad19",
      ...admin,
    });

    expect(result.kind === "channelCreated" && result.event.parentID).toBe(2n);
    if (result.kind !== "channelCreated") return;
    expect(keysOf(result.event.changes)).toEqual([
      "codecQuality",
      "isPermanent",
      "maxClients",
      "name",
      "order",
      "parentID",
      "topic",
      "uid",
    ]);
    expect(result.event.changes.isPermanent).toBe(true);
    expect(result.event.changes.maxClients).toBe(5);
    // The server never sends the description of a new channel.
    expect("description" in result.event.changes).toBe(false);
  });

  it("merges into a record without erasing what it did not carry", () => {
    const result = read("notifychannelcreated", { cid: "9", cpid: "0", channel_name: "n" });
    if (result.kind !== "channelCreated") throw new Error("not created");
    const base = { id: 9n, name: "", topic: "kept", isPermanent: false } as unknown as Channel;

    const next = applyChannelChanges(base, result.event.changes);

    expect(next).toMatchObject({ name: "n", topic: "kept", isPermanent: false });
  });

  it("is dropped without a channel", () => {
    expect(read("notifychannelcreated", { cpid: "0", channel_name: "n" }).kind).toBe("unknown");
    expect(read("notifychannelcreated", { cid: "0", channel_name: "n" }).kind).toBe("unknown");
  });
});

describe("notifychanneledited", () => {
  it("carries only the topic that changed", () => {
    const result = read("notifychanneledited", {
      cid: "244",
      reasonid: "10",
      ...admin,
      channel_topic: "t2",
    });

    expect(result.kind).toBe("channelEdited");
    if (result.kind !== "channelEdited") return;
    expect(result.event).toMatchObject({
      channelID: 244n,
      reason: Reason.ChannelEdit,
      invokerName: "b2-adm",
    });
    expect(keysOf(result.event.changes)).toEqual(["topic"]);
  });

  it("carries no keys for a description change, and says so on the next event", () => {
    const edited = read("notifychanneledited", { cid: "244", reasonid: "10", ...admin });
    const changed = read("notifychanneldescriptionchanged", { cid: "244" });

    expect(edited.kind === "channelEdited" && keysOf(edited.event.changes)).toEqual([]);
    expect(changed).toEqual({ kind: "channelDescriptionChanged", event: { channelID: 244n } });
  });

  it("carries the password flag only as it flips, and a limit change with the flag it sets", () => {
    const password = read("notifychanneledited", {
      cid: "244",
      reasonid: "10",
      ...admin,
      channel_flag_password: "0",
    });
    const limits = read("notifychanneledited", {
      cid: "246",
      reasonid: "10",
      ...admin,
      channel_codec_quality: "5",
      channel_maxclients: "8",
      channel_flag_maxclients_unlimited: "0",
    });

    expect(password.kind === "channelEdited" && password.event.changes).toEqual({
      hasPassword: false,
    });
    expect(limits.kind === "channelEdited" && keysOf(limits.event.changes)).toEqual([
      "codecQuality",
      "isMaxClientsUnlimited",
      "maxClients",
    ]);
    expect(read("notifychannelpasswordchanged", { cid: "244" })).toEqual({
      kind: "channelPasswordChanged",
      event: { channelID: 244n },
    });
  });

  describe("reason 9", () => {
    // The answer to channelgetdescription, as both servers send it.
    const answer = { cid: "244", channel_description: "initial desc", reasonid: "9" };

    it("is the answer to a description fetch, not an edit", () => {
      expect(read("notifychanneledited", answer).kind).toBe("unknown");
      expect(read("notifychanneledited", { ...answer, channel_description: "" }).kind).toBe(
        "unknown",
      );
    });

    it("is an edit when it names an invoker, or carries another reason", () => {
      expect(read("notifychanneledited", { ...answer, ...admin }).kind).toBe("channelEdited");
      expect(read("notifychanneledited", { ...answer, reasonid: "10" }).kind).toBe("channelEdited");
      expect(read("notifychanneledited", { cid: "244", channel_topic: "x" }).kind).toBe(
        "channelEdited",
      );
    });

    it("is judged by its content, however many commands wait", () => {
      // The same row twice gives the same answer: there is no state to differ.
      expect(read("notifychanneledited", answer).kind).toBe("unknown");
      expect(read("notifychanneledited", { ...answer, invokerid: "0" }).kind).toBe("channelEdited");
    });
  });

  it("is dropped without a channel", () => {
    expect(read("notifychanneledited", { reasonid: "10", channel_topic: "x" }).kind).toBe(
      "unknown",
    );
  });
});

describe("notifychannelmoved", () => {
  it("reads the parent, the order and the reason", () => {
    const result = read("notifychannelmoved", {
      cid: "244",
      cpid: "2",
      order: "0",
      reasonid: "1",
      ...admin,
    });

    expect(result).toEqual({
      kind: "channelMoved",
      event: {
        channelID: 244n,
        parentID: 2n,
        order: 0n,
        reason: 1,
        invokerID: 413,
        invokerName: "b2-adm",
        invokerUID: "serveradmin",
      },
    });
  });

  it("moves to the top level under parent 0", () => {
    const result = read("notifychannelmoved", { cid: "244", cpid: "0", order: "0", reasonid: "1" });
    expect(result.kind === "channelMoved" && result.event.parentID).toBe(0n);
  });
});

describe("notifychanneldeleted", () => {
  it("names the admin who deleted the channel", () => {
    const result = read("notifychanneldeleted", { ...admin, cid: "246" });
    expect(result.kind === "channelDeleted" && result.event).toEqual({
      channelID: 246n,
      invokerID: 413,
      invokerName: "b2-adm",
      invokerUID: "serveradmin",
    });
  });

  it("names the server when an empty temporary channel expired", () => {
    const result = read("notifychanneldeleted", {
      invokerid: "0",
      invokername: "Server",
      cid: "243",
    });
    expect(result.kind === "channelDeleted" && result.event).toEqual({
      channelID: 243n,
      invokerID: 0,
      invokerName: "Server",
      invokerUID: "",
    });
  });
});

describe("notifyserveredited", () => {
  it("reads TeamSpeak 3, which sends a reason, and keeps only the server's properties", () => {
    const result = read("notifyserveredited", {
      reasonid: "10",
      ...admin,
      virtualserver_name: "b2 name",
      virtualserver_hostbanner_url: "http://x.invalid",
    });

    expect(result.kind === "serverEdited" && result.event).toEqual({
      changes: { virtualserver_name: "b2 name", virtualserver_hostbanner_url: "http://x.invalid" },
      invokerID: 413,
      invokerName: "b2-adm",
      invokerUID: "serveradmin",
    });
  });

  it("reads TeamSpeak 6, which sends none, and a welcome message change with no property", () => {
    const named = read("notifyserveredited", {
      ...admin,
      virtualserver_name: "TeamSpeak 6 Server",
    });
    const welcome = read("notifyserveredited", admin);

    expect(named.kind === "serverEdited" && named.event.changes).toEqual({
      virtualserver_name: "TeamSpeak 6 Server",
    });
    expect(welcome.kind === "serverEdited" && welcome.event.changes).toEqual({});
  });
});

describe("the voice-only notifications", () => {
  it("reads subscribed and unsubscribed, and ignores the seconds a subscribed channel was empty", () => {
    expect(read("notifychannelsubscribed", { cid: "240", es: "3" })).toEqual({
      kind: "channelSubscribed",
      event: { channelID: 240n },
    });
    expect(read("notifychannelunsubscribed", { cid: "240" })).toEqual({
      kind: "channelUnsubscribed",
      event: { channelID: 240n },
    });
    expect(read("notifychannelsubscribed", { es: "3" }).kind).toBe("unknown");
    expect(read("notifychannelunsubscribed", { cid: "0" }).kind).toBe("unknown");
  });

  it("reads a plugin command with its sender, unescaping nothing further", () => {
    const result = read("notifyplugincmd", {
      name: "b2 plug",
      data: "a b|c/d",
      invokerid: "414",
      invokername: "b2-B",
      invokeruid: "3uqfDxx4tyjGikeopsVuxsmmiW8=",
    });

    expect(result.kind === "pluginCommand" && result.event).toEqual({
      name: "b2 plug",
      data: "a b|c/d",
      invokerID: 414,
      invokerName: "b2-B",
      invokerUID: "3uqfDxx4tyjGikeopsVuxsmmiW8=",
    });
  });

  it("reads an empty payload as empty", () => {
    const result = read("notifyplugincmd", { name: "p", data: "", invokerid: "414" });
    expect(result.kind === "pluginCommand" && result.event.data).toBe("");
  });

  it("reads who is typing", () => {
    expect(
      read("notifyclientchatcomposing", { clid: "414", cluid: "3uqfDxx4tyjGikeopsVuxsmmiW8=" }),
    ).toEqual({
      kind: "clientChatComposing",
      event: { clientID: 414, uid: "3uqfDxx4tyjGikeopsVuxsmmiW8=" },
    });
    expect(read("notifyclientchatcomposing", { cluid: "x" }).kind).toBe("unknown");
  });
});

describe("the roster", () => {
  it("is left alone by every one of them", () => {
    const clients = new Map<number, ClientEnterEvent>();
    handleNotification(
      { name: "notifycliententerview", params: { clid: "7", ctid: "3", client_nickname: "A" } },
      1,
      clients,
    );
    const before = clients.get(7);

    for (const [name, params] of [
      ["notifychannelcreated", { cid: "3", cpid: "0", channel_name: "n" }],
      ["notifychanneledited", { cid: "3", reasonid: "10", channel_topic: "t" }],
      ["notifychannelmoved", { cid: "3", cpid: "0", order: "0" }],
      ["notifychanneldeleted", { cid: "3" }],
      ["notifyserveredited", { virtualserver_name: "n" }],
      ["notifyclientchatcomposing", { clid: "7" }],
      ["notifyplugincmd", { name: "p", data: "d", invokerid: "7" }],
    ] as const) {
      handleNotification({ name, params: { ...params } }, 1, clients);
    }

    expect(clients.size).toBe(1);
    expect(clients.get(7)).toBe(before);
  });
});
