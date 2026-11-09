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
import { createHash } from "node:crypto";
import {
  CommandTimeoutError,
  GroupType,
  ServerError,
  addChannelPermission,
  addPrivilegeKey,
  asChannelID,
  avatarFileName,
  createChannel,
  deleteChannel,
  deleteFile,
  iconIDOf,
  listFiles,
  listServerGroups,
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
  renameS3File,
  renameS3Files,
  uploadS3File,
  uploadS3FileData,
} from "./api/s3.js";
import {
  deleteS3Icon,
  downloadS3Avatar,
  downloadS3Icon,
  removeS3Avatar,
  uploadS3Avatar,
  uploadS3Icon,
} from "./api/s3-avatars.js";
import { QueryClient } from "../query/client.js";
import type { NotificationEvent } from "@honeybbq/teamspeak";
import type { EventMap } from "./types.js";

const S3_ADDR = process.env["TEAMSPEAK_S3_ADDR"];
const UNCHECKED_ADDR = process.env["TEAMSPEAK_S3_UNCHECKED_ADDR"];
const ADDR = process.env["TEAMSPEAK_ADDR"];
const RUN = Date.now().toString(36).slice(-5);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Trust the CAs of both labs' storages, for this test file's process. */
function trustLabs(): void {
  const cas = ["TEAMSPEAK_S3_CA", "TEAMSPEAK_S3_UNCHECKED_CA"]
    .map((name) => process.env[name])
    .filter((path): path is string => path !== undefined && path !== "")
    .map((path) => readFileSync(path, "utf8"));
  if (cas.length > 0) tls.setDefaultCACertificates([...tls.getCACertificates("default"), ...cas]);
}

