import { describe, expect, it } from "vitest";
import { createChannel, editChannel } from "./channels.js";
import type { ChannelSettings } from "./channels.js";
import { applyClientChanges, editClient, updateClient } from "./clients.js";
import type {
  ClientChanges,
  ClientEditOptions,
  ClientEntry,
  ClientUpdateOptions,
} from "./clients.js";
import {
  applyChannelChanges,
  channelFields,
  parseChannel,
  parseChannelChanges,
} from "./command.js";
import type { Channel, ChannelChanges } from "./command.js";
import { clientFields, parseClient, parseClientChanges } from "./parse.js";
import type { CommandExecutor, CommandRequest } from "../command/request.js";

// ---- Name parity, at the type level ------------------------------------------
// Each constant fails to compile when a name an options type writes is not one
// the record reads, or when the two disagree about its value type.

type Missing<A, B> = [Exclude<keyof A, keyof B>] extends [never] ? true : never;
type Agrees<A, B> = [
  {
    [K in keyof A & keyof B]-?: [A[K]] extends [B[K] | undefined] ? true : never;
  }[keyof A & keyof B],
] extends [true]
  ? true
  : never;

const updateNamesAreRead: Missing<ClientUpdateOptions, ClientChanges> = true;
const editNamesAreRead: Missing<ClientEditOptions, ClientChanges> = true;
const settingNamesAreRead: Missing<Omit<ChannelSettings, "password">, ChannelChanges> = true;
const updateTypesAgree: Agrees<ClientUpdateOptions, ClientChanges> = true;
const editTypesAgree: Agrees<ClientEditOptions, ClientChanges> = true;
const settingTypesAgree: Agrees<Omit<ChannelSettings, "password">, ChannelChanges> = true;
void [
  updateNamesAreRead,
  editNamesAreRead,
  settingNamesAreRead,
  updateTypesAgree,
  editTypesAgree,
  settingTypesAgree,
];

// ---- Name parity, on the wire --------------------------------------------------

/** The parameters a command sends for one option, by capturing the request. */
async function sentKeys(run: (client: CommandExecutor) => Promise<unknown>): Promise<string[]> {
  const sent: CommandRequest[] = [];
  await run({
    send: (request) => {
      sent.push(request);
      return Promise.resolve([{ cid: "1" }]);
    },
  });
  return sent.flatMap((r) => (r.params ?? []).map(([key]) => key));
}

// Every key of each options type, so a new option without a sample fails to compile.
const updateSamples: Required<ClientUpdateOptions> = {
  nickname: "n",
  nicknamePhonetic: "n",
  isInputMuted: true,
  isOutputMuted: true,
  hasInputHardware: true,
  hasOutputHardware: true,
  isAway: true,
  awayMessage: "a",
  isChannelCommander: true,
  isRecording: true,
  isRequestingTalk: true,
  talkRequestMessage: "t",
  avatar: "a",
  badges: "b",
  metaData: "m",
};
const editSamples: Required<ClientEditOptions> = { description: "d", isTalker: true };
const settingSamples: Required<Omit<ChannelSettings, "password">> = {
  topic: "t",
  description: "d",
  hasPassword: true,
  codec: 4,
  codecQuality: 5,
  codecLatencyFactor: 1,
  isUnencrypted: true,
  maxClients: 3,
  maxFamilyClients: 3,
  isMaxClientsUnlimited: true,
  isMaxFamilyClientsUnlimited: true,
  isMaxFamilyClientsInherited: true,
  order: 0n as never,
  neededTalkPower: 1,
  isPermanent: true,
  isSemiPermanent: true,
  isDefault: true,
  deleteDelayMs: 1000,
  namePhonetic: "p",
  bannerURL: "https://example.com/b.png",
  bannerMode: 1,
};

