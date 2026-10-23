import { describe, it, expect } from "vitest";
import { handleNotification } from "./notifications.js";
import type { ClientEnterEvent } from "@honeybbq/teamspeak";

function makeClients(): Map<number, ClientEnterEvent> {
  return new Map();
}

describe("handleNotification", () => {
  describe("notifycliententerview", () => {
    it("uses ctid as the client's channel ID", () => {
      const clients = makeClients();
      const cmd = {
        name: "notifycliententerview",
        params: {
          clid: "7",
          ctid: "42",
          client_nickname: "Alice",
          client_unique_identifier: "uid123",
          client_type: "0",
          client_servergroups: "6,9",
        },
      };

      const result = handleNotification(cmd, 1, clients);

      expect(result.kind).toBe("clientEnter");
      if (result.kind !== "clientEnter") return;
      expect(result.info.channelID).toBe(42n);
      expect(clients.get(7)?.channelID).toBe(42n);
    });
  });

  describe("notifyclientmoved", () => {
    it("carries the reason message, and an empty one without it", () => {
      const kick = {
        name: "notifyclientmoved",
        params: { clid: "7", ctid: "1", reasonmsg: "bye" },
      };
      const plain = { name: "notifyclientmoved", params: { clid: "7", ctid: "1" } };

      const a = handleNotification(kick, 1, makeClients());
      const b = handleNotification(plain, 1, makeClients());

      expect(a.kind === "clientMoved" && a.event.reasonMessage).toBe("bye");
      expect(b.kind === "clientMoved" && b.event.reasonMessage).toBe("");
    });

    // A channel id is 0 to 2^64-1 in plain decimal. Anything else names no
    // channel; it must not throw, which would drop the datagram's other rows.
    it.each(["-1", "18446744073709551616", "0x10", "1e3", ""])(
      "reads ctid %j as channel 0",
      (ctid) => {
        const cmd = { name: "notifyclientmoved", params: { clid: "7", ctid, reasonid: "1" } };

        const result = handleNotification(cmd, 1, makeClients());

        expect(result.kind).toBe("clientMoved");
        if (result.kind !== "clientMoved") return;
        expect(result.event.targetChannelID).toBe(0n);
      },
    );

    const known = (): Map<number, ClientEnterEvent> =>
      new Map([
        [7, { id: 7, nickname: "Alice", uid: "uid7", channelID: 2n, type: 0 } as ClientEnterEvent],
      ]);

    // Measured on TeamSpeak 3 3.13.8 and TeamSpeak 6 6.0.0: a client's own move names no invoker.
    it("names no invoker for a move of the client's own, though the roster knows it", () => {
      const cmd = { name: "notifyclientmoved", params: { clid: "7", ctid: "4", reasonid: "0" } };

      const result = handleNotification(cmd, 7, known());

      if (result.kind !== "clientMoved") throw new Error(result.kind);
      expect(result.event).toMatchObject({ invokerID: 0, invokerName: "", invokerUID: "" });
    });

    it("keeps the invoker of a move someone else made", () => {
      const cmd = {
        name: "notifyclientmoved",
        params: {
          clid: "7",
          ctid: "4",
          reasonid: "1",
          invokerid: "9",
          invokername: "Admin",
          invokeruid: "adm",
        },
      };

      const result = handleNotification(cmd, 1, known());

      if (result.kind !== "clientMoved") throw new Error(result.kind);
      expect(result.event).toMatchObject({
        invokerID: 9,
        invokerName: "Admin",
        invokerUID: "adm",
      });
    });

    it("takes the channel the client came from from cfid when sent", () => {
      const cmd = { name: "notifyclientmoved", params: { clid: "7", cfid: "3", ctid: "4" } };

      const result = handleNotification(cmd, 1, known());

      if (result.kind !== "clientMoved") throw new Error(result.kind);
      expect(result.event.fromChannelID).toBe(3n);
    });

    it("takes it from the roster when the server sends no cfid, as TS3 does", () => {
      const clients = known();
      const cmd = { name: "notifyclientmoved", params: { clid: "7", ctid: "4", reasonid: "0" } };

      const result = handleNotification(cmd, 1, clients);

      if (result.kind !== "clientMoved") throw new Error(result.kind);
      expect(result.event.fromChannelID).toBe(2n);
      // The roster moved on, so the event is where the old channel is told.
      expect(clients.get(7)?.channelID).toBe(4n);
    });

    it("leaves it absent for a client it did not know, without a cfid", () => {
      const cmd = { name: "notifyclientmoved", params: { clid: "8", ctid: "4" } };

      const result = handleNotification(cmd, 1, known());

      if (result.kind !== "clientMoved") throw new Error(result.kind);
      expect("fromChannelID" in result.event).toBe(false);
    });

    it("reads the largest channel id as itself", () => {
      const cmd = {
        name: "notifyclientmoved",
        params: { clid: "7", ctid: "18446744073709551615" },
      };

      const result = handleNotification(cmd, 1, makeClients());

      expect(result.kind === "clientMoved" && result.event.targetChannelID).toBe(
        18446744073709551615n,
      );
    });
  });

  describe("notifyclientpoke", () => {
    it("parses poke with message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "5",
          invokername: "Alice",
          invokeruid: "uid123",
          msg: "hello",
        },
      };
      const result = handleNotification(cmd, 1, makeClients());
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(5);
      expect(result.event.invokerName).toBe("Alice");
      expect(result.event.invokerUID).toBe("uid123");
      expect(result.event.message).toBe("hello");
    });

    it("parses poke with empty message", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {
          invokerid: "3",
          invokername: "Bob",
          invokeruid: "uid456",
          msg: "",
        },
      };
      const result = handleNotification(cmd, 1, makeClients());
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.message).toBe("");
      expect(result.event.invokerName).toBe("Bob");
    });

    it("handles missing fields gracefully", () => {
      const cmd = {
        name: "notifyclientpoke",
        params: {},
      };
      const result = handleNotification(cmd, 1, makeClients());
      expect(result.kind).toBe("poked");
      if (result.kind !== "poked") return;
      expect(result.event.invokerID).toBe(0);
      expect(result.event.invokerName).toBe("");
      expect(result.event.invokerUID).toBe("");
      expect(result.event.message).toBe("");
    });
  });

  it("returns unknown for unrecognized notifications", () => {
    const cmd = {
      name: "notifysomethingelse",
      params: {},
    };
    const result = handleNotification(cmd, 1, makeClients());
    expect(result.kind).toBe("unknown");
  });

  // No client has id 0; a row naming it, or naming none, describes nobody.
  it.each(["notifycliententerview", "notifyclientleftview", "notifyclientmoved"])(
    "drops %s for clid 0",
    (name) => {
      const clients = makeClients();
      for (const params of [{ clid: "0", ctid: "1" }, { ctid: "1" }]) {
        expect(handleNotification({ name, params }, 0, clients).kind).toBe("unknown");
      }
      expect(clients.size).toBe(0);
    },
  );
});