async function connect(
  addr: string,
  serverPassword: string,
  nickname: string,
  privilegeKey = "",
): Promise<Client> {
  const client = new Client(generateIdentitySync(8), addr, nickname, {
    serverPassword,
    privilegeKey,
  });
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

const connectS3 = (nickname: string, privilegeKey = ""): Promise<Client> =>
  connect(
    S3_ADDR!,
    process.env["TEAMSPEAK_S3_SERVER_PASSWORD"] ?? "",
    `${nickname}-${RUN}`,
    privilegeKey,
  );

/** An administrator over a lab's WebQuery. */
async function labAdmin(prefix: string): Promise<QueryClient> {
  const query = new QueryClient({
    transport: {
      kind: "web",
      url: process.env[`${prefix}_QUERY_URL`] ?? "",
      apiKey: process.env[`${prefix}_QUERY_API_KEY`] ?? "",
    },
    server: { id: 1 },
  });
  await query.connect();
  return query;
}

/** A key that puts the client using it in the Server Admin group. */
async function serverAdminKey(query: QueryClient): Promise<string> {
  const group = (await listServerGroups(query)).find(
    (g) => g.type === GroupType.Regular && /server admin/i.test(g.name),
  )!;
  return addPrivilegeKey(query, { serverGroupID: group.id, description: `s3-${RUN}` });
}

function nextEvent<K extends keyof EventMap>(
  client: Client,
  name: K,
  match: (payload: EventMap[K]) => boolean,
): Promise<EventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${name} event arrived`));
    }, 8_000);
    const off = (client.on as (n: K, l: (p: EventMap[K]) => void) => () => void)(name, (p) => {
      if (!match(p)) return;
      clearTimeout(timer);
      off();
      resolve(p);
    });
  });
}

const paths = async (client: Client, cid: ChannelID): Promise<string[]> =>
  (await listS3Files(client, cid)).map((entry) => entry.path);

describe.skipIf(!S3_ADDR)("S3 file transfer — live", () => {
  let client: Client;
  let cid: ChannelID;
  const dir = `/ts-js-${RUN}`;

  beforeAll(async () => {
    trustLabs();
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
    const names = [`${dir}/a b+c#d?e&f=g.txt`, `${dir}/ünï€ (1).txt`, `${dir}/nested/deeper/x.txt`];
    for (const path of names) await uploadS3File(client, cid, path, Buffer.from(path));
    const listed = new Set((await listS3Files(client, cid)).map((entry) => entry.path));
    for (const path of names) {
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

  it("deletes several files in one command", async () => {
    const files = [`${dir}/batch/a.txt`, `${dir}/batch/b.txt`, `${dir}/batch/c.txt`];
    for (const path of files) await uploadS3File(client, cid, path, Buffer.from(path));
    await deleteS3File(client, cid, files.slice(0, 2));
    const left = await paths(client, cid);
    expect(left).not.toContain(files[0]);
    expect(left).not.toContain(files[1]);
    expect(left).toContain(files[2]);
    await deleteS3File(client, cid, files[2]!);
  });

  // The server's copy leaves x-amz-copy-source unsigned, which RustFS, as every
  // storage that checks signatures, refuses.
  it("fails a rename on a storage that checks signatures, and the file stays", async () => {
    const path = `${dir}/stays.txt`;
    await uploadS3File(client, cid, path, Buffer.from("stays"));
    const error = await renameS3File(client, cid, path, `${dir}/moved.txt`).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(S3TransferError);
    const listed = await paths(client, cid);
    expect(listed).toContain(path);
    expect(listed).not.toContain(`${dir}/moved.txt`);
    await deleteS3File(client, cid, path);
  });

  describe("avatars and icons", () => {
    let bystander: Client;
    let iconOwner: Client;
    let query: QueryClient;

    beforeAll(async () => {
      bystander = await connectS3("ts-js-s3-bystander");
      query = await labAdmin("TEAMSPEAK_S3");
      // Icons need b_icon_manage and i_max_icon_filesize, which a Server Admin has.
      iconOwner = await connectS3("ts-js-s3-icons", await serverAdminKey(query));
    });

    afterAll(async () => {
      await removeS3Avatar(client).catch(() => {});
      await bystander?.disconnect();
      await iconOwner?.disconnect();
      await query?.disconnect();
    });

    it("uploads an avatar that a bystander sees flagged and downloads byte for byte", async () => {
      const data = Buffer.from(`not really a picture ${RUN}`);
      const md5 = createHash("md5").update(data).digest("hex");
      const seen = nextEvent(
        bystander,
        "clientUpdated",
        (e) => e.clientID === client.clientID && e.changes.avatar === md5,
      );
      expect(await uploadS3Avatar(client, data)).toBe(md5);
      await seen;
      const got = await downloadS3Avatar(bystander, client.uid);
      expect(got && Buffer.from(got).equals(data)).toBe(true);
      // Kept in channel 0 under the uploader's avatar name, apart from the classic store.
      expect(await paths(iconOwner, asChannelID(0))).toContain(`/${avatarFileName(client.uid)}`);

      const cleared = nextEvent(
        bystander,
        "clientUpdated",
        (e) => e.clientID === client.clientID && "avatar" in e.changes && !e.changes.avatar,
      );
      await removeS3Avatar(client);
      await cleared;
      expect(await downloadS3Avatar(bystander, client.uid)).toBeUndefined();
    });

    it("refuses another client's avatar to delete", async () => {
      await uploadS3Avatar(client, Buffer.from("mine"));
      const error = await deleteS3File(
        bystander,
        asChannelID(0),
        `/${avatarFileName(client.uid)}`,
      ).catch((e: unknown) => e);
      expect((error as ServerError).code).toBe(2568);
      await removeS3Avatar(client);
    });

    it("refuses an avatar over the size limit with 2049", async () => {
      await expect(uploadS3Avatar(client, Buffer.alloc(200_001, 1))).rejects.toMatchObject({
        code: 2049,
      });
    });

    it("uploads an icon that a bystander downloads, and deletes it", async () => {
      const data = Buffer.from(`\x89PNG icon ${RUN}`);
      const id = await uploadS3Icon(iconOwner, data);
      expect(id).toBe(iconIDOf(data));
      const got = await downloadS3Icon(bystander, id);
      expect(got && Buffer.from(got).equals(data)).toBe(true);
      await deleteS3Icon(iconOwner, id);
      expect(await downloadS3Icon(bystander, id)).toBeUndefined();
    });

    it("refuses icons to a client without b_icon_manage", async () => {
      const data = Buffer.from(`icon ${RUN}`);
      await expect(uploadS3Icon(bystander, data)).rejects.toMatchObject({ code: 2049 });
      await expect(deleteS3Icon(bystander, iconIDOf(data))).rejects.toMatchObject({ code: 2568 });
    });
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
      for (const power of ["upload", "download", "delete", "rename"]) {
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
      const batch = await deleteS3File(client, locked, ["/a.txt", "/b.txt"]).catch(
        (e: unknown) => e,
      );
      expect((batch as ServerError).code).toBe(2568);
    });

    it("refuses a rename without the power with 2568", async () => {
      const error = await renameS3File(client, locked, "/a.txt", "/b.txt").catch((e: unknown) => e);
      expect((error as ServerError).code).toBe(2568);
      const batch = await renameS3Files(client, locked, [
        { oldPath: "/a.txt", newPath: "/b.txt" },
      ]).catch((e: unknown) => e);
      expect((batch as ServerError).code).toBe(2568);
    });

    // ServerQuery has no presigned URLs to hand out.
    it("is not served over WebQuery", async () => {
      const error = await query.exec(`s3ft_list_files chid=${cid} chpw=`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).code).toBe(1538);
    });
  });
});

