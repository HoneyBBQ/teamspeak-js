import { describe, expect, it } from "vitest";
import {
  getClientDatabaseInfo,
  getClientNameByDBID,
  getClientUIDInfoByID,
  listClientDatabase,
} from "./clients.js";
import { listServers } from "./instance.js";
import { listTempPasswords, whoAmI } from "./server.js";
import { asClientDBID, asClientID } from "../command/ids.js";
import type { CommandExecutor } from "../command/request.js";

const answering = (...rows: Array<Record<string, string>>): CommandExecutor => ({
  send: async () => rows,
});

describe("clientdbinfo and clientdblist", () => {
  it("reads the avatar hash and the traffic totals from an info row", async () => {
    const info = await getClientDatabaseInfo(
      answering({
        client_flag_avatar: "d41d8cd98f00b204e9800998ecf8427e",
        client_total_bytes_uploaded: "10",
        client_total_bytes_downloaded: "20",
        client_month_bytes_uploaded: "3",
        client_month_bytes_downloaded: "4",
      }),
      asClientDBID(14),
    );
    expect(info).toMatchObject({
      avatarHash: "d41d8cd98f00b204e9800998ecf8427e",
      totalBytesUploaded: 10,
      totalBytesDownloaded: 20,
      monthBytesUploaded: 3,
      monthBytesDownloaded: 4,
    });
    expect(info.loginName).toBeUndefined();
  });

  it("leaves the info fields absent on a list row, and reads the login name", async () => {
    const [row] = await listClientDatabase(
      answering({ cldbid: "3", client_login_name: "svc", client_nickname: "admin" }),
    );
    expect(row?.loginName).toBe("svc");
    expect(row?.avatarHash).toBeUndefined();
    expect(row?.totalBytesUploaded).toBeUndefined();
  });
});

describe("client lookups", () => {
  it("reads the uid of clientgetnamefromdbid", async () => {
    const name = await getClientNameByDBID(
      answering({ cldbid: "9", cluid: "u=", name: "meas-two" }),
      asClientDBID(9),
    );
    expect(name.uid).toBe("u=");
  });

  it("reads the nickname and myTeamSpeak id of clientgetuidfromclid", async () => {
    expect(
      await getClientUIDInfoByID(
        answering({ clid: "11", cluid: "u=", mytsid: "", nickname: "meas-two" }),
        asClientID(11),
      ),
    ).toEqual({ clientID: 11, uid: "u=", nickname: "meas-two", mytsid: "" });
  });
});

describe("whoami and serverlist on TS6", () => {
  it("reads the server UUID and origin server id", async () => {
    const me = await whoAmI(
      answering({
        virtualserver_uuid: "ef591a18-7fcc-550b-a4e1-db059a6d73ab",
        client_origin_server_id: "2",
      }),
    );
    expect(me.serverUUID).toBe("ef591a18-7fcc-550b-a4e1-db059a6d73ab");
    expect(me.originServerID).toBe(2n);
    const ts3 = await whoAmI(answering({ client_origin_server_id: "0" }));
    expect(ts3.serverUUID).toBeUndefined();
  });

  it("reads the guest flags, the weblist flag and the uuid, absent on TS3", async () => {
    const [ts6, ts3] = await listServers(
      answering(
        {
          virtualserver_id: "1",
          virtualserver_uuid: "ef59",
          guest_can_create_channels: "1",
          guest_can_create_homebase: "0",
          virtualserver_weblist_enabled: "0",
        },
        { virtualserver_id: "2" },
      ),
    );
    expect(ts6).toMatchObject({
      uuid: "ef59",
      guestCanCreateChannels: true,
      guestCanCreateHomebase: false,
      weblistEnabled: false,
    });
    expect(ts3?.uuid).toBeUndefined();
    expect(ts3?.weblistEnabled).toBeUndefined();
  });
});

describe("temporary passwords", () => {
  it("reads the target channel password", async () => {
    const [temp] = await listTempPasswords(
      answering({ pw_clear: "abc", desc: "x", tcid: "2", tcpw: "chanpw" }),
    );
    expect(temp?.targetChannelPassword).toBe("chanpw");
  });
});