describe("record names against the options that write them", () => {
  it.each(Object.entries(updateSamples))(
    "updateClient %s is read from its own wire key",
    async (field, value) => {
      const keys = await sentKeys((c) => updateClient(c, { [field]: value }));
      expect(keys).toHaveLength(1);
      expect(clientFields[field as keyof typeof clientFields].keys).toContain(keys[0]);
    },
  );

  it.each(Object.entries(editSamples))(
    "editClient %s is read from its own wire key",
    async (field, value) => {
      const keys = (await sentKeys((c) => editClient(c, 1 as never, { [field]: value }))).filter(
        (k) => k !== "clid",
      );
      expect(keys).toHaveLength(1);
      expect(clientFields[field as keyof typeof clientFields].keys).toContain(keys[0]);
    },
  );

  it.each(Object.entries(settingSamples))(
    "channel setting %s is read from its own wire key",
    async (field, value) => {
      const created = await sentKeys((c) => createChannel(c, { name: "x", [field]: value }));
      const edited = await sentKeys((c) => editChannel(c, 1n as never, { [field]: value }));
      const key = created.find((k) => k.startsWith("channel_") && k !== "channel_name");
      expect(key).toBeDefined();
      expect(edited).toContain(key);
      expect(channelFields[field as keyof typeof channelFields].keys).toContain(key);
    },
  );

  it("every read key is unique to one field", () => {
    for (const table of [clientFields, channelFields] as Array<
      Record<string, { keys: readonly string[] }>
    >) {
      // `client_talk_request` is both the flag and the time of the request.
      const seen = Object.values(table)
        .flatMap((spec) => spec.keys)
        .filter((key) => key !== "client_talk_request");
      expect(new Set(seen).size).toBe(seen.length);
    }
  });
});

// ---- Records -----------------------------------------------------------------

const newFields = [
  "talkRequestedAt",
  "awayMessage",
  "isInputMuted",
  "isOutputMuted",
  "isOutputOnlyMuted",
  "hasInputHardware",
  "hasOutputHardware",
  "isChannelCommander",
  "isPrioritySpeaker",
  "talkPower",
  "isRequestingTalk",
  "talkRequestMessage",
  "description",
  "metaData",
  "avatar",
  "iconID",
  "nicknamePhonetic",
  "unreadMessages",
  "neededServerQueryViewPower",
  "channelGroupInheritedChannelID",
  "country",
  "version",
  "platform",
  "ip",
  "badges",
  "signedBadges",
  "myTeamSpeakID",
  "myTeamSpeakAvatar",
  "integrations",
  "userTag",
  "isStreaming",
];

/** An enter notification's row, carrying every key a record reads. */
const fullRow: Record<string, string> = {
  clid: "7",
  ctid: "3",
  client_nickname: "Bob",
  client_unique_identifier: "uid=",
  client_type: "0",
  client_servergroups: "6,8",
  client_away: "1",
  client_is_recording: "0",
  client_is_talker: "0",
  client_channel_group_id: "5",
  client_database_id: "42",
  client_away_message: "brb",
  client_input_muted: "1",
  client_output_muted: "0",
  client_outputonly_muted: "0",
  client_input_hardware: "1",
  client_output_hardware: "1",
  client_is_channel_commander: "0",
  client_is_priority_speaker: "0",
  client_talk_power: "75",
  client_talk_request: "1700000000",
  client_talk_request_msg: "please",
  client_description: "hi",
  client_meta_data: "m",
  client_flag_avatar: "abc",
  client_icon_id: "99",
  client_nickname_phonetic: "bob",
  client_unread_messages: "2",
  client_needed_serverquery_view_power: "75",
  client_channel_group_inherited_channel_id: "3",
  client_country: "DE",
  client_version: "3.6",
  client_platform: "Linux",
  connection_client_ip: "10.0.0.1",
  client_badges: "overwolf=0",
  client_signed_badges: "s",
  client_myteamspeak_id: "mid",
  client_myteamspeak_avatar: "mav",
  client_integrations: "i",
  client_user_tag: "tag",
  client_is_streaming: "1",
};

