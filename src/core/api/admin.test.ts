import { describe, expect, it } from "vitest";
import {
  addAPIKey,
  addQueryLogin,
  deleteAPIKey,
  deleteQueryLogin,
  listAPIKeys,
  listQueryLogins,
  setQueryLogin,
} from "./credentials.js";
import {
  deleteCustomProperty,
  findClients,
  findCustomProperty,
  listCustomProperties,
  setCustomProperty,
} from "./clients.js";
import { initFileDownload, initFileUpload } from "./files.js";
import { addPrivilegeKey, getOwnPermission, listPrivilegeKeys } from "./groups.js";
import { addBan, findBans, listBans, sendOfflineMessage } from "./moderation.js";
import {
  asAPIKeyID,
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asPermissionID,
  asServerGroupID,
  asServerID,
  asUID,
} from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandRequest } from "../command/request.js";
import { APIKeyScope } from "../enums.js";
import { permissionByID, permissionByName } from "../permission.js";

/** An executor that records each request as the wire line it encodes to, answering from a queue. */
const recording = (...answers: Array<Array<Record<string, string>>>) => {
  const sent: string[] = [];
  const client: CommandExecutor = {
    send: async (request: CommandRequest) => {
      sent.push(encodeRequest(request, (p) => p));
      return answers.shift() ?? [];
    },
  };
  return { client, sent };
};

const cldbid = asClientDBID(8n);

describe("API keys", () => {
  // Rows are as TS6 answered over WebQuery; TS3's are the same without custom_id.
  const created = {
    apikey: "AQDEKaVYoSMetSLHnRb79Vp_yImgIZubkYnIMbI",
    cldbid: "1",
    created_at: "1792224713",
    custom_id: "",
    expires_at: "1792311113",
    id: "3",
    scope: "read",
    sid: "1",
    time_left: "86399",
  };

  it("creates a key with the scope, lifetime and owner given", async () => {
    const { client, sent } = recording([created], [created]);
    await addAPIKey(client, APIKeyScope.Read);
    await addAPIKey(client, APIKeyScope.Manage, { lifetimeDays: 0, ownerDatabaseID: cldbid });
    expect(sent).toEqual(["apikeyadd scope=read", "apikeyadd scope=manage lifetime=0 cldbid=8"]);
  });

  it("refuses a lifetime that is not a whole number of days", async () => {
    const { client, sent } = recording();
    for (const lifetimeDays of [-1, 1.5, Number.NaN]) {
      await expect(addAPIKey(client, "read", { lifetimeDays })).rejects.toThrow(RangeError);
    }
    expect(sent).toEqual([]);
  });

  it("reads the record and the key", async () => {
    const { client } = recording([created]);
    const key = await addAPIKey(client, "read");

    expect(key).toEqual({
      id: asAPIKeyID(3n),
      serverID: asServerID(1n),
      ownerDatabaseID: asClientDBID(1n),
      scope: "read",
      createdAt: new Date(1_792_224_713_000),
      expiresAt: new Date(1_792_311_113_000),
      remainingMs: 86_399_000,
      customID: "",
      key: created.apikey,
    });
    // An ordinary field: it survives a spread and a clone, which is how a caller stores it.
    expect({ ...key, note: "x" }.key).toBe(created.apikey);
    expect(structuredClone(key).key).toBe(created.apikey);
  });

  it("reads a key that never expires as having no end", async () => {
    // Measured: time_left is "unlimited" and expires_at repeats created_at.
    const { client } = recording([
      { ...created, time_left: "unlimited", expires_at: created.created_at },
    ]);
    const [key] = await listAPIKeys(client);
    expect(key).toMatchObject({ expiresAt: undefined, remainingMs: undefined });
    expect(key?.createdAt).toEqual(new Date(1_792_224_713_000));
  });

  it("lists with the owner and the page, and deletes by id", async () => {
    const { client, sent } = recording();
    await listAPIKeys(client);
    await listAPIKeys(client, { owner: "all", start: 1, limit: 2 });
    await listAPIKeys(client, { owner: cldbid });
    await deleteAPIKey(client, asAPIKeyID(4n));
    expect(sent).toEqual([
      "apikeylist",
      "apikeylist cldbid=* start=1 duration=2",
      "apikeylist cldbid=8",
      "apikeydel id=4",
    ]);
  });
});

