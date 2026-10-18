import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createChannel,
  editChannel,
  addChannelPermission,
  getChannelInfo,
  listChannels,
} from "./channels.js";
import {
  getClientConnectionInfo,
  getClientIDs,
  getClientNameByDBID,
  iterateClientDatabase,
  kickClient,
  listClientPermissions,
  listClients,
  moveClient,
  updateClient,
} from "./clients.js";
import type { KickReason } from "./clients.js";
import {
  createdGroupID,
  date,
  durationMs,
  encodeFields,
  permissionParam,
  toWireDuration,
  MILLISECOND,
  SECOND,
} from "./command.js";
import type { WireNames } from "./command.js";
import { deleteFile, getFileInfo, initFileUpload, listFiles, renameFile } from "./files.js";
import {
  addPrivilegeKey,
  listChannelGroupClients,
  findPermission,
  getPermissionOverview,
  listPermissions,
  listPrivilegeKeys,
} from "./groups.js";
import type { PrivilegeKeyOptions } from "./groups.js";
import {
  addBan,
  banClient,
  listBans,
  listComplaints,
  sendChannelMessage,
  updateMessageFlag,
  viewLog,
} from "./moderation.js";
import {
  addServerGroupPermission,
  addTempPassword,
  listBindings,
  listServerGroups,
} from "./server.js";
import {
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientID,
  asPermissionID,
  asMessageID,
  asServerGroupID,
  asUID,
} from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandOptions, CommandRequest } from "../command/request.js";
import { Codec, PrivilegeKeyType } from "../enums.js";
import { ErrorCode } from "../errorcode.js";
import { NoDataError, ServerError } from "../errors.js";
import { permissionByID, permissionByName } from "../permission.js";
import { Reason } from "../reason.js";

/**
 * An executor that encodes each request the way the voice client does and
 * records the result, so the assertions below read as what goes on the wire.
 * `execCommand` and `execCommandWithResponse` are the same recorder; the two
 * names keep the assertions readable for commands with and without data.
 */
/**
 * The voice protocol's password rule, base64(sha1(password)), so the wire forms
 * below are what the voice client sends.
 */
const voicePassword = (password: string): string =>
  createHash("sha1").update(password).digest("base64");

const fakeClient = () => {
  const execCommandWithResponse = vi
    .fn<(cmd: string, timeoutMs: number) => Promise<Array<Record<string, string>>>>()
    .mockResolvedValue([]);
  const client: CommandExecutor = {
    send: (request) => execCommandWithResponse(encodeRequest(request, voicePassword), 10_000),
  };
  return { client, execCommand: execCommandWithResponse, execCommandWithResponse };
};

describe("password handling", () => {
  // The client protocol expects base64(sha1(password)) for channel passwords,
  // unlike raw ServerQuery. Getting this wrong is invisible until a valid
  // password is rejected with 781.
  it("hashes the channel password in clientmove", async () => {
    const { client, execCommand } = fakeClient();
    await moveClient(client, asClientID(7), asChannelID(42n), { password: "7274" });

    const digest = createHash("sha1").update("7274").digest("base64");
    expect(execCommand).toHaveBeenCalledWith(
      `clientmove clid=7 cid=42 cpw=${digest.replaceAll("/", "\\/")}`,
      10_000,
    );
  });

  it("omits cpw entirely for an open channel", async () => {
    const { client, execCommand } = fakeClient();
    await moveClient(client, asClientID(7), asChannelID(42n));

    // Not `cpw=` — an empty parameter and no parameter are different things.
    expect(execCommand).toHaveBeenCalledWith("clientmove clid=7 cid=42", 10_000);
  });

  it("hashes the password in the file transfer commands too", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await listFiles(client, asChannelID(1), "/", { password: "secret" });

    const digest = createHash("sha1").update("secret").digest("base64");
    expect(execCommandWithResponse).toHaveBeenCalledWith(
      `ftgetfilelist cid=1 path=\\/ cpw=${digest.replaceAll("/", "\\/")}`,
      10_000,
    );
  });

  it("sends a multi-file delete as one row per name", async () => {
    const { client, execCommand } = fakeClient();
    await deleteFile(client, asChannelID(1), ["/a", "/b c"]);

    // One name parameter holding "/a|/b" (escaped as \p) is a single path,
    // which the server refuses; the names are rows of the command.
    expect(execCommand).toHaveBeenCalledWith(
      "ftdeletefile cid=1 cpw= name=\\/a|name=\\/b\\sc",
      10_000,
    );
  });
});

describe("parameter encoding", () => {
  it("encodes booleans as 0 and 1", async () => {
    const { client, execCommand } = fakeClient();
    const { deleteChannel } = await import("./channels.js");
    await deleteChannel(client, asChannelID(5), { force: true });
    expect(execCommand).toHaveBeenCalledWith("channeldelete cid=5 force=1", 10_000);

    await deleteChannel(client, asChannelID(5));
    expect(execCommand).toHaveBeenCalledWith("channeldelete cid=5 force=0", 10_000);
  });

  it("escapes values that would otherwise split the command", async () => {
    const { client, execCommand } = fakeClient();
    const { pokeClient } = await import("./clients.js");
    // A space, a pipe and a backslash are all parameter separators on the wire.
    await pokeClient(client, asClientID(3), "a b|c\\d");

    const call = execCommand.mock.calls[0]?.[0] as string;
    expect(call).toContain("msg=a\\sb\\pc\\\\d");
  });
});