describe("parseClient", () => {
  it("reads every field a row names", () => {
    const entry = parseClient(fullRow) as unknown as Record<string, unknown>;
    for (const field of newFields) expect(entry[field], field).not.toBeUndefined();
    expect(entry["isRequestingTalk"]).toBe(true);
    expect(entry["isOutputMuted"]).toBe(false);
    expect(entry["databaseID"]).toBe(42n);
    expect(entry["iconID"]).toBe(99);
  });

  it("leaves the later fields undefined, not false or 0, for a bare list row", () => {
    const entry = parseClient({
      clid: "7",
      cid: "3",
      client_nickname: "Bob",
      client_unique_identifier: "u",
      client_type: "0",
    });
    for (const field of newFields) expect(field in entry, field).toBe(false);
    expect(entry.idleTimeMs).toBeUndefined();
    expect(entry.channelID).toBe(3n);
    expect(entry.type).toBe(0);
    expect(entry.uid).toBe("u");
  });

  it("leaves what a flag brings absent from a row without the flag", () => {
    // What `clientlist` with no flag carries: the id, channel, database id, nickname and type.
    const entry = parseClient({
      clid: "7",
      cid: "3",
      client_database_id: "9",
      client_nickname: "Bob",
      client_type: "1",
    });
    for (const field of [
      "uid",
      "serverGroups",
      "isAway",
      "isRecording",
      "isTalker",
      "channelGroupID",
      "createdAt",
      "lastConnectedAt",
      "idleTimeMs",
    ])
      expect(field in entry, field).toBe(false);
    expect(entry).toMatchObject({ id: 7, nickname: "Bob", channelID: 3n, type: 1 });
  });

  it("reads a flag's answer as what it says, including the falsy ones", () => {
    const entry = parseClient({
      clid: "7",
      cid: "3",
      client_nickname: "Bob",
      client_type: "0",
      client_away: "0",
      client_is_recording: "0",
      client_is_talker: "0",
      client_servergroups: "",
      client_unique_identifier: "",
    });
    expect(entry.isAway).toBe(false);
    expect(entry.isRecording).toBe(false);
    expect(entry.isTalker).toBe(false);
    expect(entry.serverGroups).toEqual([]);
    expect(entry.uid).toBe("");
  });

  it("covers every ClientEntry field with a table row", () => {
    const names = Object.keys(clientFields).sort();
    expect(names).toEqual(
      [
        ...newFields,
        "databaseID",
        "nickname",
        "uid",
        "channelID",
        "type",
        "serverGroups",
        "isAway",
        "isRecording",
        "isTalker",
        "channelGroupID",
        "createdAt",
        "lastConnectedAt",
        "idleTimeMs",
      ].sort(),
    );
  });
});

describe("parseClientChanges", () => {
  it("holds exactly the keys the row carried", () => {
    const changes = parseClientChanges({
      clid: "7",
      client_away: "0",
      client_away_message: "",
      client_servergroups: "",
      client_needed_serverquery_view_power: "75",
      client_something_new: "x",
    });
    expect(Object.keys(changes).sort()).toEqual(
      ["awayMessage", "isAway", "neededServerQueryViewPower", "serverGroups"].sort(),
    );
    expect(changes.isAway).toBe(false);
    expect(changes.serverGroups).toEqual([]);
    expect(Object.values(changes)).not.toContain(undefined);
  });

  it("is empty for a row of properties the SDK does not model", () => {
    expect(parseClientChanges({ clid: "7", client_foo: "1" })).toEqual({});
  });

  it("never carries the id", () => {
    expect("id" in parseClientChanges({ clid: "7", client_away: "1" })).toBe(false);
  });
});

describe("applyClientChanges", () => {
  const entry = parseClient({ ...fullRow, client_away: "1" });

  it("returns a new object and leaves the old one alone", () => {
    const next = applyClientChanges(entry, { isAway: false });
    expect(next).not.toBe(entry);
    expect(entry.isAway).toBe(true);
    expect(next.isAway).toBe(false);
    expect(next.nickname).toBe("Bob");
  });

  it("keeps a value the changes lack, and a false stays false", () => {
    const next = applyClientChanges(entry, parseClientChanges({ client_away: "0" }));
    expect(next.awayMessage).toBe("brb");
    expect(next.isAway).toBe(false);
  });

  it("clears a field the changes carry as undefined, and keeps one they lack", () => {
    const next = applyClientChanges(entry, { description: undefined });
    expect("description" in next).toBe(false);
    expect(next.nickname).toBe("Bob");
  });

  it("carries a cleared icon as a key holding undefined, and clears it", () => {
    const withIcon = parseClient({ ...fullRow, client_icon_id: "12" });
    expect(withIcon.iconID).toBe(12);
    const changes = parseClientChanges({ clid: "7", client_icon_id: "0" });
    expect("iconID" in changes).toBe(true);
    expect(changes.iconID).toBeUndefined();
    expect("iconID" in applyClientChanges(withIcon, changes)).toBe(false);
    expect(applyClientChanges(withIcon, parseClientChanges({ client_away: "1" })).iconID).toBe(12);
  });

  it("replaces a list whole", () => {
    expect(applyClientChanges(entry, { serverGroups: [] }).serverGroups).toEqual([]);
  });
});