describe("ServerQuery logins", () => {
  it("sends each command with its parameters", async () => {
    const { client, sent } = recording(
      [{ cldbid: "8", sid: "1", client_login_name: "zzq", client_login_password: "RD8cJLBS" }],
      [{ cldbid: "9", sid: "0", client_login_name: "g", client_login_password: "FK0OzstB" }],
      [],
      [],
      [{ client_login_password: "+3ESzOM3" }],
    );
    await addQueryLogin(client, "zzq", { databaseID: cldbid });
    await addQueryLogin(client, "g");
    await listQueryLogins(client, { pattern: "zz%", start: 0, limit: 1 });
    await deleteQueryLogin(client, cldbid);
    await setQueryLogin(client, "my login");
    expect(sent).toEqual([
      "queryloginadd client_login_name=zzq cldbid=8",
      "queryloginadd client_login_name=g",
      "queryloginlist pattern=zz% start=0 duration=1",
      "querylogindel cldbid=8",
      "clientsetserverquerylogin client_login_name=my\\slogin",
    ]);
  });

  it("returns the generated password", async () => {
    const { client } = recording(
      [{ cldbid: "8", sid: "1", client_login_name: "zzq", client_login_password: "RD8cJLBS" }],
      [{ client_login_password: "+3ESzOM3" }],
    );
    const login = await addQueryLogin(client, "zzq", { databaseID: cldbid });
    expect(login).toEqual({
      databaseID: cldbid,
      serverID: asServerID(1n),
      name: "zzq",
      password: "RD8cJLBS",
    });
    expect(await setQueryLogin(client, "x")).toBe("+3ESzOM3");
  });

  it("reads a list, the instance's logins having server 0", async () => {
    const { client } = recording([
      { cldbid: "1", sid: "0", client_login_name: "serveradmin" },
      { cldbid: "25", sid: "1", client_login_name: "max" },
    ]);
    expect(await listQueryLogins(client)).toEqual([
      { databaseID: asClientDBID(1n), serverID: asServerID(0n), name: "serveradmin" },
      { databaseID: asClientDBID(25n), serverID: asServerID(1n), name: "max" },
    ]);
  });
});

describe("custom properties", () => {
  it("sets, deletes, lists and searches", async () => {
    const { client, sent } = recording();
    await setCustomProperty(client, cldbid, "forum_nickname", "John Doe");
    await deleteCustomProperty(client, cldbid, "forum_nickname");
    await listCustomProperties(client, cldbid);
    await findCustomProperty(client, "forum_nickname", "%Doe%");
    expect(sent).toEqual([
      "customset cldbid=8 ident=forum_nickname value=John\\sDoe",
      "customdelete cldbid=8 ident=forum_nickname",
      "custominfo cldbid=8",
      "customsearch ident=forum_nickname pattern=%Doe%",
    ]);
  });

  it("reads custominfo, where only the first row names the client", async () => {
    const { client } = recording([
      { cldbid: "1", ident: "zz_a", value: "hello world" },
      { ident: "zz_pipe", value: "a|b" },
    ]);
    expect(await listCustomProperties(client, asClientDBID(1n))).toEqual([
      { ident: "zz_a", value: "hello world" },
      { ident: "zz_pipe", value: "a|b" },
    ]);
  });

  it("reads a search with the client on every row", async () => {
    const { client } = recording([
      { cldbid: "13", ident: "q", value: "a" },
      { cldbid: "14", ident: "q", value: "b" },
    ]);
    expect(await findCustomProperty(client, "q", "%")).toEqual([
      { databaseID: asClientDBID(13n), ident: "q", value: "a" },
      { databaseID: asClientDBID(14n), ident: "q", value: "b" },
    ]);
  });

  it("sends a privilege key's custom set escaped twice, and reads it back whole", async () => {
    const { client, sent } = recording(
      [{ token: "t" }],
      [{ token: "u" }],
      [
        {
          token: "t",
          token_type: "0",
          token_id1: "6",
          token_id2: "0",
          token_customset: "ident=a value=Sven\\sPaulsen\\p|ident=b value=",
        },
        { token: "u", token_type: "0", token_id1: "6", token_id2: "0", token_customset: "" },
      ],
    );
    const customSet = [
      { ident: "a", value: "Sven Paulsen|" },
      { ident: "b", value: "" },
    ];
    await addPrivilegeKey(client, { serverGroupID: asServerGroupID(6n), customSet });
    await addPrivilegeKey(client, {
      channelGroupID: asChannelGroupID(5n),
      channelID: asChannelID(2n),
      customSet: [],
    });
    const [withSet, without] = await listPrivilegeKeys(client);

    // The inner text is `ident=a value=Sven\sPaulsen\p|ident=b value=`; the
    // wire escapes its backslashes and its pipe once more. A single escape cuts
    // the value at its first space, as the server does with the one in its own
    // documentation.
    expect(sent[0]).toBe(
      "privilegekeyadd tokentype=0 tokenid1=6 tokenid2=0 tokencustomset=ident=a\\svalue=Sven\\\\sPaulsen\\\\p\\pident=b\\svalue=",
    );
    expect(sent[1]).toBe("privilegekeyadd tokentype=1 tokenid1=5 tokenid2=2");
    expect(withSet?.customSet).toEqual(customSet);
    expect(without?.customSet).toEqual([]);
  });
});

