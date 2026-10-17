import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErrorCode, ServerError, asChannelID, asClientID } from "@honeybbq/teamspeak";
import { encodeRequest } from "../../core/internal.js";
import type { CommandRequest } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import {
  muteClients,
  unmuteClients,
  verifyChannelPassword,
  verifyServerPassword,
} from "./voice.js";

const hash = (p: string): string => createHash("sha1").update(p).digest("base64");

/** A client whose commands are encoded as the voice client encodes them, and answered by `answer`. */
function fake(answer: () => void): { client: Client; sent: string[] } {
  const sent: string[] = [];
  const client = {
    send: (request: CommandRequest) => {
      sent.push(encodeRequest(request, hash));
      answer();
      return Promise.resolve([]);
    },
  } as unknown as Client;
  return { client, sent };
}

describe("verifyServerPassword", () => {
  it("sends the hashed password and answers true on success", async () => {
    const { client, sent } = fake(() => {});
    expect(await verifyServerPassword(client, "pw")).toBe(true);
    expect(sent).toEqual([`verifyserverpassword password=${hash("pw").replaceAll("/", "\\/")}`]);
  });

  it("answers false for error 1028 and rethrows any other error", async () => {
    const mismatch = fake(() => {
      throw new ServerError(ErrorCode.ServerInvalidPassword, "invalid server password");
    });
    expect(await verifyServerPassword(mismatch.client, "x")).toBe(false);
    const other = fake(() => {
      throw new ServerError(ErrorCode.ChannelInvalidPassword, "nope");
    });
    await expect(verifyServerPassword(other.client, "x")).rejects.toBeInstanceOf(ServerError);
  });
});

describe("verifyChannelPassword", () => {
  it("sends the channel and the hashed password, true on success", async () => {
    const { client, sent } = fake(() => {});
    expect(await verifyChannelPassword(client, asChannelID(3n), "hunter2")).toBe(true);
    expect(sent).toEqual([
      `verifychannelpassword cid=3 password=${hash("hunter2").replaceAll("/", "\\/")}`,
    ]);
  });

  it("answers false for error 781 and rethrows an unknown channel", async () => {
    const mismatch = fake(() => {
      throw new ServerError(ErrorCode.ChannelInvalidPassword, "invalid channel password");
    });
    expect(await verifyChannelPassword(mismatch.client, asChannelID(3n), "x")).toBe(false);
    const unknown = fake(() => {
      throw new ServerError(ErrorCode.ChannelInvalidID, "invalid channelID");
    });
    await expect(
      verifyChannelPassword(unknown.client, asChannelID(9n), "x"),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe("muteClients and unmuteClients", () => {
  it("send one clid row per client, joined with a pipe", async () => {
    const { client, sent } = fake(() => {});
    await muteClients(client, [asClientID(3), asClientID(7)]);
    await unmuteClients(client, [asClientID(3), asClientID(7)]);
    await muteClients(client, [asClientID(5)]);
    expect(sent).toEqual([
      "clientmute clid=3|clid=7",
      "clientunmute clid=3|clid=7",
      "clientmute clid=5",
    ]);
  });

  it("send nothing for an empty list", async () => {
    const { client, sent } = fake(() => {});
    await muteClients(client, []);
    await unmuteClients(client, []);
    expect(sent).toEqual([]);
  });
});
