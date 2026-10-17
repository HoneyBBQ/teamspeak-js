import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { avatarFileName } from "./avatars.js";
import { iconFileName, iconIDOf, setChannelIcon, setServerIcon, removeIcon } from "./icons.js";
import { asChannelID, asIconID } from "../command/ids.js";
import { encodeRequest } from "../command/request.js";
import type { CommandExecutor, CommandRequest } from "../command/request.js";

const recording = () => {
  const sent: string[] = [];
  const client: CommandExecutor = {
    send: async (request: CommandRequest) => {
      sent.push(encodeRequest(request, (p) => p));
      return [];
    },
  };
  return { client, sent };
};

describe("avatarFileName", () => {
  // Each pair is a unique id and the name the server listed for that client's
  // avatar in channel 0 (also its client_base64HashClientUID).
  it("spells a TeamSpeak 3 unique id (20 bytes) in the letters a to p", () => {
    expect(avatarFileName("KqXRNkJgnzjGFbp0GTCPJN1ODJY=")).toBe(
      "avatar_ckkfnbdgecgajpdimgbflkhebjdaipcenneoamjg",
    );
  });

  it("spells a TeamSpeak 6 unique id (32 bytes) in the letters a to p", () => {
    expect(avatarFileName("HYqkXu981igdjfxleVv2aYOmdkdumh2pFrkTSLRHG5k=")).toBe(
      "avatar_bnikkefoophmngcibninpmgfhjflpggjidkghgehgojkbnkjbgljbdeileehbljj",
    );
  });

  it("refuses text that is not base64", () => {
    expect(() => avatarFileName("")).toThrow(TypeError);
    expect(() => avatarFileName("not base64!")).toThrow(TypeError);
  });
});

describe("icon ids", () => {
  it("is the standard CRC-32, unsigned", () => {
    expect(iconIDOf(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(iconIDOf(new Uint8Array())).toBe(0);
    for (let i = 0; i < 50; i++) {
      const data = Buffer.from(`\x89PNG icon ${i * 7919}`.repeat(i + 1));
      expect(iconIDOf(data)).toBe(crc32(data));
    }
  });

  it("names the file as the server stores it", () => {
    expect(iconFileName(asIconID(3009859579))).toBe("/icon_3009859579");
  });

  it("sets an icon as the signed permission value the server reported", async () => {
    const { client, sent } = recording();
    // 3009859579 was listed by the server as -1285107717 for the same icon.
    await setChannelIcon(client, asChannelID(4n), asIconID(3009859579));
    await setChannelIcon(client, asChannelID(4n), undefined);
    await setServerIcon(client, asIconID(3009859579));
    await setServerIcon(client, undefined);
    await removeIcon(client, asIconID(5));
    expect(sent).toEqual([
      "channeladdperm cid=4 permsid=i_icon_id permvalue=-1285107717",
      "channeldelperm cid=4 permsid=i_icon_id",
      "serveredit virtualserver_icon_id=3009859579",
      "serveredit virtualserver_icon_id=0",
      "ftdeletefile cid=0 cpw= name=\\/icon_5",
    ]);
  });
});