describe("flags", () => {
  // `-uid` is a switch. The voice protocol also accepts `-uid=1`, but that is
  // not the documented form, and ServerQuery is not promised to.
  it("sends a flag bare", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await listClients(client, { away: true });

    expect(execCommandWithResponse).toHaveBeenCalledWith("clientlist -uid -away", 10_000);
  });

  it("asks for the icon with -icon", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    await listClients(client, { icon: true });

    expect(execCommandWithResponse).toHaveBeenCalledWith("clientlist -uid -icon", 10_000);
  });
});

describe("string fields", () => {
  // The parser unescapes once. A second pass turned a real `\s` into a space.
  it("returns the parsed value unchanged", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([{ sgid: "9", name: "C:\\stuff" }]);
    const [group] = await listServerGroups(client);

    expect(group?.name).toBe("C:\\stuff");
  });
});

describe("createdGroupID", () => {
  // The voice protocol answers servergroupadd with the whole list; the first
  // row is whatever group the server lists first.
  it("finds the new group by name in a full list", () => {
    const rows = [
      { sgid: "1", name: "Guest Server Query" },
      { sgid: "6", name: "Server Admin" },
      { sgid: "12", name: "bots" },
    ];
    expect(createdGroupID(rows, "sgid", "bots", "servergroupadd")).toBe(12n);
  });

  it("takes the newest when a name repeats", () => {
    const rows = [
      { sgid: "4", name: "bots" },
      { sgid: "12", name: "bots" },
    ];
    expect(createdGroupID(rows, "sgid", "bots", "servergroupadd")).toBe(12n);
  });

  it("reads a bare id, which is how ServerQuery answers", () => {
    expect(createdGroupID([{ sgid: "12" }], "sgid", "bots", "servergroupadd")).toBe(12n);
  });

  it("throws rather than returning another group's id", () => {
    expect(() =>
      createdGroupID([{ sgid: "1", name: "Guest" }], "sgid", "bots", "servergroupadd"),
    ).toThrow();
  });
});

describe("file transfer negotiation", () => {
  // The answer arrives after the command returns and is matched only by the
  // echoed clientftfid, so two negotiations must not share one.
  it("gives each negotiation its own clientftfid", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([{ ftkey: "k", port: "30033" }]);
    await initFileUpload(client, asChannelID(1n), "/a", 3n);
    await initFileUpload(client, asChannelID(1n), "/b", 3n);

    const ids = execCommandWithResponse.mock.calls.map(
      ([cmd]) => /clientftfid=(\d+)/.exec(cmd)?.[1],
    );
    expect(ids[0]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  });

  // An upload used to replace a file already at the path unless told not to.
  it("does not overwrite unless asked to", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([{ ftkey: "k", port: "30033" }]);
    await initFileUpload(client, asChannelID(1n), "/a", 3n);
    await initFileUpload(client, asChannelID(1n), "/a", 3n, { overwrite: true });

    const flags = execCommandWithResponse.mock.calls.map(
      ([cmd]) => /overwrite=(\d)/.exec(cmd)?.[1],
    );
    expect(flags).toEqual(["0", "1"]);
  });

  it("returns what the upload answer carries", async () => {
    const { client, execCommandWithResponse } = fakeClient();
    execCommandWithResponse.mockResolvedValue([
      { clientftfid: "1", serverftfid: "2", ftkey: "key", port: "30033", seekpos: "0" },
    ]);
    const info = await initFileUpload(client, asChannelID(1n), "/a", 3n);

    expect(info).toEqual({
      fileTransferKey: "key",
      port: 30033,
      seekPosition: 0n,
      clientFileTransferID: 1,
      serverFileTransferID: 2,
    });
  });
});

/**
 * An executor that records each request's wire form and the options it was
 * sent with, answering from a queue of row sets or errors.
 */
