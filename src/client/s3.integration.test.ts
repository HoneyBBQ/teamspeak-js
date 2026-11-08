/**
 * Live tests of TeamSpeak 6 S3 file transfer. The S3 tests run when
 * TEAMSPEAK_S3_ADDR names a TeamSpeak 6 server with S3 file transfer on, as
 * scripts/s3-lab.sh starts one; the ones that say a server without it is
 * refused run against TEAMSPEAK_ADDR.
 *
 *   ./scripts/s3-lab.sh /tmp/s3-lab   # appends TEAMSPEAK_S3_* to the fixture's file
 *   source /tmp/ts3-fixture.env && pnpm vitest run src/client/s3.integration.test.ts --reporter=verbose
 *
 * The storage's certificate is from the CA in TEAMSPEAK_S3_CA, which these
 * tests add to the process's trusted ones.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandTimeoutError,
  ServerError,
  addChannelPermission,
  asChannelID,
  createChannel,
  deleteChannel,
  deleteFile,
  listFiles,
  permissionByName,
} from "@honeybbq/teamspeak";
import type { ChannelID } from "@honeybbq/teamspeak";
import { Client } from "./client.js";
import { generateIdentitySync } from "./crypto/identity.js";
import { S3TransferError, S3UnsupportedError } from "./errors.js";
import { uploadFile } from "./api/files.js";
import {
  completeS3FileUpload,
  deleteS3File,
  downloadS3File,
  initS3FileDownload,
  initS3FileUpload,
  listS3Files,
  uploadS3File,
  uploadS3FileData,
} from "./api/s3.js";
import { QueryClient } from "../query/client.js";
import type { NotificationEvent } from "@honeybbq/teamspeak";

const S3_ADDR = process.env["TEAMSPEAK_S3_ADDR"];
const ADDR = process.env["TEAMSPEAK_ADDR"];
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function connect(addr: string, serverPassword: string, nickname: string): Promise<Client> {
  const client = new Client(generateIdentitySync(8), addr, nickname, { serverPassword });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(10_000) });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(2_000);
    }
  }
  await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  return client;
}

const connectS3 = (nickname: string): Promise<Client> =>
  connect(S3_ADDR!, process.env["TEAMSPEAK_S3_SERVER_PASSWORD"] ?? "", `${nickname}-${RUN}`);

describe.skipIf(!S3_ADDR)("S3 file transfer — live", () => {
  let client: Client;
  let cid: ChannelID;
  const dir = `/ts-js-${RUN}`;

  beforeAll(async () => {
    const ca = process.env["TEAMSPEAK_S3_CA"];
    if (ca !== undefined && ca !== "") {
      tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(ca, "utf8")]);
    }
    client = await connectS3("ts-js-s3");
    cid = client.channelID;
  });

  afterAll(async () => {
    await client?.disconnect();
  });

  it("is named among the server's extensions", () => {
    expect(client.serverCapabilities.extensions).toContain("s3");
  });

  it("uploads, lists, downloads and deletes a file", async () => {
    const path = `${dir}/round-trip.bin`;
    const data = randomBytes(200_000);
    await uploadS3File(client, cid, path, data);

    const listed = (await listS3Files(client, cid)).find((entry) => entry.path === path);
    expect(listed?.size).toBe(200_000n);
    expect(listed?.modifiedAt).toBeInstanceOf(Date);

    expect(Buffer.from(await downloadS3File(client, cid, path)).equals(data)).toBe(true);

    await deleteS3File(client, cid, path);
    expect((await listS3Files(client, cid)).some((entry) => entry.path === path)).toBe(false);
    const error = await downloadS3File(client, cid, path).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3TransferError);
    expect((error as S3TransferError).status).toBe(404);
  });

  it("takes a stream of a declared size, and a Blob", async () => {
    const data = randomBytes(70_000);
    await uploadS3File(
      client,
      cid,
      `${dir}/stream.bin`,
      Readable.from([data.subarray(0, 1), data.subarray(1)]),
      {
        size: data.length,
      },
    );
    await uploadS3File(client, cid, `${dir}/blob.bin`, new Blob([data]));
    expect(Buffer.from(await downloadS3File(client, cid, `${dir}/stream.bin`)).equals(data)).toBe(
      true,
    );
    expect(Buffer.from(await downloadS3File(client, cid, `${dir}/blob.bin`)).equals(data)).toBe(
      true,
    );
    await deleteS3File(client, cid, `${dir}/stream.bin`);
    await deleteS3File(client, cid, `${dir}/blob.bin`);
  });

  it("downloads the rest of a file from seekPosition", async () => {
    const path = `${dir}/seek.bin`;
    const data = randomBytes(10_000);
    await uploadS3File(client, cid, path, data);
    const rest = await downloadS3File(client, cid, path, { seekPosition: 9_000n });
    expect(Buffer.from(rest).equals(data.subarray(9_000))).toBe(true);
    await deleteS3File(client, cid, path);
  });

  it("keeps names the server has to encode", async () => {
    const paths = [`${dir}/a b+c#d?e&f=g.txt`, `${dir}/ünï€ (1).txt`, `${dir}/nested/deeper/x.txt`];
    for (const path of paths) await uploadS3File(client, cid, path, Buffer.from(path));
    const listed = new Set((await listS3Files(client, cid)).map((entry) => entry.path));
    for (const path of paths) {
      expect(listed.has(path), path).toBe(true);
      expect(Buffer.from(await downloadS3File(client, cid, path)).toString()).toBe(path);
      await deleteS3File(client, cid, path);
    }
  });

  it("replaces a file already at the path", async () => {
    const path = `${dir}/replace.txt`;
    await uploadS3File(client, cid, path, Buffer.from("first"));
    await uploadS3File(client, cid, path, Buffer.from("second"));
    expect(Buffer.from(await downloadS3File(client, cid, path)).toString()).toBe("second");
    await deleteS3File(client, cid, path);
  });

  it("lists a stored file only once the server is told the upload is done", async () => {
    const path = `${dir}/uncompleted.txt`;
    const info = await initS3FileUpload(client, cid, path, 3n);
    await uploadS3FileData(info, Buffer.from("abc"));
    // A test that expects nothing measures once.
    await sleep(1_000);
    expect((await listS3Files(client, cid)).some((entry) => entry.path === path)).toBe(false);
    await completeS3FileUpload(client, info);
    expect((await listS3Files(client, cid)).some((entry) => entry.path === path)).toBe(true);
    await deleteS3File(client, cid, path);
  });

  it("signs a download of a file that is not there, which the storage answers with 404", async () => {
    const info = await initS3FileDownload(client, cid, `${dir}/never-uploaded.txt`);
    expect(info.url.startsWith("https://")).toBe(true);
    await expect(downloadS3File(client, cid, `${dir}/never-uploaded.txt`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("deletes a file that is not there without an error", async () => {
    await expect(deleteS3File(client, cid, `${dir}/never-uploaded.txt`)).resolves.toBeUndefined();
  });

  it("lists no files in a channel that does not exist, and signs no download from one", async () => {
    const missing = asChannelID(999_999);
    expect(await listS3Files(client, missing)).toEqual([]);
    await expect(initS3FileDownload(client, missing, "/a.txt")).rejects.toMatchObject({
      code: 2049,
    });
  });

  // The two commands that change files tell no other client about it.
  it("tells other clients nothing", async () => {
    const other = await connectS3("ts-js-s3-other");
    try {
      const seen: NotificationEvent[] = [];
      other.on("notification", (n) => seen.push(n));
      await sleep(500);
      seen.length = 0;
      const path = `${dir}/quiet.txt`;
      await uploadS3File(client, cid, path, Buffer.from("quiet"));
      await deleteS3File(client, cid, path);
      await sleep(1_000);
      // Pings and the like may come; nothing about files does.
      expect(seen.map((n) => n.name).filter((name) => /s3|file|presigned/i.test(name))).toEqual([]);
    } finally {
      await other.disconnect();
    }
  });

  it("keeps its files apart from the classic file area", async () => {
    const s3Path = `${dir}/s3-only.txt`;
    await uploadS3File(client, cid, s3Path, Buffer.from("s3"));
    const classic = await listFiles(client, cid, "/").catch((e: unknown) => e);
    // An empty classic area is answered with "empty result set".
    const classicNames = Array.isArray(classic) ? classic.map((entry) => entry.name) : [];
    expect(classicNames).not.toContain(dir.slice(1));

    const classicName = `/ts-js-classic-${RUN}.txt`;
    await uploadFile(client, cid, classicName, Buffer.from("classic"));
    try {
      expect((await listS3Files(client, cid)).some((entry) => entry.path === classicName)).toBe(
        false,
      );
    } finally {
      await deleteFile(client, cid, classicName);
      await deleteS3File(client, cid, s3Path);
    }
  });

  describe("permissions", () => {
    let query: QueryClient;
    let locked: ChannelID;
    let noDirectories: ChannelID;

    beforeAll(async () => {
      query = new QueryClient({
        transport: {
          kind: "web",
          url: process.env["TEAMSPEAK_S3_QUERY_URL"] ?? "",
          apiKey: process.env["TEAMSPEAK_S3_QUERY_API_KEY"] ?? "",
        },
        server: { id: 1 },
      });
      await query.connect();
      locked = await createChannel(query, { name: `ts-js-s3-locked-${RUN}` });
      // The fixture gives every client 100 of each file power.
      for (const power of ["upload", "download", "delete"]) {
        await addChannelPermission(
          query,
          locked,
          permissionByName(`i_ft_needed_file_${power}_power`),
          200,
        );
      }
      noDirectories = await createChannel(query, { name: `ts-js-s3-nodirs-${RUN}` });
      await addChannelPermission(
        query,
        noDirectories,
        permissionByName("i_ft_needed_directory_create_power"),
        200,
      );
    });

    afterAll(async () => {
      for (const channel of [locked, noDirectories]) {
        if (channel !== undefined)
          await deleteChannel(query, channel, { force: true }).catch(() => {});
      }
      await query?.disconnect();
    });

    it("needs directory create power for a directory the list does not have", async () => {
      // Into an area with no files any path is taken.
      await uploadS3File(client, noDirectories, "/first/a.txt", Buffer.from("a"));
      try {
        await uploadS3File(client, noDirectories, "/first/b.txt", Buffer.from("b"));
        await uploadS3File(client, noDirectories, "/top.txt", Buffer.from("t"));
        const error = await initS3FileUpload(client, noDirectories, "/second/c.txt", 1n).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ServerError);
        expect((error as ServerError).code).toBe(2049);
      } finally {
        for (const path of ["/first/a.txt", "/first/b.txt", "/top.txt"]) {
          await deleteS3File(client, noDirectories, path);
        }
      }
    });

    it("refuses an upload without the power with 2049", async () => {
      const error = await initS3FileUpload(client, locked, "/a.txt", 1n).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(2049);
    });

    it("refuses a download without the power with 2049", async () => {
      const error = await initS3FileDownload(client, locked, "/a.txt").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(2049);
    });

    it("refuses a delete without the power with 2568", async () => {
      const error = await deleteS3File(client, locked, "/a.txt").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(2568);
    });

    // ServerQuery has no presigned URLs to hand out.
    it("is not served over WebQuery", async () => {
      const error = await query.exec(`s3ft_list_files chid=${cid} chpw=`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(1538);
    });
  });
});

describe.skipIf(!ADDR)("S3 file transfer on a server without it — live", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect(
      ADDR!,
      process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "",
      `ts-js-nos3-${RUN}`,
    );
  });

  afterAll(async () => {
    await client?.disconnect();
  });

  it("is refused before anything is sent", async () => {
    expect(client.serverCapabilities.extensions).not.toContain("s3");
    const error = await listS3Files(client, client.channelID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3UnsupportedError);
    expect((error as S3UnsupportedError).family).toBe(client.serverCapabilities.family);
  });

  // Why the functions refuse first: TeamSpeak 3 answers with an error that
  // names no command, so the command never ends; TeamSpeak 6 says 1035.
  it("would not be answered usefully", async () => {
    const error = await client
      .exec(`s3ft_list_files chid=${client.channelID} chpw=`, { timeoutMs: 3_000 })
      .catch((e: unknown) => e);
    if (client.serverCapabilities.family === "ts3") {
      expect(error).toBeInstanceOf(CommandTimeoutError);
    } else {
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(1035);
    }
  });
});