describe("parseChannel", () => {
  it("leaves the properties channellist lacks undefined", () => {
    const channel = parseChannel({ cid: "2", cpid: "0", channel_name: "A", total_clients: "1" });
    expect(channel.totalClients).toBe(1);
    expect(channel.neededSubscribePower).toBeUndefined();
    for (const field of [
      "codecLatencyFactor",
      "isUnencrypted",
      "isMaxClientsUnlimited",
      "isMaxFamilyClientsUnlimited",
      "isMaxFamilyClientsInherited",
      "deleteDelayMs",
      "namePhonetic",
      "isForcedSilence",
      "bannerURL",
      "bannerMode",
    ]) {
      expect(field in channel, field).toBe(false);
    }
  });

  it("reads the properties channelinfo carries", () => {
    const channel: Channel = parseChannel({
      pid: "1",
      channel_codec_latency_factor: "2",
      channel_codec_is_unencrypted: "1",
      channel_flag_maxclients_unlimited: "0",
      channel_flag_maxfamilyclients_unlimited: "1",
      channel_flag_maxfamilyclients_inherited: "0",
      channel_delete_delay: "30",
      channel_name_phonetic: "ph",
      channel_forced_silence: "1",
      channel_banner_gfx_url: "http://x",
      channel_banner_mode: "1",
    });
    expect(channel.parentID).toBe(1n);
    expect(channel.codecLatencyFactor).toBe(2);
    expect(channel.isUnencrypted).toBe(true);
    expect(channel.isMaxClientsUnlimited).toBe(false);
    expect(channel.deleteDelayMs).toBe(30_000);
    expect(channel.bannerURL).toBe("http://x");
  });
});

describe("channel changes", () => {
  it("holds exactly the keys the row carried", () => {
    const changes = parseChannelChanges({
      cid: "2",
      channel_topic: "t",
      channel_flag_password: "0",
    });
    expect(Object.keys(changes).sort()).toEqual(["hasPassword", "topic"]);
  });

  it("applies without erasing what the row did not carry", () => {
    const channel = parseChannel({ cid: "2", channel_name: "A", channel_topic: "old" });
    const next = applyChannelChanges(
      channel,
      parseChannelChanges({ cid: "2", channel_topic: "new" }),
    );
    expect(next).toMatchObject({ topic: "new", name: "A" });
    expect(channel.topic).toBe("old");
  });

  it("carries an icon of 0 and an empty time of -1 as cleared, and clears them", () => {
    const channel = parseChannel({
      cid: "2",
      channel_icon_id: "12",
      seconds_empty: "30",
      channel_codec_is_unencrypted: "1",
    });
    expect(channel.iconID).toBe(12);
    expect(channel.emptyForMs).toBe(30_000);
    const changes = parseChannelChanges({ cid: "2", channel_icon_id: "0", seconds_empty: "-1" });
    expect(Object.keys(changes).sort()).toEqual(["emptyForMs", "iconID"]);
    expect(changes.iconID).toBeUndefined();
    const next = applyChannelChanges(channel, changes);
    expect(next.iconID).toBeUndefined();
    expect(next.emptyForMs).toBeUndefined();
    expect(next.isUnencrypted).toBe(true);
  });

  it("leaves the icon alone when the row does not carry it", () => {
    const channel = parseChannel({ cid: "2", channel_icon_id: "12" });
    expect(applyChannelChanges(channel, parseChannelChanges({ channel_topic: "t" })).iconID).toBe(
      12,
    );
  });
});

// A record built by hand, as a test or a fake would, needs only what every source carries.
const handBuilt: ClientEntry = {
  id: 1 as never,
  nickname: "",
  uid: "" as never,
  channelID: 0n as never,
  type: 0,
  databaseID: 0n as never,
};
void handBuilt;