describe("notifytextmessage", () => {
  const cmd = { name: "notifytextmessage", params: { invokerid: "7", msg: "hi" } };

  it("fills the sender's groups from the client it knows", () => {
    const clients = makeClients();
    handleNotification(
      {
        name: "notifycliententerview",
        params: { clid: "7", ctid: "1", client_nickname: "A", client_servergroups: "6,9" },
      },
      1,
      clients,
    );

    const result = handleNotification(cmd, 1, clients);

    expect(result.kind === "textMessage" && result.message.invokerGroups).toEqual([6n, 9n]);
  });

  it("leaves them undefined for a sender it has not seen", () => {
    const result = handleNotification(cmd, 1, makeClients());

    expect(result.kind === "textMessage" && result.message.invokerGroups).toBeUndefined();
  });
});

describe("notification names", () => {
  // handleNotification dispatches on literal names; each must be one the
  // table lists, so a typo in either is caught.
  it("lists every name handleNotification dispatches on", async () => {
    const { readFile } = await import("node:fs/promises");
    const { NotificationName } = await import("@honeybbq/teamspeak");
    const source = await readFile(new URL("./notifications.ts", import.meta.url), "utf8");
    const dispatched = [...source.matchAll(/case "(notify\w+)"/g)].map((m) => m[1] as string);
    expect(dispatched.length).toBeGreaterThan(0);
    const known = new Set<string>(Object.values(NotificationName));
    for (const name of dispatched) expect(known.has(name), name).toBe(true);
  });

  describe("notifyclientupdated", () => {
    const enter = {
      name: "notifycliententerview",
      params: {
        clid: "7",
        ctid: "3",
        client_nickname: "Alice",
        client_unique_identifier: "uid",
        client_servergroups: "6",
        client_away: "0",
      },
    };

    it("reports exactly the properties it carried, and the admin who edited", () => {
      const result = handleNotification(
        {
          name: "notifyclientupdated",
          params: {
            clid: "7",
            client_description: "hello",
            invokerid: "2",
            invokername: "Admin",
            invokeruid: "auid",
          },
        },
        1,
        makeClients(),
      );

      expect(result.kind).toBe("clientUpdated");
      if (result.kind !== "clientUpdated") return;
      expect(Object.keys(result.event.changes)).toEqual(["description"]);
      expect(result.event).toMatchObject({ clientID: 7, invokerID: 2, invokerName: "Admin" });
    });

    it("has no invoker when nobody edited the client", () => {
      const result = handleNotification(
        { name: "notifyclientupdated", params: { clid: "7", client_away: "1" } },
        1,
        makeClients(),
      );
      expect(result.kind === "clientUpdated" && result.event).toMatchObject({
        invokerID: 0,
        invokerName: "",
        invokerUID: "",
      });
    });

    it("replaces the roster entry and leaves the earlier object as it was", () => {
      const clients = makeClients();
      const entered = handleNotification(enter, 1, clients);
      const before = clients.get(7);

      handleNotification(
        { name: "notifyclientupdated", params: { clid: "7", client_servergroups: "6,8" } },
        1,
        clients,
      );

      expect(clients.get(7)).not.toBe(before);
      expect(before?.serverGroups).toEqual([6n]);
      expect(entered.kind === "clientEnter" && entered.info.serverGroups).toEqual([6n]);
      expect(clients.get(7)?.serverGroups).toEqual([6n, 8n]);
      expect(clients.get(7)?.nickname).toBe("Alice");
    });

    it("reads an empty group list as no groups", () => {
      const clients = makeClients();
      handleNotification(enter, 1, clients);
      handleNotification(
        { name: "notifyclientupdated", params: { clid: "7", client_servergroups: "" } },
        1,
        clients,
      );
      expect(clients.get(7)?.serverGroups).toEqual([]);
    });

    it("creates no entry for a client it does not know, and still reports it", () => {
      const clients = makeClients();
      const result = handleNotification(
        { name: "notifyclientupdated", params: { clid: "9", client_away: "1" } },
        1,
        clients,
      );
      expect(result.kind).toBe("clientUpdated");
      expect(clients.size).toBe(0);
    });

    it("is not an event for client id 0", () => {
      const result = handleNotification(
        { name: "notifyclientupdated", params: { clid: "0", client_away: "1" } },
        1,
        makeClients(),
      );
      expect(result.kind).toBe("unknown");
    });

    it("gives a following text message the new groups, whichever of the two came first", () => {
      const added = {
        name: "notifyservergroupclientadded",
        params: { sgid: "8", clid: "7", name: "Alice", cluid: "uid" },
      };
      const updated = {
        name: "notifyclientupdated",
        params: { clid: "7", client_servergroups: "6,8" },
      };
      const text = { name: "notifytextmessage", params: { invokerid: "7", msg: "x" } };
      for (const order of [
        [added, updated],
        [updated, added],
      ]) {
        const clients = makeClients();
        handleNotification(enter, 1, clients);
        for (const n of order) handleNotification(n, 1, clients);
        const result = handleNotification(text, 1, clients);
        expect(result.kind === "textMessage" && result.message.invokerGroups).toEqual([6n, 8n]);
      }
    });
  });

  describe("notifyservergroupclientadded and ...deleted", () => {
    const params = {
      sgid: "8",
      clid: "7",
      name: "Alice",
      cluid: "uid",
      invokerid: "2",
      invokername: "Admin",
      invokeruid: "auid",
    };

    it("read the group, the client and the invoker", () => {
      const added = handleNotification(
        { name: "notifyservergroupclientadded", params },
        1,
        makeClients(),
      );
      const removed = handleNotification(
        { name: "notifyservergroupclientdeleted", params },
        1,
        makeClients(),
      );
      const expected = {
        groupID: 8n,
        clientID: 7,
        nickname: "Alice",
        uid: "uid",
        invokerID: 2,
        invokerName: "Admin",
        invokerUID: "auid",
      };
      expect(added.kind === "clientServerGroupAdded" && added.event).toEqual(expected);
      expect(removed.kind === "clientServerGroupRemoved" && removed.event).toEqual(expected);
    });

    it("do not touch the roster", () => {
      const clients = makeClients();
      handleNotification(
        {
          name: "notifycliententerview",
          params: { clid: "7", ctid: "3", client_servergroups: "6" },
        },
        1,
        clients,
      );
      const before = clients.get(7);
      handleNotification({ name: "notifyservergroupclientadded", params }, 1, clients);
      expect(clients.get(7)).toBe(before);
    });
  });

  describe("notifyclientchannelgroupchanged", () => {
    const enter = {
      name: "notifycliententerview",
      params: { clid: "7", ctid: "3", client_channel_group_id: "8" },
    };
    const changed = (cid: string) => ({
      name: "notifyclientchannelgroupchanged",
      params: {
        invokerid: "0",
        invokername: "Server",
        invokeruid: "serveradmin",
        cgid: "5",
        cid,
        clid: "7",
        cgi: "3",
      },
    });

    it("reads the event, a server invoker included", () => {
      const result = handleNotification(changed("3"), 1, makeClients());
      expect(result.kind === "clientChannelGroupChanged" && result.event).toEqual({
        clientID: 7,
        channelID: 3n,
        channelGroupID: 5n,
        channelGroupInheritedChannelID: 3n,
        invokerID: 0,
        invokerName: "Server",
        invokerUID: "serveradmin",
      });
    });

    it("refreshes the channel group when the client is in that channel", () => {
      const clients = makeClients();
      handleNotification(enter, 1, clients);
      const before = clients.get(7);
      handleNotification(changed("3"), 1, clients);
      expect(clients.get(7)?.channelGroupID).toBe(5n);
      expect(clients.get(7)?.channelGroupInheritedChannelID).toBe(3n);
      expect(before?.channelGroupID).toBe(8n);
    });

    it("leaves the group alone for another channel", () => {
      const clients = makeClients();
      handleNotification(enter, 1, clients);
      handleNotification(changed("4"), 1, clients);
      expect(clients.get(7)?.channelGroupID).toBe(8n);
    });
  });
});
