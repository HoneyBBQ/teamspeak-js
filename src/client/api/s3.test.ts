import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { NoDataError, ServerError, asChannelID } from "@honeybbq/teamspeak";
import type { CommandRequest } from "@honeybbq/teamspeak";
import type { Client } from "../client.js";
import { parseServerCapabilities } from "../capabilities.js";
import { FileTransferError, S3TransferError, S3UnsupportedError } from "../errors.js";
import {
  completeS3FileUpload,
  deleteS3File,
  downloadS3File,
  downloadS3FileData,
  initS3FileDownload,
  initS3FileUpload,
  listS3Files,
  uploadS3File,
  uploadS3FileData,
} from "./s3.js";
import { parseFileList } from "./s3-list.js";

const CID = asChannelID(2);
const URL_ = "https://teamspeak.s3.example/0123/2/a.txt?X-Amz-Signature=secret";

/** A connected TeamSpeak 6 server that names `extensions`, answering each command with the next reply. */
function server(extensions: string, ...replies: Array<Array<Record<string, string>> | Error>) {
  const sent: CommandRequest[] = [];
  const client = {
    serverCapabilities: parseServerCapabilities({
      virtualserver_version: "6.0.0-beta13.1 [Build: 1790080330]",
      virtualserver_capability_extensions: extensions,
    }),
    send: async (request: CommandRequest) => {
      sent.push(request);
      const reply = replies.shift() ?? [];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as Client;
  return { client, sent };
}

const s3Server = (...replies: Array<Array<Record<string, string>> | Error>) =>
  server("FILETIME,STREAM_P2P,s3", ...replies);

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Buffer;
}

/** A fetch that records each request and answers it with the next response. */
function storage(...responses: Array<Response | Error>) {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.body === null ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
    seen.push({ url: request.url, method: request.method, headers: request.headers, body });
    const next = responses.shift() ?? new Response(null, { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const s3Error = (status: number, code: string) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`, {
    status,
  });

const presigned = (key: string, url = URL_) => [
  { notify_presigned_urls: "", return_code: "2", url, key },
];

describe("the server's S3 extension", () => {
  // A TeamSpeak 3 server answers the S3 commands with an error that names no
  // command, so sending one would only time out.
  it("is required before anything is sent", async () => {
    const { client, sent } = server("FILETIME,STREAM_P2P");
    await expect(initS3FileUpload(client, CID, "/a", 1n)).rejects.toBeInstanceOf(
      S3UnsupportedError,
    );
    await expect(listS3Files(client, CID)).rejects.toBeInstanceOf(S3UnsupportedError);
    await expect(deleteS3File(client, CID, "/a")).rejects.toBeInstanceOf(S3UnsupportedError);
    expect(sent).toEqual([]);
  });

  it("is reported with what the server named", async () => {
    const { client } = server("FILETIME");
    const error = await initS3FileDownload(client, CID, "/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3UnsupportedError);
    expect((error as S3UnsupportedError).extensions).toEqual(["FILETIME"]);
    expect((error as S3UnsupportedError).family).toBe("ts6");
    expect((error as Error).message).toContain("names FILETIME");
  });
});

describe("initS3FileUpload", () => {
  it("names the channel on the first row and the file on a row of its own", async () => {
    const { client, sent } = s3Server(presigned("/dir/a.txt"));
    const info = await initS3FileUpload(client, CID, "dir/a.txt", 5n, { password: "pw" });

    expect(sent).toEqual([
      {
        command: "s3ft_getpresignedurl",
        params: [
          ["chid", CID],
          ["chpw", "pw"],
        ],
        rows: [
          [],
          [
            ["key", "/dir/a.txt"],
            ["verb", "PUT"],
            ["length", 5n],
          ],
        ],
        passwords: ["chpw"],
      },
    ]);
    expect(info).toEqual({ channelID: CID, path: "/dir/a.txt", size: 5n, url: URL_ });
  });

  it("takes the path the server confirmed", async () => {
    const { client } = s3Server(presigned("/confirmed.txt"));
    expect((await initS3FileUpload(client, CID, "/a.txt", 1n)).path).toBe("/confirmed.txt");
  });

  // Measured: the server answers a file named on the first row with no URL.
  it("throws a NoDataError for an answer without a URL", async () => {
    const { client } = s3Server([{ notify_presigned_urls: "", return_code: "2" }]);
    await expect(initS3FileUpload(client, CID, "/a", 1n)).rejects.toBeInstanceOf(NoDataError);
  });

  it("passes a refusal on as the server sent it", async () => {
    const { client } = s3Server(new ServerError(2049, "invalid file permissions"));
    await expect(initS3FileUpload(client, CID, "/a", 1n)).rejects.toMatchObject({ code: 2049 });
  });

  it("refuses a negative size", async () => {
    const { client, sent } = s3Server();
    await expect(initS3FileUpload(client, CID, "/a", -1n)).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
  });

  it.each([
    ["/", "names no file"],
    ["/dir/", "names no file"],
    ["/a//b", "empty segment"],
    ["//a", "empty segment"],
    ["/a/./b", '"." segment'],
    ["/a/../b", '".." segment'],
    ["..", '".." segment'],
    ["/tab\there", "control character"],
    ["/del\u007f", "control character"],
  ])("refuses the path %j, which no URL carries as signed", async (path, why) => {
    const { client, sent } = s3Server();
    const error = await initS3FileUpload(client, CID, path, 1n).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain(why);
    expect(sent).toEqual([]);
  });

  it.each(["/a b.txt", "/ü€.txt", "/a+b#c?d&e=f;g|h.txt", "/a\\b.txt", "/a%20b.txt"])(
    "takes the path %j, which the server encodes",
    async (path) => {
      const { client, sent } = s3Server(presigned(path));
      await initS3FileUpload(client, CID, path, 1n);
      expect(sent[0]?.rows?.[1]?.[0]).toEqual(["key", path]);
    },
  );
});

describe("initS3FileDownload", () => {
  it("asks for a GET of length 0", async () => {
    const { client, sent } = s3Server(presigned("/a.txt"));
    const info = await initS3FileDownload(client, CID, "/a.txt");
    expect(sent[0]?.rows?.[1]).toEqual([
      ["key", "/a.txt"],
      ["verb", "GET"],
      ["length", 0n],
    ]);
    expect(info).toEqual({ channelID: CID, path: "/a.txt", url: URL_ });
  });
});

describe("completeS3FileUpload", () => {
  const info = { channelID: CID, path: "/a.txt", size: 1n, url: URL_ };

  it("names the channel alone", async () => {
    const { client, sent } = s3Server([{ success: "1", return_code: "3" }]);
    await completeS3FileUpload(client, info, { password: "pw" });
    expect(sent).toEqual([
      {
        command: "s3ft_upload_done_notification",
        params: [
          ["chid", CID],
          ["chpw", "pw"],
        ],
        passwords: ["chpw"],
      },
    ]);
  });

  it("reports a server that could not reach its storage", async () => {
    const { client } = s3Server([{ success: "0", return_code: "3" }]);
    const error = await completeS3FileUpload(client, info).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3TransferError);
    expect((error as S3TransferError).status).toBeUndefined();
  });

  it("throws a NoDataError for an answer without success", async () => {
    const { client } = s3Server([]);
    await expect(completeS3FileUpload(client, info)).rejects.toBeInstanceOf(NoDataError);
  });
});

describe("deleteS3File", () => {
  it("names one file", async () => {
    const { client, sent } = s3Server([{ success: "1", return_code: "4" }]);
    await deleteS3File(client, CID, "a.txt");
    expect(sent).toEqual([
      {
        command: "s3ft_deletefile",
        params: [
          ["chid", CID],
          ["chpw", ""],
          ["key", "/a.txt"],
        ],
        passwords: ["chpw"],
      },
    ]);
  });

  it("reports a server that could not reach its storage", async () => {
    const { client } = s3Server([{ success: "0", return_code: "4" }]);
    await expect(deleteS3File(client, CID, "/a.txt")).rejects.toBeInstanceOf(S3TransferError);
  });
});

describe("listS3Files", () => {
  const list = (json: unknown) => [
    {
      notify_s3ft_file_list: "",
      b64_json: Buffer.from(JSON.stringify(json)).toString("base64"),
      return_code: "5",
    },
  ];

  it("reads every file, each with its path from the channel's root", async () => {
    const { client, sent } = s3Server(
      list({
        contents: [
          { key: "dir/a.txt", last_modified: "2026-11-08T19:52:49.518Z", size: 2 },
          { key: "top.txt", last_modified: "2026-11-08T19:52:44.960Z", size: 1 },
        ],
      }),
    );
    expect(await listS3Files(client, CID)).toEqual([
      { path: "/dir/a.txt", size: 2n, modifiedAt: new Date("2026-11-08T19:52:49.518Z") },
      { path: "/top.txt", size: 1n, modifiedAt: new Date("2026-11-08T19:52:44.960Z") },
    ]);
    expect(sent[0]).toEqual({
      command: "s3ft_list_files",
      params: [
        ["chid", CID],
        ["chpw", ""],
      ],
      passwords: ["chpw"],
    });
  });

  // Measured: an empty area is answered with an empty field.
  it("reads an empty field as no files", async () => {
    const { client } = s3Server([{ notify_s3ft_file_list: "", b64_json: "", return_code: "5" }]);
    expect(await listS3Files(client, CID)).toEqual([]);
  });

  it("throws a NoDataError for an answer without the list", async () => {
    const { client } = s3Server([]);
    await expect(listS3Files(client, CID)).rejects.toBeInstanceOf(NoDataError);
  });
});

describe("parseFileList", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");

  it("leaves a time it cannot read undefined", () => {
    expect(
      parseFileList(b64('{"contents":[{"key":"a","size":0,"last_modified":"soon"}]}')),
    ).toEqual([{ path: "/a", size: 0n, modifiedAt: undefined }]);
  });

  it.each([
    "not json",
    "null",
    "{}",
    '{"contents":{}}',
    '{"contents":[null]}',
    '{"contents":[{"size":1}]}',
    '{"contents":[{"key":"a","size":-1}]}',
    '{"contents":[{"key":"a","size":1.5}]}',
    '{"contents":[{"key":"a","size":"1"}]}',
  ])("refuses the malformed list %j", (text) => {
    expect(() => parseFileList(b64(text))).toThrow(NoDataError);
  });
});

describe("uploadS3FileData", () => {
  const info = { channelID: CID, path: "/a.txt", size: 5n, url: URL_ };

  it("puts exactly the signed length, with no credentials of its own", async () => {
    const { fetch, seen } = storage();
    await uploadS3FileData(info, new TextEncoder().encode("hello"), { fetch });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toBe(URL_);
    expect(seen[0]!.headers.get("content-length")).toBe("5");
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(seen[0]!.body.toString()).toBe("hello");
  });

  it("puts a stream with the signed length", async () => {
    const { fetch, seen } = storage();
    await uploadS3FileData(info, Readable.from([Buffer.from("he"), Buffer.from("llo")]), { fetch });
    expect(seen[0]!.headers.get("content-length")).toBe("5");
    expect(seen[0]!.body.toString()).toBe("hello");
  });

  it("puts a Blob", async () => {
    const { fetch, seen } = storage();
    await uploadS3FileData(info, new Blob(["hello"]), { fetch });
    expect(seen[0]!.body.toString()).toBe("hello");
  });

  it("refuses bytes of another size before sending", async () => {
    const { fetch, seen } = storage();
    await expect(uploadS3FileData(info, new Uint8Array(4), { fetch })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(uploadS3FileData(info, new Blob(["toolong"]), { fetch })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(seen).toEqual([]);
  });

  it.each([
    [["hey"], "ended after 3 of the declared 5 bytes"],
    [["hello!"], "more than the declared 5 bytes"],
  ])("fails a stream that gives %j", async (chunks, message) => {
    const { fetch } = storage();
    const error = await uploadS3FileData(info, Readable.from(chunks.map((c) => Buffer.from(c))), {
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FileTransferError);
    expect(error).not.toBeInstanceOf(S3TransferError);
    expect((error as Error).message).toContain(message);
  });

  it("reports the storage's refusal with its status and code, and never the URL", async () => {
    const { fetch } = storage(s3Error(403, "SignatureDoesNotMatch"));
    const error = await uploadS3FileData(info, new Uint8Array(5), { fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(S3TransferError);
    expect(error).toMatchObject({ status: 403, code: "SignatureDoesNotMatch" });
    expect((error as Error).message).toBe(
      "the storage refused the upload of /a.txt: HTTP 403 SignatureDoesNotMatch",
    );
  });

  it("reports a request that got no answer, with why as the cause", async () => {
    const cause = new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    const { fetch } = storage(cause);
    const error = await uploadS3FileData(info, new Uint8Array(5), { fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(S3TransferError);
    expect((error as S3TransferError).status).toBeUndefined();
    expect((error as Error).cause).toBe(cause);
    expect((error as Error).message).not.toContain("secret");
  });

  it("rejects with the signal's reason", async () => {
    const reason = new Error("stop");
    const controller = new AbortController();
    controller.abort(reason);
    const fetch = (async (_: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response(null);
    }) as typeof globalThis.fetch;
    await expect(
      uploadS3FileData(info, new Uint8Array(5), { fetch, signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

/** A Writable that keeps what it is given. */
function collector() {
  const chunks: Buffer[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { dest, bytes: () => Buffer.concat(chunks) };
}

describe("downloadS3FileData", () => {
  const info = { channelID: CID, path: "/a.txt", url: URL_ };

  it("writes the file into the stream without ending it", async () => {
    const { fetch, seen } = storage(new Response("hello"));
    const { dest, bytes } = collector();
    await downloadS3FileData(info, dest, { fetch });
    expect(bytes().toString()).toBe("hello");
    expect(dest.writableEnded).toBe(false);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("range")).toBeNull();
  });

  it("asks for the rest of the file from seekPosition", async () => {
    const { fetch, seen } = storage(new Response("llo", { status: 206 }));
    const { dest, bytes } = collector();
    await downloadS3FileData(info, dest, { fetch, seekPosition: 2n });
    expect(seen[0]!.headers.get("range")).toBe("bytes=2-");
    expect(bytes().toString()).toBe("llo");
  });

  // A storage that ignores the range sends the whole file.
  it("drops the bytes before seekPosition from a whole file", async () => {
    const { fetch } = storage(new Response("hello"));
    const { dest, bytes } = collector();
    await downloadS3FileData(info, dest, { fetch, seekPosition: 2n });
    expect(bytes().toString()).toBe("llo");
  });

  it("reports a file that is not there as a 404", async () => {
    const { fetch } = storage(s3Error(404, "NoSuchKey"));
    const error = await downloadS3FileData(info, collector().dest, { fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ status: 404, code: "NoSuchKey" });
    expect((error as Error).message).toBe(
      "the storage refused the download of /a.txt: HTTP 404 NoSuchKey",
    );
  });

  it("takes no partial answer to a request for the whole file", async () => {
    const { fetch } = storage(new Response("x", { status: 206 }));
    await expect(downloadS3FileData(info, collector().dest, { fetch })).rejects.toMatchObject({
      status: 206,
    });
  });

  it("reports a body that broke off", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("he"));
        controller.error(new Error("other side closed"));
      },
    });
    const { fetch } = storage(new Response(body));
    const error = await downloadS3FileData(info, collector().dest, { fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(S3TransferError);
    expect((error as Error).message).toBe("the download of /a.txt broke off");
  });
});

describe("uploadS3File", () => {
  it("signs, sends and completes the upload", async () => {
    const { client, sent } = s3Server(presigned("/a.txt"), [{ success: "1", return_code: "3" }]);
    const { fetch, seen } = storage();
    await uploadS3File(client, CID, "/a.txt", new TextEncoder().encode("hi"), {
      fetch,
      password: "pw",
    });
    expect(sent.map((r) => r.command)).toEqual([
      "s3ft_getpresignedurl",
      "s3ft_upload_done_notification",
    ]);
    expect(sent[0]?.rows?.[1]?.[2]).toEqual(["length", 2n]);
    expect(seen[0]!.body.toString()).toBe("hi");
  });

  it("needs the size of a stream", async () => {
    const { client, sent } = s3Server();
    await expect(uploadS3File(client, CID, "/a", Readable.from([]))).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      uploadS3File(client, CID, "/a", new Uint8Array(2), { size: 3 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      uploadS3File(client, CID, "/a", Readable.from([]), { size: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(sent).toEqual([]);
  });

  it("does not complete an upload the storage refused", async () => {
    const { client, sent } = s3Server(presigned("/a.txt"));
    const { fetch } = storage(s3Error(403, "AccessDenied"));
    await expect(
      uploadS3File(client, CID, "/a.txt", new Uint8Array(1), { fetch }),
    ).rejects.toBeInstanceOf(S3TransferError);
    expect(sent.map((r) => r.command)).toEqual(["s3ft_getpresignedurl"]);
  });
});

describe("downloadS3File", () => {
  it("returns the file's bytes", async () => {
    const { client } = s3Server(presigned("/a.txt"));
    const { fetch } = storage(new Response("hello"));
    expect(Buffer.from(await downloadS3File(client, CID, "/a.txt", { fetch })).toString()).toBe(
      "hello",
    );
  });

  it("writes into dest instead", async () => {
    const { client } = s3Server(presigned("/a.txt"));
    const { fetch } = storage(new Response("hello"));
    const { dest, bytes } = collector();
    expect(await downloadS3File(client, CID, "/a.txt", { fetch, dest })).toBeUndefined();
    expect(bytes().toString()).toBe("hello");
  });

  it("refuses a download over maxSize before reading it", async () => {
    const { client } = s3Server(presigned("/a.txt"));
    const { fetch } = storage(new Response("hello", { headers: { "content-length": "5" } }));
    const error = await downloadS3File(client, CID, "/a.txt", { fetch, maxSize: 4 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FileTransferError);
    expect((error as Error).message).toContain("over the 4 bytes maxSize allows");
  });

  it("holds a download of no announced length to maxSize as it comes", async () => {
    const { client } = s3Server(presigned("/a.txt"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });
    const { fetch } = storage(new Response(body));
    await expect(
      downloadS3File(client, CID, "/a.txt", { fetch, maxSize: 4 }),
    ).rejects.toBeInstanceOf(FileTransferError);
  });

  it("refuses a negative maxSize", async () => {
    const { client } = s3Server();
    await expect(downloadS3File(client, CID, "/a", { maxSize: -1 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