describe.skipIf(!UNCHECKED_ADDR)(
  "S3 renames on a storage that takes the server's copy — live",
  () => {
    let client: Client;
    let cid: ChannelID;
    const dir = `/ts-js-${RUN}`;

    beforeAll(async () => {
      trustLabs();
      client = await connect(
        UNCHECKED_ADDR!,
        process.env["TEAMSPEAK_S3_UNCHECKED_SERVER_PASSWORD"] ?? "",
        `ts-js-s3u-${RUN}`,
      );
      cid = client.channelID;
    });

    afterAll(async () => {
      for (const path of await paths(client, cid).catch(() => [])) {
        if (path.startsWith(`${dir}/`)) await deleteS3File(client, cid, path).catch(() => {});
      }
      await client?.disconnect();
    });

    it("moves a file, which the list shows at once", async () => {
      await uploadS3File(client, cid, `${dir}/a.txt`, Buffer.from("content of a"));
      await renameS3File(client, cid, `${dir}/a.txt`, `${dir}/sub/renamed.txt`);
      const listed = await paths(client, cid);
      expect(listed).toContain(`${dir}/sub/renamed.txt`);
      expect(listed).not.toContain(`${dir}/a.txt`);
      expect(
        Buffer.from(await downloadS3File(client, cid, `${dir}/sub/renamed.txt`)).toString(),
      ).toBe("content of a");
    });

    it("replaces a file at the new path", async () => {
      await uploadS3File(client, cid, `${dir}/from.txt`, Buffer.from("from"));
      await uploadS3File(client, cid, `${dir}/to.txt`, Buffer.from("to"));
      await renameS3File(client, cid, `${dir}/from.txt`, `${dir}/to.txt`);
      expect(Buffer.from(await downloadS3File(client, cid, `${dir}/to.txt`)).toString()).toBe(
        "from",
      );
    });

    it("reports a rename of a file that is not there, or onto itself", async () => {
      await expect(
        renameS3File(client, cid, `${dir}/missing.txt`, `${dir}/x.txt`),
      ).rejects.toBeInstanceOf(S3TransferError);
      await uploadS3File(client, cid, `${dir}/self.txt`, Buffer.from("self"));
      await expect(
        renameS3File(client, cid, `${dir}/self.txt`, `${dir}/self.txt`),
      ).rejects.toBeInstanceOf(S3TransferError);
    });

    // One answer for the batch, the last rename's.
    it("answers a batch for its last rename alone", async () => {
      await uploadS3File(client, cid, `${dir}/b1.txt`, Buffer.from("b1"));
      await renameS3Files(client, cid, [
        { oldPath: `${dir}/nothing.txt`, newPath: `${dir}/n1.txt` },
        { oldPath: `${dir}/b1.txt`, newPath: `${dir}/batch/b1.txt` },
      ]);
      expect(await paths(client, cid)).toContain(`${dir}/batch/b1.txt`);

      await uploadS3File(client, cid, `${dir}/b2.txt`, Buffer.from("b2"));
      const error = await renameS3Files(client, cid, [
        { oldPath: `${dir}/b2.txt`, newPath: `${dir}/batch/b2.txt` },
        { oldPath: `${dir}/nothing.txt`, newPath: `${dir}/n2.txt` },
      ]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(S3TransferError);
      // The earlier rename was done all the same; the list catches up a moment later.
      let listed: string[] = [];
      for (let attempt = 0; attempt < 20 && !listed.includes(`${dir}/batch/b2.txt`); attempt++) {
        await sleep(250);
        listed = await paths(client, cid);
      }
      expect(listed).toContain(`${dir}/batch/b2.txt`);
    });
  },
);

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