describe("offline messages", () => {
  it("sends one to a uid", async () => {
    const { client, sent } = recording();
    await sendOfflineMessage(client, asUID("IsrCF7/88rjdAJVDF1E5cqlQRDY="), "hi", "hello there");
    expect(sent).toEqual([
      "messageadd cluid=IsrCF7\\/88rjdAJVDF1E5cqlQRDY= subject=hi message=hello\\sthere",
    ]);
  });
});

describe("getOwnPermission", () => {
  it("asks for one permission by name or id, and reads the value", async () => {
    const row = { permsid: "i_client_move_power", permid: "204", permvalue: "75" };
    const { client, sent } = recording([row], [row]);
    const byName = await getOwnPermission(client, permissionByName("i_client_move_power"));
    await getOwnPermission(client, permissionByID(asPermissionID(204)));

    expect(sent).toEqual(["permget permsid=i_client_move_power", "permget permid=204"]);
    expect(byName).toEqual({ id: 204, name: "i_client_move_power", value: 75 });
  });
});

describe("bans", () => {
  const row = {
    banid: "3",
    ip: "",
    name: "",
    uid: "",
    mytsid: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    lastnickname: "",
    created: "1792225641",
    duration: "60",
    invokername: "serveradmin",
    invokercldbid: "1",
    invokeruid: "serveradmin",
    reason: "",
    enforcements: "0",
  };

  it("pages banlist with start and limit", async () => {
    const { client, sent } = recording([row]);
    const [ban] = await listBans(client, { start: 1, limit: 1 });
    await listBans(client);
    expect(sent).toEqual(["banlist start=1 duration=1", "banlist"]);
    expect(ban?.mytsid).toBe(row.mytsid);
  });

  it("adds a ban by myTeamSpeak id, with the last nickname", async () => {
    const { client, sent } = recording([{ banid: "3" }], [{ banid: "4" }]);
    await addBan(client, { mytsid: row.mytsid, durationMs: 60_000 });
    await addBan(client, { uid: asUID("zzz"), lastNickname: "ln" });
    expect(sent).toEqual([
      "banadd mytsid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= time=60",
      "banadd uid=zzz lastnickname=ln",
    ]);
    await expect(addBan(client, { lastNickname: "ln" })).rejects.toThrow(TypeError);
  });

  it("finds bans by any one criterion, and refuses none", async () => {
    const { client, sent } = recording([row]);
    const [ban] = await findBans(client, { ip: "1.2.3.4", name: "" });
    await findBans(client, { mytsid: row.mytsid });
    await expect(findBans(client, {})).rejects.toThrow(TypeError);
    await expect(findBans(client, { ip: "" })).rejects.toThrow(TypeError);
    expect(sent).toEqual([
      "banfind ip=1.2.3.4",
      "banfind mytsid=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ]);
    expect(ban?.id).toBe(3n);
  });
});

describe("clientfind", () => {
  it("asks for the channel, and reads it where the server sends it", async () => {
    const { client, sent } = recording(
      [
        {
          chuid: "109da2a5-a181-4f09-86e3-adf924957d44",
          cid: "1",
          clid: "48",
          client_nickname: "serveradmin",
        },
      ],
      [{ clid: "256", client_nickname: "serveradmin" }],
    );
    const [ts6] = await findClients(client, "serv", { channelID: true, channelUID: true });
    const [ts3] = await findClients(client, "serv");
    expect(sent).toEqual(["clientfind pattern=serv -cid -chuid", "clientfind pattern=serv"]);
    expect(ts6).toEqual({
      id: 48,
      nickname: "serveradmin",
      channelID: 1n,
      channelUID: "109da2a5-a181-4f09-86e3-adf924957d44",
    });
    expect(ts3).toEqual({ id: 256, nickname: "serveradmin" });
  });
});

describe("file transfer negotiation", () => {
  it("surfaces an ip the server sends, and omits it otherwise", async () => {
    const upload = { clientftfid: "1", serverftfid: "6", ftkey: "k", port: "30033", seekpos: "0" };
    const download = { clientftfid: "1", serverftfid: "7", ftkey: "k", port: "30033", size: "5" };
    const { client } = recording(
      [{ ...upload, ip: "203.0.113.5" }],
      [upload],
      [{ ...download, ip: "203.0.113.5" }],
      [download],
    );
    const cid = asChannelID(1n);
    expect((await initFileUpload(client, cid, "/a", 5n)).ip).toBe("203.0.113.5");
    expect(await initFileUpload(client, cid, "/a", 5n)).not.toHaveProperty("ip");
    expect((await initFileDownload(client, cid, "/a")).ip).toBe("203.0.113.5");
    expect(await initFileDownload(client, cid, "/a")).not.toHaveProperty("ip");
  });
});
