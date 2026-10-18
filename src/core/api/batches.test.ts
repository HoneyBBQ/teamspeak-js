import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addChannelClientPermissions,
  addChannelPermissions,
  deleteChannelClientPermissions,
  deleteChannelPermissions,
} from "./channels.js";
import {
  addClientPermissions,
  deleteClientPermissions,
  kickClients,
  moveClients,
} from "./clients.js";
import { addChannelGroupPermissions, deleteChannelGroupPermissions } from "./groups.js";
import { banClients } from "./moderation.js";
import {
  addClientsToServerGroup,
  addServerGroupPermissions,
  addServerGroupPermissionsByType,
  deleteServerGroupPermissions,
  deleteServerGroupPermissionsByType,
  removeClientsFromServerGroup,
} from "./server.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientID,
  asServerGroupID,
} from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandOptions, CommandRequest } from "../command/request.js";
import { GroupAutoUpdateType } from "../enums.js";
import { ServerError } from "../errors.js";
import { permissionByID, permissionByName } from "../permission.js";
import { Reason } from "../reason.js";

const voicePassword = (password: string): string =>
  createHash("sha1").update(password).digest("base64");

/** Records the line each request encodes to, and what options it was sent with. */
const recorder = (...answers: Array<Array<Record<string, string>> | Error>) => {
  const sent: string[] = [];
  const requests: CommandRequest[] = [];
  const options: Array<CommandOptions | undefined> = [];
  const client: CommandExecutor = {
    send: async (request, commandOptions) => {
      sent.push(encodeRequest(request, voicePassword));
      requests.push(request);
      options.push(commandOptions);
      const answer = answers.shift() ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, sent, requests, options };
};

const clients = [asClientID(5), asClientID(6), asClientID(7)];
const talk = permissionByName("i_client_talk_power");
const poke = permissionByName("i_client_poke_power");

describe("kickClients", () => {
  it("sends one row per client, the shared parameters once", async () => {
    const { client, sent } = recorder();
    await kickClients(client, clients, Reason.KickChannel, { reasonMessage: "bye" });
    expect(sent).toEqual(["clientkick reasonid=4 reasonmsg=bye clid=5|clid=6|clid=7"]);
  });

  // The server reads the switch from the first row only: written after the
  // last row it is ignored, which was measured on TeamSpeak 3 and 6.
  it("puts -continueonerror before the first row, and only when asked", async () => {
    const { client, sent } = recorder();
    await kickClients(client, clients, Reason.KickServer, { continueOnError: true });
    await kickClients(client, clients, Reason.KickServer, { continueOnError: false });
    expect(sent).toEqual([
      "clientkick -continueonerror reasonid=5 clid=5|clid=6|clid=7",
      "clientkick reasonid=5 clid=5|clid=6|clid=7",
    ]);
  });

  it("refuses a reason a kick cannot have, and sends nothing for no clients", async () => {
    const { client, sent } = recorder();
    await expect(kickClients(client, clients, Reason.Moved as never)).rejects.toThrow(RangeError);
    await kickClients(client, [], Reason.KickChannel);
    expect(sent).toEqual([]);
  });

  it("passes the signal and timeout on, and nothing else", async () => {
    const { client, options } = recorder();
    const { signal } = new AbortController();
    await kickClients(client, clients, Reason.KickChannel, {
      continueOnError: true,
      signal,
      timeoutMs: 5,
    });
    expect(options).toEqual([{ signal, timeoutMs: 5 }]);
  });

  it("throws what the server said, unchanged", async () => {
    const { client } = recorder(new ServerError(512, "invalid clientID"));
    await expect(kickClients(client, clients, Reason.KickChannel)).rejects.toMatchObject({
      code: 512,
    });
  });
});

describe("moveClients", () => {
  it("sends the channel once and a row per client", async () => {
    const { client, sent } = recorder();
    await moveClients(client, clients, asChannelID(3n));
    await moveClients(client, clients.slice(0, 2), asChannelID(3n), { continueOnError: true });
    expect(sent).toEqual([
      "clientmove cid=3 clid=5|clid=6|clid=7",
      "clientmove -continueonerror cid=3 clid=5|clid=6",
    ]);
  });

  it("hashes the channel password for the voice protocol, once", async () => {
    const { client, sent } = recorder();
    await moveClients(client, clients.slice(0, 2), asChannelID(3n), { password: "pw" });
    const hash = voicePassword("pw").replaceAll("/", "\\/");
    expect(sent).toEqual([`clientmove cid=3 cpw=${hash} clid=5|clid=6`]);
  });

  it("sends nothing for no clients", async () => {
    const { client, sent } = recorder();
    await moveClients(client, [], asChannelID(3n));
    expect(sent).toEqual([]);
  });
});

describe("banClients", () => {
  it("sends the duration and reason once, and returns every id reported", async () => {
    const { client, sent } = recorder([{ banid: "11" }, { banid: "12" }, { banid: "13" }], []);
    expect(await banClients(client, clients, { durationMs: 30_000, reason: "x" })).toEqual([
      11n,
      12n,
      13n,
    ]);
    expect(await banClients(client, clients.slice(0, 1), { continueOnError: true })).toEqual([]);
    expect(sent).toEqual([
      "banclient time=30 banreason=x clid=5|clid=6|clid=7",
      "banclient -continueonerror clid=5",
    ]);
  });

  it("sends nothing, and returns none, for no clients", async () => {
    const { client, sent } = recorder();
    expect(await banClients(client, [])).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("server group membership", () => {
  it("adds and removes several clients with the group once", async () => {
    const { client, sent } = recorder();
    const members = [asClientDBID(3n), asClientDBID(4n)];
    await addClientsToServerGroup(client, asServerGroupID(9n), members);
    await removeClientsFromServerGroup(client, asServerGroupID(9n), members, {
      continueOnError: true,
    });
    expect(sent).toEqual([
      "servergroupaddclient sgid=9 cldbid=3|cldbid=4",
      "servergroupdelclient -continueonerror sgid=9 cldbid=3|cldbid=4",
    ]);
  });

  it("sends nothing for no clients", async () => {
    const { client, sent } = recorder();
    await addClientsToServerGroup(client, asServerGroupID(9n), []);
    await removeClientsFromServerGroup(client, asServerGroupID(9n), []);
    expect(sent).toEqual([]);
  });
});

describe("permission batches", () => {
  const cid = asChannelID(2n);
  const cldbid = asClientDBID(3n);

  // Each row is complete: on raw ServerQuery, SSH and the voice protocol a row
  // without `permskip` is refused with 1539, so the flags are sent on every row.
  it("sends a complete row for each permission", async () => {
    const { client, sent } = recorder();
    await addChannelPermissions(client, cid, [
      { permission: talk, value: 1 },
      { permission: permissionByID(7 as never), value: 2 },
    ]);
    await addChannelGroupPermissions(client, asChannelGroupID(4n), [
      { permission: talk, value: 1 },
    ]);
    await addChannelClientPermissions(client, cid, cldbid, [
      { permission: talk, value: 1 },
      { permission: poke, value: 2 },
    ]);
    await addClientPermissions(client, cldbid, [
      { permission: talk, value: 1 },
      { permission: poke, value: 2, skip: true },
    ]);
    await addServerGroupPermissions(client, asServerGroupID(9n), [
      { permission: talk, value: 1 },
      { permission: poke, value: 2, negated: true, skip: true },
    ]);
    await addServerGroupPermissionsByType(client, GroupAutoUpdateType.QueryGuest, [
      { permission: talk, value: 1 },
      { permission: poke, value: 2 },
    ]);
    expect(sent).toEqual([
      "channeladdperm cid=2 permsid=i_client_talk_power permvalue=1|permid=7 permvalue=2",
      "channelgroupaddperm cgid=4 permsid=i_client_talk_power permvalue=1",
      "channelclientaddperm cid=2 cldbid=3 permsid=i_client_talk_power permvalue=1|permsid=i_client_poke_power permvalue=2",
      "clientaddperm cldbid=3 permsid=i_client_talk_power permvalue=1 permskip=0|permsid=i_client_poke_power permvalue=2 permskip=1",
      "servergroupaddperm sgid=9 permsid=i_client_talk_power permvalue=1 permnegated=0 permskip=0|permsid=i_client_poke_power permvalue=2 permnegated=1 permskip=1",
      "servergroupautoaddperm sgtype=20 permsid=i_client_talk_power permvalue=1 permnegated=0 permskip=0|permsid=i_client_poke_power permvalue=2 permnegated=0 permskip=0",
    ]);
  });

  it("sends -continueonerror first on the commands the server documents it for", async () => {
    const { client, sent } = recorder();
    const one = [{ permission: talk, value: 1 }];
    const flag = { continueOnError: true };
    await addChannelPermissions(client, cid, one, flag);
    await addChannelGroupPermissions(client, asChannelGroupID(4n), one, flag);
    await addChannelClientPermissions(client, cid, cldbid, one, flag);
    await addClientPermissions(client, cldbid, one, flag);
    await addServerGroupPermissions(client, asServerGroupID(9n), one, flag);
    await deleteChannelGroupPermissions(client, asChannelGroupID(4n), [talk], flag);
    await deleteServerGroupPermissions(client, asServerGroupID(9n), [talk], flag);
    expect(sent.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual([
      "channeladdperm -continueonerror",
      "channelgroupaddperm -continueonerror",
      "channelclientaddperm -continueonerror",
      "clientaddperm -continueonerror",
      "servergroupaddperm -continueonerror",
      "channelgroupdelperm -continueonerror",
      "servergroupdelperm -continueonerror",
    ]);
  });

  it("removes several permissions as rows, never with the switch where it is not documented", async () => {
    const { client, sent } = recorder();
    await deleteChannelPermissions(client, cid, [talk, poke]);
    await deleteChannelGroupPermissions(client, asChannelGroupID(4n), [talk, poke]);
    await deleteChannelClientPermissions(client, cid, cldbid, [talk, poke]);
    await deleteClientPermissions(client, cldbid, [talk, poke]);
    await deleteServerGroupPermissions(client, asServerGroupID(9n), [talk, poke]);
    await deleteServerGroupPermissionsByType(client, GroupAutoUpdateType.QueryGuest, [talk, poke]);
    expect(sent).toEqual([
      "channeldelperm cid=2 permsid=i_client_talk_power|permsid=i_client_poke_power",
      "channelgroupdelperm cgid=4 permsid=i_client_talk_power|permsid=i_client_poke_power",
      "channelclientdelperm cid=2 cldbid=3 permsid=i_client_talk_power|permsid=i_client_poke_power",
      "clientdelperm cldbid=3 permsid=i_client_talk_power|permsid=i_client_poke_power",
      "servergroupdelperm sgid=9 permsid=i_client_talk_power|permsid=i_client_poke_power",
      "servergroupautodelperm sgtype=20 permsid=i_client_talk_power|permsid=i_client_poke_power",
    ]);
  });

  it("sends nothing for an empty batch, and refuses a permission that names nothing", async () => {
    const { client, sent } = recorder();
    await addChannelPermissions(client, cid, []);
    await deleteClientPermissions(client, cldbid, []);
    await addServerGroupPermissionsByType(client, GroupAutoUpdateType.QueryGuest, []);
    expect(sent).toEqual([]);
    await expect(
      addChannelPermissions(client, cid, [{ permission: {} as never, value: 1 }]),
    ).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });
});
