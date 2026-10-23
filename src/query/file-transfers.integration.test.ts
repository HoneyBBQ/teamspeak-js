/**
 * Live round trips of the one-call file transfers and the recursive listing:
 * files of several sizes go up and come back byte for byte, over raw TCP and
 * SSH (a query connection negotiates and a second connection carries the bytes)
 * and over the voice protocol, and the listing walks what was uploaded.
 *
 * The bytes travel to the file transfer port, which has to be reachable at the
 * number the server announces (the fixture's containers map it one to one).
 * WebQuery refuses every file command, which is checked too.
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { createHash, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ServerError,
  createChannel,
  createDirectory,
  deleteFile,
  getFileInfo,
  initFileUpload,
  listActiveTransfers,
  listFilesRecursive,
  type ChannelID,
  type CommandExecutor,
} from "@honeybbq/teamspeak";
import { FileTransferError } from "../client/errors.js";
import type { Client } from "../client/client.js";
import { downloadFile, uploadFile } from "../client/api/files.js";
import { dialFileTransfer } from "../client/transfer.js";
import {
  KINDS,
  LiveSession,
  SKIP,
  VOICE_ADDR,
  pauseAfterSshTests,
  stamp,
  type Kind,
} from "./testing/live.js";

pauseAfterSshTests();

/** The host of the voice address: the file transfer port is on the same one. */
const HOST = (VOICE_ADDR ?? "").replace(/:\d+$/, "");

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(SKIP)("Integration — one-call file transfers and the recursive listing", () => {
  const session = new LiveSession();
  const channels: ChannelID[] = [];
  let voice: Client;

  beforeAll(async () => {
    await session.open();
    // A Server Admin, so that it may create directories and delete files.
    voice = await session.voice(stamp("ts-js-ft"), {
      admin: session.first(),
      groupName: /server admin/i,
    });
  }, 90_000);

  afterAll(async () => {
    await session.deleteChannels(channels);
    await session.close();
  }, 60_000);

  const via = (kind: Kind | "voice"): CommandExecutor =>
    kind === "voice" ? voice : session.clients.get(kind)!;
  /** A query connection names the host of the file transfer port; a voice client knows its own. */
  const hostFor = (kind: Kind | "voice"): { host?: string } =>
    kind === "voice" ? {} : { host: HOST };

  describe.each<Kind | "voice">([...KINDS.filter((k) => k !== "web"), "voice"])(
    "over %s",
    (kind) => {
      it("round-trips files of every shape, and walks the tree they make", async () => {
        const exec = via(kind);
        const route = hostFor(kind);
        const cid = await createChannel(session.first(), {
          name: stamp("ts-js-ft"),
          isPermanent: true,
        });
        channels.push(cid);
        const small = Buffer.from(`one-call upload ${kind}`);
        const big = randomBytes(3 * 1024 * 1024);
        const streamed = randomBytes(70_000);

        await createDirectory(exec, cid, "/docs");
        await createDirectory(exec, cid, "/docs/deep");
        await uploadFile(exec, cid, "/small.txt", small, route);
        await uploadFile(exec, cid, "/empty.bin", new Uint8Array(0), route);
        await uploadFile(exec, cid, "/docs/big.bin", big, route);
        await uploadFile(exec, cid, "docs/deep/streamed.bin", Readable.from([streamed]), {
          ...route,
          size: streamed.length,
        });

        expect(Buffer.from(await downloadFile(exec, cid, "/small.txt", route))).toEqual(small);
        expect(await downloadFile(exec, cid, "/empty.bin", route)).toHaveLength(0);
        expect(digest(await downloadFile(exec, cid, "/docs/big.bin", route))).toBe(digest(big));
        // Into a stream, which holds nothing and ignores maxSize.
        const chunks: Buffer[] = [];
        const dest = new Writable({
          write(chunk: Buffer, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        });
        expect(
          await downloadFile(exec, cid, "docs/deep/streamed.bin", { ...route, dest, maxSize: 1 }),
        ).toBeUndefined();
        expect(digest(Buffer.concat(chunks))).toBe(digest(streamed));

        // A file over maxSize is refused, and a directory has no bytes to send.
        await expect(
          downloadFile(exec, cid, "/docs/big.bin", { ...route, maxSize: 1000 }),
        ).rejects.toBeInstanceOf(FileTransferError);
        await expect(downloadFile(exec, cid, "/docs", route)).rejects.toBeInstanceOf(
          FileTransferError,
        );

        // An existing file is not replaced unless asked; a missing directory or file is refused.
        await expect(
          uploadFile(exec, cid, "/small.txt", Buffer.from("other"), route),
        ).rejects.toMatchObject({ code: 2050 });
        await uploadFile(exec, cid, "/small.txt", Buffer.from("other"), {
          ...route,
          overwrite: true,
        });
        expect(Buffer.from(await downloadFile(exec, cid, "/small.txt", route)).toString()).toBe(
          "other",
        );
        await expect(
          uploadFile(exec, cid, "/nodir/x.txt", Buffer.from("x"), route),
        ).rejects.toMatchObject({ code: 2054 });
        await expect(downloadFile(exec, cid, "/nothing.bin", route)).rejects.toMatchObject({
          code: 2051,
        });

        // The listing: every entry with its full path, depth first.
        const tree = await listFilesRecursive(exec, cid, "/");
        expect(tree.map((e) => [e.path, e.isDirectory, e.size]).sort(byPath)).toEqual(
          [
            ["/docs", true, 0n],
            ["/docs/big.bin", false, BigInt(big.length)],
            ["/docs/deep", true, 0n],
            ["/docs/deep/streamed.bin", false, BigInt(streamed.length)],
            ["/empty.bin", false, 0n],
            ["/small.txt", false, 5n],
          ].sort(byPath),
        );
        const order = tree.map((e) => e.path);
        expect(order.indexOf("/docs")).toBeLessThan(order.indexOf("/docs/big.bin"));
        expect(order.indexOf("/docs/deep")).toBeLessThan(order.indexOf("/docs/deep/streamed.bin"));
        // The directories are listed, and entered only down to maxDepth.
        expect(
          (await listFilesRecursive(exec, cid, "/", { maxDepth: 0 })).map((e) => e.path).sort(),
        ).toEqual(["/docs", "/empty.bin", "/small.txt"]);
        expect(
          (await listFilesRecursive(exec, cid, "/", { maxDepth: 1 })).map((e) => e.path).sort(),
        ).toEqual(["/docs", "/docs/big.bin", "/docs/deep", "/empty.bin", "/small.txt"]);
        expect((await listFilesRecursive(exec, cid, "/docs/deep")).map((e) => e.path)).toEqual([
          "/docs/deep/streamed.bin",
        ]);
        expect(await listFilesRecursive(exec, cid, "/docs/deep", { maxDepth: 0 })).toHaveLength(1);
        // A path the server does not have fails as listFiles does: 2052 on TS3, 2051 on TS6.
        const error = await listFilesRecursive(exec, cid, "/nowhere").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ServerError);
        expect([2051, 2052]).toContain((error as ServerError).code);

        await deleteFile(exec, cid, ["/small.txt", "/empty.bin", "/docs"]);
        expect(await listFilesRecursive(exec, cid, "/")).toEqual([]);
      }, 120_000);
    },
  );

  describe.each<Kind | "voice">([...KINDS.filter((k) => k !== "web"), "voice"])(
    "resuming and checking sizes over %s",
    (kind) => {
      it("holds the file when the upload resolves, resumes both ways, and checks sizes", async () => {
        const exec = via(kind);
        const route = hostFor(kind);
        const host = route.host ?? voice.host;
        const cid = await createChannel(session.first(), {
          name: stamp("ts-js-ft-r"),
          isPermanent: true,
        });
        channels.push(cid);
        const bytes = randomBytes(100_000);

        // The upload resolves when the server has the file, not when the socket is done: the
        // size is there at once, with no waiting.
        await uploadFile(exec, cid, "/whole.bin", bytes, route);
        expect((await getFileInfo(exec, cid, "/whole.bin")).size).toBe(100_000n);

        // An upload cut short leaves a partial file, and resuming sends the rest.
        const cut = async (name: string): Promise<void> => {
          const info = await initFileUpload(exec, cid, name, BigInt(bytes.length));
          const socket = await dialFileTransfer(host, info.port, info.fileTransferKey);
          await new Promise<void>((resolve) =>
            socket.write(bytes.subarray(0, 40_000), () => resolve()),
          );
          socket.destroy();
          await vi.waitFor(
            async () => expect((await getFileInfo(exec, cid, name)).size).toBe(40_000n),
            { timeout: 10_000, interval: 200 },
          );
        };
        await cut("/part.bin");
        await uploadFile(exec, cid, "/part.bin", bytes, { ...route, resume: true });
        expect((await getFileInfo(exec, cid, "/part.bin")).size).toBe(100_000n);
        expect(digest(await downloadFile(exec, cid, "/part.bin", route))).toBe(digest(bytes));
        // A stream resumes the same way, its first bytes skipped.
        await cut("/part2.bin");
        await uploadFile(exec, cid, "/part2.bin", Readable.from([bytes]), {
          ...route,
          resume: true,
          size: bytes.length,
        });
        expect(digest(await downloadFile(exec, cid, "/part2.bin", route))).toBe(digest(bytes));

        // A partial download: the file from an offset to its end.
        const tail = await downloadFile(exec, cid, "/whole.bin", {
          ...route,
          seekPosition: 40_000n,
        });
        expect(tail).toHaveLength(60_000);
        expect(Buffer.from(tail).equals(bytes.subarray(40_000))).toBe(true);

        // Two downloads into one stream: it is not ended in between, or after.
        const chunks: Buffer[] = [];
        const dest = new Writable({
          write(chunk: Buffer, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        });
        await downloadFile(exec, cid, "/whole.bin", { ...route, dest, seekPosition: 99_000n });
        await downloadFile(exec, cid, "/whole.bin", { ...route, dest, seekPosition: 99_990n });
        expect(dest.writableEnded).toBe(false);
        expect(dest.destroyed).toBe(false);
        expect(
          Buffer.concat(chunks).equals(
            Buffer.concat([bytes.subarray(99_000), bytes.subarray(99_990)]),
          ),
        ).toBe(true);

        // A stream of the wrong length fails.
        await expect(
          uploadFile(exec, cid, "/short.bin", Readable.from([bytes.subarray(0, 500)]), {
            ...route,
            size: 1000,
          }),
        ).rejects.toBeInstanceOf(FileTransferError);
        await expect(
          uploadFile(exec, cid, "/long.bin", Readable.from([bytes.subarray(0, 2000)]), {
            ...route,
            size: 1000,
          }),
        ).rejects.toBeInstanceOf(FileTransferError);

        // A download refused for its size is stopped on the server too, and the failed uploads
        // left nothing running.
        await expect(
          downloadFile(exec, cid, "/whole.bin", { ...route, maxSize: 1000 }),
        ).rejects.toBeInstanceOf(FileTransferError);
        const admin = session.clients.get(KINDS.find((k) => k !== "web")!)!;
        await vi.waitFor(
          async () => {
            // Other suites may be transferring too: look at this channel's files only.
            const active = await listActiveTransfers(admin);
            expect(active.filter((t) => t.path.endsWith(`channel_${cid}`))).toEqual([]);
          },
          { timeout: 10_000, interval: 250 },
        );

        await deleteFile(voice, cid, ["/whole.bin", "/part.bin", "/part2.bin"]);
        await deleteFile(voice, cid, ["/short.bin", "/long.bin"]).catch(() => {});
      }, 120_000);
    },
  );

  it("downloads over one connection what another uploaded", async () => {
    const kinds = KINDS.filter((k) => k !== "web");
    const cid = await createChannel(session.first(), {
      name: stamp("ts-js-ft-x"),
      isPermanent: true,
    });
    channels.push(cid);
    const bytes = randomBytes(50_000);
    await uploadFile(via(kinds[0]!), cid, "/shared.bin", bytes, { host: HOST });
    for (const reader of [...kinds, "voice" as const]) {
      const got = await downloadFile(via(reader), cid, "/shared.bin", hostFor(reader));
      expect(digest(got), `read over ${reader}`).toBe(digest(bytes));
    }
    await deleteFile(voice, cid, "/shared.bin");
  }, 60_000);

  it.skipIf(!KINDS.includes("web"))(
    "is refused over WebQuery, on every call",
    async () => {
      const web = session.clients.get("web")!;
      const cid = await createChannel(web, { name: stamp("ts-js-ft-w"), isPermanent: true });
      channels.push(cid);
      await expect(
        uploadFile(web, cid, "/a.bin", Buffer.from("x"), { host: HOST }),
      ).rejects.toMatchObject({ code: 5120 });
      await expect(downloadFile(web, cid, "/a.bin", { host: HOST })).rejects.toMatchObject({
        code: 5120,
      });
      await expect(listFilesRecursive(web, cid, "/")).rejects.toMatchObject({ code: 5120 });
    },
    30_000,
  );
});

const byPath = (
  a: Array<string | boolean | bigint>,
  b: Array<string | boolean | bigint>,
): number => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
