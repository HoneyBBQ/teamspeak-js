import { describe, expect, it } from "vitest";
import {
  createServer,
  createServerSnapshot,
  deleteServer,
  deployServerSnapshot,
  listServers,
  sendGlobalMessage,
  startServer,
  stopInstance,
  stopServer,
} from "./instance.js";
import { addServerGroupPermissionByType, deleteServerGroupPermissionByType } from "./server.js";
import { asChannelID, asServerID } from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandRequest } from "../command/request.js";
import { GroupAutoUpdateType } from "../enums.js";
import { permissionByName } from "../permission.js";

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

describe("server group permissions by type", () => {
  it("adds and deletes for every group of a type", async () => {
    const { client, sent } = recording();
    const permission = permissionByName("b_virtualserver_start");
    await addServerGroupPermissionByType(client, GroupAutoUpdateType.ServerAdmin, permission, 1);
    await addServerGroupPermissionByType(client, GroupAutoUpdateType.QueryGuest, permission, 1, {
      negated: true,
      skip: true,
    });
    await deleteServerGroupPermissionByType(client, GroupAutoUpdateType.ServerAdmin, permission);
    expect(sent).toEqual([
      "servergroupautoaddperm sgtype=45 permsid=b_virtualserver_start permvalue=1 permnegated=0 permskip=0",
      "servergroupautoaddperm sgtype=20 permsid=b_virtualserver_start permvalue=1 permnegated=1 permskip=1",
      "servergroupautodelperm sgtype=45 permsid=b_virtualserver_start",
    ]);
  });
});

describe("virtual servers", () => {
  const sid = asServerID(2n);

  it("sends each lifecycle command", async () => {
    const { client, sent } = recording();
    await startServer(client, sid);
    await stopServer(client, sid);
    await stopServer(client, sid, { reason: "back soon" });
    await stopServer(client, sid, { reason: "" });
    await deleteServer(client, sid);
    await deleteServer(client, sid, { noEvent: true });
    await stopInstance(client);
    await stopInstance(client, { reason: "5 minute maintenance" });
    await sendGlobalMessage(client, "Hello World!");
    expect(sent).toEqual([
      "serverstart sid=2",
      "serverstop sid=2",
      "serverstop sid=2 reasonmsg=back\\ssoon",
      "serverstop sid=2",
      "serverdelete sid=2",
      "serverdelete sid=2 -noevent",
      "serverprocessstop",
      "serverprocessstop reasonmsg=5\\sminute\\smaintenance",
      "gm msg=Hello\\sWorld!",
    ]);
  });

  it("creates a server from raw properties and returns its id, port and key", async () => {
    const { client, sent } = recording([
      { sid: "6", token: "KU5HLgrv6lJLSxKc0DECLsFERXuY0RwJmYF1HthX", virtualserver_port: "9987" },
    ]);
    const created = await createServer(client, "Second One", {
      virtualserver_port: "9988",
      virtualserver_maxclients: "5",
    });
    expect(sent).toEqual([
      "servercreate virtualserver_name=Second\\sOne virtualserver_port=9988 virtualserver_maxclients=5",
    ]);
    expect(created).toEqual({
      id: asServerID(6n),
      port: 9987,
      token: "KU5HLgrv6lJLSxKc0DECLsFERXuY0RwJmYF1HthX",
    });
  });

  it("lists servers with the flags given", async () => {
    const { client, sent } = recording();
    await listServers(client);
    await listServers(client, { uid: true, short: true, all: true, onlyOffline: true });
    expect(sent).toEqual(["serverlist", "serverlist -uid -short -all -onlyoffline"]);
  });

  it("reads a full row and a short one", async () => {
    const { client } = recording([
      {
        virtualserver_id: "1",
        virtualserver_port: "9987",
        virtualserver_status: "online",
        virtualserver_clientsonline: "1",
        virtualserver_queryclientsonline: "0",
        virtualserver_maxclients: "32",
        virtualserver_uptime: "26",
        virtualserver_name: "TeamSpeak ]I[ Server",
        virtualserver_autostart: "1",
        virtualserver_machine_id: "",
        virtualserver_unique_identifier: "f87v8hsmXaUX9cPIDNDyeuQqjFI=",
        guest_can_create_channels: "1",
      },
      { virtualserver_id: "2", virtualserver_port: "9988", virtualserver_status: "offline" },
    ]);
    expect(await listServers(client)).toEqual([
      {
        id: asServerID(1n),
        port: 9987,
        status: "online",
        name: "TeamSpeak ]I[ Server",
        clientsOnline: 1,
        queryClientsOnline: 0,
        maxClients: 32,
        uptimeMs: 26_000,
        autoStart: true,
        machineID: "",
        uid: "f87v8hsmXaUX9cPIDNDyeuQqjFI=",
        guestCanCreateChannels: true,
      },
      {
        id: asServerID(2n),
        port: 9988,
        status: "offline",
        name: "",
        clientsOnline: undefined,
        queryClientsOnline: undefined,
        maxClients: undefined,
        uptimeMs: undefined,
        autoStart: undefined,
        machineID: undefined,
        uid: "",
      },
    ]);
  });
});

describe("snapshots", () => {
  it("creates one with or without a password, and reads its parts", async () => {
    const { client, sent } = recording(
      [{ version: "3", data: "KLUv/WRu" }],
      [{ version: "3", salt: "QWkeLqDN=", data: "EXnqSONE" }],
    );
    const plain = await createServerSnapshot(client);
    const encrypted = await createServerSnapshot(client, { password: "pw 1" });
    expect(sent).toEqual(["serversnapshotcreate", "serversnapshotcreate password=pw\\s1"]);
    expect(plain).toEqual({ version: 3, salt: "", data: "KLUv/WRu" });
    expect(encrypted).toEqual({ version: 3, salt: "QWkeLqDN=", data: "EXnqSONE" });
  });

  it("deploys it with its flags, and reads the channel mapping", async () => {
    const { client, sent } = recording(
      [],
      [
        { ocid: "6", ncid: "24" },
        { ocid: "5", ncid: "23" },
      ],
    );
    const snapshot = { version: 3, salt: "QWkeLqDN=", data: "EXnqSONE" };
    expect(await deployServerSnapshot(client, { ...snapshot, salt: "" })).toEqual([]);
    const mapping = await deployServerSnapshot(client, snapshot, {
      password: "pw",
      keepFiles: true,
      mapping: true,
    });
    expect(sent).toEqual([
      "serversnapshotdeploy version=3 data=EXnqSONE",
      "serversnapshotdeploy password=pw -keepfiles -mapping version=3 salt=QWkeLqDN= data=EXnqSONE",
    ]);
    expect(mapping).toEqual([
      { oldID: asChannelID(6n), newID: asChannelID(24n) },
      { oldID: asChannelID(5n), newID: asChannelID(23n) },
    ]);
  });
});
