import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asIconID, avatarFileName, iconIDOf } from "@honeybbq/teamspeak";
import type { CommandRequest } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import { parseServerCapabilities } from "../capabilities.js";
import { S3TransferError, S3UnsupportedError } from "../errors.js";
import {
  deleteS3Icon,
  downloadS3Avatar,
  downloadS3Icon,
  removeS3Avatar,
  uploadS3Avatar,
  uploadS3Icon,
} from "./s3-avatars.js";

const UID = "PRXMsRKr0VFxsQFFqTrrMvXuA4xBp2+cyd0c5IR64A0=";
const URL_ = "https://teamspeak.s3.example/0123/0/x?X-Amz-Signature=secret";

/** A TeamSpeak 6 server with S3 that answers by command name. */
function server(extensions = "s3") {
  const sent: CommandRequest[] = [];
  const client = {
    uid: UID,
    serverCapabilities: parseServerCapabilities({
      virtualserver_version: "6.0.0-beta13.1 [Build: 1790080330]",
      virtualserver_capability_extensions: extensions,
    }),
    send: async (request: CommandRequest) => {
      sent.push(request);
      if (request.command === "s3ft_getpresignedurl") {
        const key = request.rows?.[1]?.find(([k]) => k === "key")?.[1];
        return [{ notify_presigned_urls: "", url: URL_, key: String(key) }];
      }
      if (request.command.startsWith("s3ft_")) return [{ success: "1" }];
      return [];
    },
  } as unknown as Client;
  return { client, sent };
}

function storage(...responses: Response[]) {
  const methods: string[] = [];
  const fetch = (async (_: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return responses.shift() ?? new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, methods };
}

const presignedKey = (r: CommandRequest) => r.rows?.[1]?.find(([k]) => k === "key")?.[1];

describe("uploadS3Avatar", () => {
  it("uploads under the client's avatar name in channel 0, completes it and sets the flag", async () => {
    const { client, sent } = server();
    const { fetch } = storage();
    const data = new Uint8Array([1, 2, 3]);
    const md5 = await uploadS3Avatar(client, data, { fetch });

    expect(md5).toBe(createHash("md5").update(data).digest("hex"));
    expect(sent.map((r) => r.command)).toEqual([
      "s3ft_getpresignedurl",
      "s3ft_upload_done_notification",
      "clientupdate",
    ]);
    expect(sent[0]?.params?.[0]).toEqual(["chid", 0n]);
    expect(presignedKey(sent[0]!)).toBe(`/${avatarFileName(UID)}`);
    expect(sent[1]?.params?.[0]).toEqual(["chid", 0n]);
    expect(sent[2]?.params).toContainEqual(["client_flag_avatar", md5]);
  });

  it("is refused before sending without the extension", async () => {
    const { client, sent } = server("FILETIME");
    await expect(uploadS3Avatar(client, new Uint8Array(1))).rejects.toBeInstanceOf(
      S3UnsupportedError,
    );
    expect(sent).toEqual([]);
  });
});

describe("downloadS3Avatar", () => {
  it("reads the avatar of a unique id from channel 0", async () => {
    const { client, sent } = server();
    const { fetch } = storage(new Response("png"));
    const bytes = await downloadS3Avatar(client, UID, { fetch });
    expect(Buffer.from(bytes!).toString()).toBe("png");
    expect(presignedKey(sent[0]!)).toBe(`/${avatarFileName(UID)}`);
  });

  it("answers undefined for one the storage does not have", async () => {
    const { client } = server();
    const { fetch } = storage(
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
    );
    expect(await downloadS3Avatar(client, UID, { fetch })).toBeUndefined();
  });

  it("passes on any other failure", async () => {
    const { client } = server();
    const { fetch } = storage(new Response("", { status: 403 }));
    await expect(downloadS3Avatar(client, UID, { fetch })).rejects.toBeInstanceOf(S3TransferError);
  });
});

describe("removeS3Avatar", () => {
  it("deletes the client's own avatar, then empties the flag", async () => {
    const { client, sent } = server();
    await removeS3Avatar(client);
    expect(sent.map((r) => r.command)).toEqual(["s3ft_deletefile", "clientupdate"]);
    expect(sent[0]?.params).toEqual([
      ["chid", 0n],
      ["chpw", ""],
      ["key", `/${avatarFileName(UID)}`],
    ]);
    expect(sent[1]?.params).toContainEqual(["client_flag_avatar", ""]);
  });
});

describe("S3 icons", () => {
  it("uploads under the icon's CRC-32 in channel 0 and returns it", async () => {
    const { client, sent } = server();
    const { fetch } = storage();
    const data = new Uint8Array([9, 8, 7]);
    const id = await uploadS3Icon(client, data, { fetch });
    expect(id).toBe(iconIDOf(data));
    expect(presignedKey(sent[0]!)).toBe(`/icon_${id}`);
    expect(sent.map((r) => r.command)).toEqual([
      "s3ft_getpresignedurl",
      "s3ft_upload_done_notification",
    ]);
  });

  it("downloads an icon, undefined when there is none", async () => {
    const { client } = server();
    const { fetch } = storage(new Response("ico"), new Response("", { status: 404 }));
    expect(Buffer.from((await downloadS3Icon(client, asIconID(5), { fetch }))!).toString()).toBe(
      "ico",
    );
    expect(await downloadS3Icon(client, asIconID(6), { fetch })).toBeUndefined();
  });

  it("deletes an icon's file", async () => {
    const { client, sent } = server();
    await deleteS3Icon(client, asIconID(5));
    expect(sent[0]?.params).toContainEqual(["key", "/icon_5"]);
  });
});
