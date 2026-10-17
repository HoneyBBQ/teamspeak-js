import { describe, it, expect } from "vitest";
import { copyServerGroup, createServerGroup } from "./server.js";
import { copyChannelGroup, createChannelGroup } from "./groups.js";
import type { CommandExecutor } from "../command/request.js";
import { GroupType } from "../enums.js";
import { NoDataError } from "../errors.js";
import { asChannelGroupID, asServerGroupID } from "../command/ids.js";

/** An executor whose create answers no rows, and whose `listCommand` lists `listed`. */
const answering = (listCommand: string, listed: Array<Record<string, string>>) => {
  const sent: string[] = [];
  const client: CommandExecutor = {
    send: (request) => {
      sent.push(request.command);
      return Promise.resolve(request.command === listCommand ? listed : []);
    },
  };
  return { client, sent };
};

const serverRow = (sgid: string, name: string, type: number) => ({
  sgid,
  name,
  type: String(type),
  savedb: "1",
});
const channelRow = (cgid: string, name: string, type: number) => ({
  cgid,
  name,
  type: String(type),
  savedb: "1",
});

describe.each([
  {
    label: "createServerGroup",
    list: "servergrouplist",
    row: serverRow,
    run: (c: CommandExecutor, type: GroupType) => createServerGroup(c, "bots", type),
  },
  {
    label: "copyServerGroup",
    list: "servergrouplist",
    row: serverRow,
    run: (c: CommandExecutor, type: GroupType) =>
      copyServerGroup(c, asServerGroupID(5n), asServerGroupID(0n), "bots", type),
  },
  {
    label: "createChannelGroup",
    list: "channelgrouplist",
    row: channelRow,
    run: (c: CommandExecutor, type: GroupType) => createChannelGroup(c, "bots", type),
  },
  {
    label: "copyChannelGroup",
    list: "channelgrouplist",
    row: channelRow,
    run: (c: CommandExecutor, type: GroupType) =>
      copyChannelGroup(c, asChannelGroupID(5n), asChannelGroupID(0n), "bots", type),
  },
])("$label without an id in the answer", ({ list, row, run }) => {
  it("takes the group of the requested name and type", async () => {
    const { client, sent } = answering(list, [
      row("1", "bots", GroupType.Template),
      row("2", "other", GroupType.Regular),
      row("3", "bots", GroupType.Regular),
      row("4", "bots", GroupType.Query),
    ]);
    expect(await run(client, GroupType.Regular)).toBe(3n);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(list);
  });

  it("throws NoDataError when no group matches", async () => {
    const { client } = answering(list, [
      row("1", "bots", GroupType.Template),
      row("2", "other", GroupType.Regular),
    ]);
    await expect(run(client, GroupType.Regular)).rejects.toBeInstanceOf(NoDataError);
  });
});

describe("copying onto an existing group", () => {
  it("needs no lookup", async () => {
    const { client, sent } = answering("servergrouplist", []);
    const id = await copyServerGroup(
      client,
      asServerGroupID(5n),
      asServerGroupID(7n),
      "bots",
      GroupType.Regular,
    );
    expect(id).toBe(7n);
    expect(sent).toEqual(["servergroupcopy"]);
  });
});