const recordingClient = (...answers: Array<Array<Record<string, string>> | Error>) => {
  const sent: string[] = [];
  const options: Array<CommandOptions | undefined> = [];
  const client: CommandExecutor = {
    send: async (request: CommandRequest, commandOptions?: CommandOptions) => {
      sent.push(encodeRequest(request, voicePassword));
      options.push(commandOptions);
      const answer = answers.shift() ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { client, sent, options };
};

const emptyResult = (): ServerError =>
  new ServerError(ErrorCode.DatabaseEmptyResult, "database empty result set");

describe("field tables", () => {
  interface Sample {
    readonly name?: string | undefined;
    readonly count?: number | undefined;
    readonly delayMs?: number | undefined;
  }
  const names: WireNames<Sample> = {
    name: "sample_name",
    count: "sample_count",
    delayMs: ["sample_delay", (ms) => toWireDuration(ms, SECOND)],
  };

  it("must name every field", () => {
    // @ts-expect-error: a field without a wire name does not compile.
    const missing: WireNames<Sample> = { name: "a", count: "b" };
    expect(missing).toBeDefined();
  });

  it("sends the fields that are set, under their wire names, in table order", () => {
    expect(encodeFields({ delayMs: 1500, name: "x", count: 3 }, names)).toEqual([
      ["sample_name", "x"],
      ["sample_count", 3],
      ["sample_delay", 2],
    ]);
  });

  it("omits an unset field and sends an empty string as empty", () => {
    expect(encodeFields({ name: "", count: undefined }, names)).toEqual([["sample_name", ""]]);
  });

  // A JavaScript caller can put anything in an options object. The table, not
  // the object, decides what reaches the wire.
  it("ignores a key the table does not name", () => {
    const options = { name: "x", channel_password: "oops" } as Sample;
    expect(encodeFields(options, names)).toEqual([["sample_name", "x"]]);
  });

  it("does that for the real commands too", async () => {
    const { client, sent } = recordingClient([{ cid: "7" }]);
    await createChannel(client, {
      name: "Room",
      topic: "",
      codec: Codec.OpusVoice,
      deleteDelayMs: 30_000,
      channel_flag_default: true,
    } as Parameters<typeof createChannel>[1]);

    expect(sent[0]).toBe(
      "channelcreate channel_name=Room channel_topic= channel_codec=4 channel_delete_delay=30",
    );
  });

  it("writes the channel banner on create and edit", async () => {
    const { client, sent } = recordingClient([{ cid: "7" }]);
    await createChannel(client, {
      name: "Room",
      bannerURL: "https://example.com/b.png",
      bannerMode: 2,
    });
    await editChannel(client, asChannelID(3), { bannerURL: "", bannerMode: 0 });

    expect(sent).toEqual([
      "channelcreate channel_name=Room channel_banner_gfx_url=https:\\/\\/example.com\\/b.png channel_banner_mode=2",
      "channeledit cid=3 channel_banner_gfx_url= channel_banner_mode=0",
    ]);
  });

  it("clears a password with an empty string, and leaves it alone when unset", async () => {
    const { client, sent } = recordingClient();
    await editChannel(client, asChannelID(3), { password: "" });
    await editChannel(client, asChannelID(3), { name: "n" });

    expect(sent).toEqual([
      "channeledit cid=3 channel_password=",
      "channeledit cid=3 channel_name=n",
    ]);
  });

  it("names our own client state in camelCase", async () => {
    const { client, sent } = recordingClient();
    await updateClient(client, { nickname: "bot", isAway: true, awayMessage: "" });

    expect(sent[0]).toBe("clientupdate client_nickname=bot client_away=1 client_away_message=");
  });
});

describe("Permission", () => {
  it("is sent as permid or permsid, whichever names it", async () => {
    const { client, sent } = recordingClient();
    await addChannelPermission(client, asChannelID(1), permissionByID(asPermissionID(86)), 50);
    await addChannelPermission(client, asChannelID(1), permissionByName("i_icon_id"), 50);

    expect(sent).toEqual([
      "channeladdperm cid=1 permid=86 permvalue=50",
      "channeladdperm cid=1 permsid=i_icon_id permvalue=50",
    ]);
  });

  it("refuses a permission naming nothing rather than sending neither", () => {
    expect(() => permissionParam({} as never)).toThrow(TypeError);
    expect(() => permissionParam(permissionByName(""))).toThrow(TypeError);
  });

  it("is read back in the form the server sent it", async () => {
    const { client } = recordingClient([
      { permid: "86", permvalue: "50", permnegated: "0", permskip: "1" },
      { permsid: "i_icon_id", permvalue: "-1" },
    ]);
    const entries = await listClientPermissions(client, asClientDBID(1));

    expect(entries).toEqual([
      { permission: { id: 86 }, value: 50, negated: false, skip: true },
      { permission: { name: "i_icon_id" }, value: -1, negated: false, skip: false },
    ]);
  });

  it("types each location by its target, and skips a target it cannot name", async () => {
    const { client } = recordingClient([
      { t: "3", id1: "4", id2: "9", p: "1" },
      { t: "4", id1: "4", id2: "7", p: "1" },
      { t: "99", id1: "1", id2: "1", p: "1" },
    ]);
    expect(await findPermission(client, permissionByID(asPermissionID(1)))).toEqual([
      { target: 3, channelID: 4n, channelGroupID: 9n, permission: 1 },
      { target: 4, channelID: 4n, databaseID: 7n, permission: 1 },
    ]);
  });

  it("asks permoverview for every permission, since it needs one", async () => {
    const { client, sent } = recordingClient([
      { t: "0", id1: "8", id2: "0", p: "25", v: "1", n: "0", s: "0" },
    ]);
    const [entry] = await getPermissionOverview(client, asChannelID(1), asClientDBID(3));

    expect(sent[0]).toBe("permoverview cid=1 cldbid=3 permid=0");
    expect(entry).toEqual({
      target: 0,
      serverGroupID: 8n,
      permission: 25,
      value: 1,
      negated: false,
      skip: false,
    });
  });
});

describe("timestamps and durations", () => {
  const at = (raw: string): Date | undefined => date({ t: raw }, "t");

  it("reads 0, absence and garbage as no time, never 1970", () => {
    expect(at("0")).toBeUndefined();
    expect(at("-5")).toBeUndefined();
    expect(at("soon")).toBeUndefined();
    expect(date({}, "t")).toBeUndefined();
  });

  // TS6 sends some times in finer units than TS3's seconds; the magnitude
  // tells them apart.
  it("reads seconds, milliseconds, microseconds and nanoseconds as the same time", () => {
    const when = new Date("2026-10-12T03:35:46Z");
    const seconds = when.getTime() / 1000;
    for (const raw of [
      String(seconds),
      String(seconds * 1000),
      `${seconds * 1000}000`,
      `${seconds * 1000}000000`,
    ]) {
      expect(at(raw)).toEqual(when);
    }
  });

  it("reads a duration in the field's own unit", () => {
    expect(durationMs({ d: "60" }, "d", SECOND)).toBe(60_000);
    expect(durationMs({ d: "250" }, "d", MILLISECOND)).toBe(250);
    expect(durationMs({}, "d", SECOND)).toBe(0);
  });

  it("rounds a duration to the wire unit, never down to 0", () => {
    expect(toWireDuration(1499, SECOND)).toBe(1);
    expect(toWireDuration(1500, SECOND)).toBe(2);
    expect(toWireDuration(0, SECOND)).toBe(0);
    // 0 is "forever" for a ban, so a short ban must not round to it.
    expect(toWireDuration(1, SECOND)).toBe(1);
    expect(() => toWireDuration(-1, SECOND)).toThrow(RangeError);
    expect(() => toWireDuration(Number.NaN, SECOND)).toThrow(RangeError);
  });

  it("parses result rows into Dates and milliseconds", async () => {
    const { client } = recordingClient([
      { banid: "10", name: "probe", created: "1791776586", duration: "60" },
    ]);
    const [ban] = await listBans(client);

    expect(ban?.createdAt).toEqual(new Date(1_791_776_586_000));
    expect(ban?.durationMs).toBe(60_000);
  });
});

describe("bans", () => {
  it("sends a permanent ban without a time, and a short one as a second", async () => {
    const { client, sent } = recordingClient();
    await banClient(client, asClientID(5));
    await banClient(client, asClientID(5), { durationMs: 200, reason: "" });

    expect(sent).toEqual(["banclient clid=5", "banclient clid=5 time=1"]);
  });

  it("refuses a ban that matches nothing, and never sends an empty pattern", async () => {
    const { client, sent } = recordingClient();
    await expect(addBan(client, { ip: "", reason: "x" })).rejects.toThrow(TypeError);
    await addBan(client, { name: "troll", ip: "", uid: asUID(""), durationMs: 60_000 });

    expect(sent).toEqual(["banadd name=troll time=60"]);
  });

  // The ban used to extend CommandOptions, so a signal set on it was accepted
  // and never read: addBan reads its signal from its own last argument.
  it("keeps the ban's fields and the command's options apart", async () => {
    const { client, options } = recordingClient();
    const { signal } = new AbortController();
    // @ts-expect-error: a ban carries no signal.
    await addBan(client, { uid: asUID("x"), signal });
    await addBan(client, { uid: asUID("x") }, { signal, timeoutMs: 5 });
    await banClient(client, asClientID(5), { reason: "x", signal, timeoutMs: 5 });

    expect(options).toEqual([undefined, { signal, timeoutMs: 5 }, { signal, timeoutMs: 5 }]);
  });

  // The voice protocol reports no ban id.
  it("returns undefined from addBan when the server reports no id", async () => {
    const { client } = recordingClient([], [{ banid: "11" }]);
    expect(await addBan(client, { uid: asUID("x") })).toBeUndefined();
    expect(await addBan(client, { uid: asUID("x") })).toBe(11n);
  });

  // The server bans a client by address, uid and myTeamSpeak id, one ban each;
  // only the first id used to be returned.
  it("returns every ban banClient made, and none when the server reports none", async () => {
    const { client } = recordingClient([], [{ banid: "11" }, { banid: "12" }, { banid: "13" }]);
    expect(await banClient(client, asClientID(5))).toEqual([]);
    expect(await banClient(client, asClientID(5))).toEqual([11n, 12n, 13n]);
  });
});

describe("kicks", () => {
  it("sends the reason, and no message for an empty one", async () => {
    const { client, sent } = recordingClient();
    await kickClient(client, asClientID(4), Reason.KickServer, { reasonMessage: "bye" });
    await kickClient(client, asClientID(4), Reason.KickChannel, { reasonMessage: "" });

    expect(sent).toEqual([
      "clientkick clid=4 reasonid=5 reasonmsg=bye",
      "clientkick clid=4 reasonid=4",
    ]);
  });

  it("refuses a reason that is not a kick", async () => {
    const { client, sent } = recordingClient();
    // @ts-expect-error: only the two kick reasons compile.
    const ban: KickReason = Reason.KickServerBan;
    expect(ban).toBe(6);
    await expect(
      kickClient(client, asClientID(4), Reason.KickServerBan as unknown as KickReason),
    ).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});

describe("privilege keys", () => {
  it("encodes the group as tokenid1 and the channel as tokenid2", async () => {
    const { client, sent } = recordingClient([{ token: "a" }], [{ token: "b" }]);
    await addPrivilegeKey(client, { serverGroupID: asServerGroupID(6), description: "" });
    await addPrivilegeKey(client, {
      channelGroupID: asChannelGroupID(5),
      channelID: asChannelID(2),
      description: "mod",
    });

    expect(sent).toEqual([
      "privilegekeyadd tokentype=0 tokenid1=6 tokenid2=0",
      "privilegekeyadd tokentype=1 tokenid1=5 tokenid2=2 tokendescription=mod",
    ]);
  });

  it("refuses a key that is both kinds, or neither", async () => {
    const { client, sent } = recordingClient();
    const both = {
      serverGroupID: asServerGroupID(6),
      channelGroupID: asChannelGroupID(5),
      channelID: asChannelID(2),
    } as unknown as PrivilegeKeyOptions;
    await expect(addPrivilegeKey(client, both)).rejects.toThrow(TypeError);
    await expect(addPrivilegeKey(client, {} as PrivilegeKeyOptions)).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("reads each id into the field its token type gives it", async () => {
    const { client } = recordingClient([
      { token: "a", token_type: "0", token_id1: "6", token_id2: "0", token_created: "0" },
      { token: "b", token_type: "1", token_id1: "5", token_id2: "2", token_created: "1791764164" },
    ]);
    const [server, channel] = await listPrivilegeKeys(client);

    expect(server).toMatchObject({
      serverGroupID: 6n,
      channelGroupID: undefined,
      createdAt: undefined,
    });
    expect(channel).toMatchObject({ serverGroupID: undefined, channelGroupID: 5n, channelID: 2n });
    expect(channel?.createdAt).toEqual(new Date(1_791_764_164_000));
  });
});

describe("other fixes", () => {
  // Each log line is its own row, keyed l; the first row also carries the
  // positions.
  it("reads every log line", async () => {
    const { client, sent } = recordingClient([
      { last_pos: "14982", file_size: "15302", l: "first" },
      { l: "second" },
    ]);
    const page = await viewLog(client, { lines: 2, reverse: true, beginPosition: 0 });

    expect(sent[0]).toBe("logview lines=2 reverse=1 instance=0 begin_pos=0");
    expect(page).toEqual({ lines: ["first", "second"], lastPosition: 14982, fileSize: 15302 });
  });

  it("sends the caller's temporary password rather than an empty one", async () => {
    const { client, sent } = recordingClient();
    await addTempPassword(client, { password: "pw", description: "d", durationMs: 60_000 });
    await expect(
      addTempPassword(client, { password: "", description: "d", durationMs: 1 }),
    ).rejects.toThrow(TypeError);

    expect(sent).toEqual(["servertemppasswordadd pw=pw desc=d duration=60 tcid=0 tcpw="]);
  });

  it("names no channel in a channel message, since the server ignores one", async () => {
    const { client, sent } = recordingClient();
    await sendChannelMessage(client, "hi");
    expect(sent[0]).toBe("sendtextmessage targetmode=2 msg=hi");
  });

  it("tells directories from files, and reads TS6 times", async () => {
    const { client } = recordingClient(
      [
        { name: "dir", size: "0", datetime: "1791764662000", type: "0" },
        { name: "a.txt", size: "3", datetime: "1791768571000", type: "1" },
      ],
      [{ name: "/a.txt", size: "3", datetime: "1791768571000000000" }],
    );
    const [dir, file] = await listFiles(client, asChannelID(1), "/");
    const info = await getFileInfo(client, asChannelID(1), "/a.txt");

    expect(dir?.isDirectory).toBe(true);
    expect(file?.isDirectory).toBe(false);
    expect(info.modifiedAt).toEqual(file?.modifiedAt);
  });

  it("reads icon ids and channel order with their types", async () => {
    const { client } = recordingClient([
      { cid: "2", channel_order: "1", channel_icon_id: "-1528016466" },
      { cid: "3", channel_order: "2", channel_icon_id: "0" },
    ]);
    const [first, second] = await listChannels(client);

    expect(first?.order).toBe(1n);
    expect(first?.iconID).toBe(2766950830);
    expect(second?.iconID).toBeUndefined();
  });

  it("asks channellist for the topic, flags, voice, limits, icon, seconds empty and banners", async () => {
    const { client, sent } = recordingClient([]);
    await listChannels(client);

    expect(sent[0]).toBe("channellist -topic -flags -voice -limits -icon -secondsempty -banners");
  });

  it("reads every channellist field", async () => {
    const { client } = recordingClient([
      {
        cid: "5",
        pid: "2",
        channel_order: "4",
        channel_name: "Room",
        channel_topic: "Hello",
        channel_flag_default: "1",
        channel_flag_password: "1",
        channel_flag_permanent: "1",
        channel_flag_semi_permanent: "1",
        channel_codec: "4",
        channel_codec_quality: "7",
        channel_needed_talk_power: "9",
        channel_icon_id: "12",
        channel_maxclients: "-1",
        channel_maxfamilyclients: "30",
        total_clients: "3",
        total_clients_family: "8",
        channel_needed_subscribe_power: "6",
      },
    ]);
    const [channel] = await listChannels(client);

    expect(channel).toMatchObject({
      id: 5n,
      parentID: 2n,
      order: 4n,
      name: "Room",
      topic: "Hello",
      isDefault: true,
      hasPassword: true,
      isPermanent: true,
      isSemiPermanent: true,
      codec: 4,
      codecQuality: 7,
      neededTalkPower: 9,
      iconID: 12,
      maxClients: -1,
      maxFamilyClients: 30,
      totalClients: 3,
      totalFamilyClients: 8,
      neededSubscribePower: 6,
      description: "",
      uid: "",
    });
  });

  it("leaves the counts undefined when channelinfo does not carry them", async () => {
    const { client } = recordingClient([{ pid: "2", channel_name: "Room" }]);
    const info = await getChannelInfo(client, asChannelID(5n));

    expect(info.totalClients).toBeUndefined();
    expect(info.totalFamilyClients).toBeUndefined();
    expect(info.neededSubscribePower).toBeUndefined();
  });

  it("reads zero counts from channellist as zero", async () => {
    const { client } = recordingClient([
      {
        cid: "5",
        total_clients: "0",
        total_clients_family: "0",
        channel_needed_subscribe_power: "0",
      },
    ]);
    const [channel] = await listChannels(client);

    expect(channel).toMatchObject({
      totalClients: 0,
      totalFamilyClients: 0,
      neededSubscribePower: 0,
    });
  });

  it("fills a binding's subsystem and leaves a missing port undefined", async () => {
    const { client } = recordingClient([{ ip: "0.0.0.0" }], [{ ip: "::", port: "9987" }]);

    expect(await listBindings(client)).toEqual([
      { subsystem: "voice", ip: "0.0.0.0", port: undefined },
    ]);
    expect(await listBindings(client, { subsystem: "query" })).toEqual([
      { subsystem: "query", ip: "::", port: 9987 },
    ]);
  });

  it("reads an empty list as empty, not as a refusal", async () => {
    const { client } = recordingClient(emptyResult());
    expect(await listBans(client)).toEqual([]);
  });
});

describe("iterateClientDatabase", () => {
  const page = (...ids: number[]): Array<Record<string, string>> =>
    ids.map((id) => ({ cldbid: String(id), client_nickname: `c${id}` }));

  const collect = async (iterable: AsyncIterable<{ databaseID: bigint }>): Promise<bigint[]> => {
    const ids: bigint[] = [];
    for await (const entry of iterable) ids.push(entry.databaseID);
    return ids;
  };

  it("walks pages until the server reports 1281", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(3, 4), emptyResult());
    expect(await collect(iterateClientDatabase(client, { pageSize: 2 }))).toEqual([1n, 2n, 3n, 4n]);
    expect(sent).toEqual([
      "clientdblist start=0 duration=2",
      "clientdblist start=2 duration=2",
      "clientdblist start=4 duration=2",
    ]);
  });

  it("stops on a page shorter than an earlier one", async () => {
    const { client, sent } = recordingClient(page(1, 2, 3), page(4));
    expect(await collect(iterateClientDatabase(client, { pageSize: 3 }))).toEqual([1n, 2n, 3n, 4n]);
    expect(sent).toHaveLength(2);
  });

  // The server may cap a page below the size asked for, so a short first page
  // is not yet the end.
  it("asks again after a short first page", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(3, 4), page(5));
    expect(await collect(iterateClientDatabase(client))).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(sent).toEqual([
      "clientdblist start=0 duration=100",
      "clientdblist start=2 duration=100",
      "clientdblist start=4 duration=100",
    ]);
  });

  it("stops when the server ignores start rather than looping on page one", async () => {
    const { client, sent } = recordingClient(page(1, 2), page(1, 2));
    expect(await collect(iterateClientDatabase(client, { pageSize: 2 }))).toEqual([1n, 2n]);
    expect(sent).toHaveLength(2);
  });

  it("throws any other error from the loop", async () => {
    const refusal = new ServerError(ErrorCode.PermissionsClientInsufficient, "insufficient");
    const { client } = recordingClient(page(1, 2), refusal);
    const seen: bigint[] = [];
    await expect(
      (async () => {
        for await (const entry of iterateClientDatabase(client, { pageSize: 2 })) {
          seen.push(entry.databaseID);
        }
      })(),
    ).rejects.toBe(refusal);
    expect(seen).toEqual([1n, 2n]);
  });

  it("gives every page the signal and timeoutMs, but not the page size", async () => {
    const { signal } = new AbortController();
    const { client, options } = recordingClient(page(1), emptyResult());
    await collect(iterateClientDatabase(client, { pageSize: 5, signal, timeoutMs: 1234 }));

    expect(options).toEqual([
      { signal, timeoutMs: 1234 },
      { signal, timeoutMs: 1234 },
    ]);
  });
});

describe("CommandOptions", () => {
  it("reaches send as its signal and timeoutMs", async () => {
    const { signal } = new AbortController();
    const commandOptions = { signal, timeoutMs: 500 };
    const { client, options } = recordingClient([], [], [{ cid: "9" }]);

    await listChannels(client, commandOptions);
    await moveClient(client, asClientID(1), asChannelID(2), { password: "pw", ...commandOptions });
    await createChannel(client, { name: "x" }, commandOptions);
    await listFiles(client, asChannelID(1), "/", { password: "", ...commandOptions });

    // The executor sees the signal and timeoutMs, never a command's own options.
    expect(options).toEqual([commandOptions, commandOptions, commandOptions, commandOptions]);
  });

  it("is undefined when the caller passes none", async () => {
    const { client, options } = recordingClient();
    await listChannels(client);
    expect(options).toEqual([undefined]);
  });
});

describe("names", () => {
  // One name per concept, as the Go SDK has them.
  it("reads a channel's unique identifier as uid, a ChannelUID", async () => {
    const { client } = recordingClient([{ cid: "1", channel_unique_identifier: "abc" }]);
    const [channel] = await listChannels(client);
    expect(channel?.uid).toBe("abc");
    expect(channel).not.toHaveProperty("uniqueIdentifier");
  });

  it("names the privilege key types PrivilegeKeyType", () => {
    expect(PrivilegeKeyType).toEqual({ ServerGroup: 0, ChannelGroup: 1 });
  });
});

// The same call encodes the same way in the Go SDK.
describe("parameter parity", () => {
  it("renames a file with cpw always, and tcid and tcpw only together", async () => {
    const { client, sent } = recordingClient();
    const cid = asChannelID(1n);
    await renameFile(client, cid, "/a", "/b");
    await renameFile(client, cid, "/a", "/b", { targetChannelPassword: "x" });
    await renameFile(client, cid, "/a", "/b", { targetChannelID: asChannelID(0n) });
    await renameFile(client, cid, "/a", "/b", { targetChannelID: asChannelID(2n) });

    const plain = "ftrenamefile cid=1 oldname=\\/a newname=\\/b cpw=";
    expect(sent).toEqual([plain, plain, plain, `${plain} tcid=2 tcpw=`]);
  });

  it("views the log with reverse and instance always, lines only when above 0", async () => {
    const { client, sent } = recordingClient([{ last_pos: "0" }], [{ last_pos: "0" }]);
    await viewLog(client);
    await viewLog(client, { lines: 0, instance: true });

    expect(sent).toEqual(["logview reverse=0 instance=0", "logview reverse=0 instance=1"]);
  });

  it("omits an id of 0 where it filters or targets", async () => {
    const { client, sent } = recordingClient([{ cid: "9" }]);
    const zeroDB = asClientDBID(0n);
    await createChannel(client, { name: "x", parentID: asChannelID(0n) });
    await listChannelGroupClients(client, {
      channelID: asChannelID(0n),
      databaseID: zeroDB,
      groupID: asChannelGroupID(0n),
    });
    await listComplaints(client, { targetDatabaseID: zeroDB });
    await listBindings(client, { subsystem: "" });

    expect(sent).toEqual([
      "channelcreate channel_name=x",
      "channelgroupclientlist",
      "complainlist",
      "bindinglist",
    ]);
  });

  it("refuses a permission with id 0, which names none", async () => {
    const { client, sent } = recordingClient();
    await expect(
      addChannelPermission(client, asChannelID(1n), permissionByID(asPermissionID(0)), 1),
    ).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });
});

describe("listPermissions", () => {
  it("numbers the permissions by position over the voice protocol, which sends no permid", async () => {
    // As both servers' failed_permid confirms, a permission's id there is its
    // place among the named rows.
    const { client } = recordingClient([
      { group_id_end: "0" },
      { group_id_end: "2" },
      { group_id_end: "2", permname: "b_serverinstance_help_view", permdesc: "help" },
      { group_id_end: "2", permname: "b_serverinstance_info_view", permdesc: "info" },
    ]);
    expect(await listPermissions(client)).toEqual([
      { id: 1, name: "b_serverinstance_help_view", description: "help" },
      { id: 2, name: "b_serverinstance_info_view", description: "info" },
    ]);
  });

  it("takes the permid ServerQuery sends", async () => {
    const { client } = recordingClient([
      { permid: "1", permname: "b_serverinstance_help_view", permdesc: "" },
      { permid: "32769", permname: "i_needed_modify_power_serverinstance_help_view", permdesc: "" },
    ]);
    expect((await listPermissions(client)).map((p) => p.id)).toEqual([1, 32769]);
  });
});

describe("answers that are records", () => {
  it("names every client behind a uid with the nickname it uses", async () => {
    const { client } = recordingClient([
      { cluid: "u=", clid: "4", name: "alice" },
      { cluid: "u=", clid: "9", name: "alice2" },
    ]);

    expect(await getClientIDs(client, asUID("u="))).toEqual([
      { id: asClientID(4), nickname: "alice" },
      { id: asClientID(9), nickname: "alice2" },
    ]);
  });

  it("names a database id's record as a uid's", async () => {
    const { client } = recordingClient([{ cluid: "u=", cldbid: "12", name: "alice" }]);

    expect(await getClientNameByDBID(client, asClientDBID(12))).toEqual({
      databaseID: asClientDBID(12),
      name: "alice",
      uid: "u=",
    });
  });
});

describe("addServerGroupPermission", () => {
  it("takes the permission and value as its siblings do, and negated and skip as options", async () => {
    const { client, sent } = recordingClient();
    const permission = permissionByID(asPermissionID(7));
    await addServerGroupPermission(client, asServerGroupID(6n), permission, 50);
    await addServerGroupPermission(client, asServerGroupID(6n), permission, 50, {
      negated: true,
      skip: true,
    });

    expect(sent).toEqual([
      "servergroupaddperm sgid=6 permid=7 permvalue=50 permnegated=0 permskip=0",
      "servergroupaddperm sgid=6 permid=7 permvalue=50 permnegated=1 permskip=1",
    ]);
  });
});

describe("updateMessageFlag", () => {
  it("sends the flag of the record it is given", async () => {
    const { client, sent } = recordingClient();
    await updateMessageFlag(client, asMessageID(3), { read: true });
    await updateMessageFlag(client, asMessageID(3), { read: false });

    expect(sent).toEqual(["messageupdateflag msgid=3 flag=1", "messageupdateflag msgid=3 flag=0"]);
  });
});

describe("createChannel without a cid in the answer", () => {
  /** An executor whose channelcreate returns no rows, and whose channellist lists `channels`. */
  const answering = (channels: Array<Record<string, string>>) => {
    const sent: string[] = [];
    const client: CommandExecutor = {
      send: (request) => {
        sent.push(encodeRequest(request, voicePassword));
        return Promise.resolve(request.command === "channellist" ? channels : []);
      },
    };
    return { client, sent };
  };

  it("finds the new channel by its exact name and parent", async () => {
    const { client, sent } = answering([
      { cid: "1", pid: "0", channel_name: "Room" },
      { cid: "2", pid: "1", channel_name: "Room" },
      { cid: "3", pid: "1", channel_name: "Room 2" },
    ]);
    expect(await createChannel(client, { name: "Room", parentID: asChannelID(1n) })).toBe(2n);
    expect(await createChannel(client, { name: "Room" })).toBe(1n);
    expect(sent.filter((l) => l.startsWith("channellist"))).toHaveLength(2);
  });

  it("throws NoDataError when no channel matches", async () => {
    const { client } = answering([{ cid: "1", pid: "0", channel_name: "Other" }]);
    await expect(createChannel(client, { name: "Room" })).rejects.toBeInstanceOf(NoDataError);
    await expect(
      createChannel(client, { name: "Other", parentID: asChannelID(5n) }),
    ).rejects.toBeInstanceOf(NoDataError);
  });

  it("does not look anything up when the answer has a cid", async () => {
    const { client, sent } = recordingClient([{ cid: "9" }]);
    expect(await createChannel(client, { name: "Room" })).toBe(9n);
    expect(sent).toHaveLength(1);
  });
});

describe("getClientConnectionInfo", () => {
  it("asks getconnectioninfo and reads the figures", async () => {
    const { client, sent } = recordingClient([
      {
        clid: "5",
        connection_ping: "12.5000",
        connection_ping_deviation: "1.2500",
        connection_connected_time: "4000",
        connection_idle_time: "3000",
        connection_client_ip: "10.0.0.1",
        connection_client_port: "9000",
        connection_packets_sent_speech: "7",
        connection_bytes_received_control: "800",
        connection_bandwidth_sent_last_minute_keepalive: "3",
        connection_server2client_packetloss_total: "0.0500",
        connection_client2server_packetloss_control: "0.1000",
      },
    ]);
    const info = await getClientConnectionInfo(client, asClientID(5));
    expect(sent).toEqual(["getconnectioninfo clid=5"]);
    expect(info).toMatchObject({
      id: 5,
      pingMs: 12.5,
      pingDeviationMs: 1.25,
      connectedTimeMs: 4000,
      idleTimeMs: 3000,
      ip: "10.0.0.1",
      port: 9000,
    });
    expect(info.sent.speech.packets).toBe(7);
    expect(info.received.control.bytes).toBe(800);
    expect(info.sent.keepalive.bandwidthLastMinute).toBe(3);
    expect(info.serverToClientLoss.total).toBe(0.05);
    expect(info.clientToServerLoss.control).toBe(0.1);
  });

  it("leaves ip and port out when the server does not send them", async () => {
    const { client } = recordingClient([{ clid: "5" }]);
    const info = await getClientConnectionInfo(client, asClientID(5));
    expect(info.ip).toBeUndefined();
    expect(info.port).toBeUndefined();
    expect(info.pingMs).toBe(0);
  });
});

describe("plugin commands and the typing indicator", () => {
  it("addresses the channel, the server, or one client", async () => {
    const { client, execCommand } = fakeClient();
    const { sendPluginCommand } = await import("./clients.js");

    await sendPluginCommand(client, "plug", "hello", "channel");
    await sendPluginCommand(client, "plug", "hello", "server");
    await sendPluginCommand(client, "plug", "hello", { clientID: asClientID(9) });

    expect(execCommand.mock.calls.map((c) => c[0])).toEqual([
      "plugincmd name=plug data=hello targetmode=0",
      "plugincmd name=plug data=hello targetmode=1",
      "plugincmd name=plug data=hello targetmode=2 target=9",
    ]);
  });

  it("escapes the name and sends an empty payload as empty", async () => {
    const { client, execCommand } = fakeClient();
    const { sendPluginCommand } = await import("./clients.js");

    await sendPluginCommand(client, "b2 plug", "a b|c/d", "channel");
    await sendPluginCommand(client, "plug", "", "channel");

    expect(execCommand.mock.calls.map((c) => c[0])).toEqual([
      "plugincmd name=b2\\splug data=a\\sb\\pc\\/d targetmode=0",
      "plugincmd name=plug data= targetmode=0",
    ]);
  });

  it("sends the typing indicator and the end of a chat to one client", async () => {
    const { client, execCommand } = fakeClient();
    const { sendChatComposing, closePrivateChat } = await import("./clients.js");

    await sendChatComposing(client, asClientID(9));
    await closePrivateChat(client, asClientID(9));

    expect(execCommand.mock.calls.map((c) => c[0])).toEqual([
      "clientchatcomposing clid=9",
      "clientchatclosed clid=9",
    ]);
  });
});
