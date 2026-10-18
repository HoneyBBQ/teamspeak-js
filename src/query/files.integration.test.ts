/**
 * Live round trips of the file-area commands that need a second party and
 * the icon setters: directories and renames in a scratch channel's file area,
 * a transfer held in flight so that `listActiveTransfers` and
 * `stopFileTransfer` have something to see, and an icon given to a server, a
 * server group, a channel group and a client, then taken away again.
 *
 * The bytes of a transfer travel from a voice client, so these run only where
 * the file transfer port is reachable at the number the server announces (the
 * fixture's containers map it one to one).
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { connect } from "node:net";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GroupType,
  asIconID,
  PropertyName,
  createChannel,
  createChannelGroup,
  createDirectory,
  createServerGroup,
  deleteChannelGroup,
  deleteFile,
  deleteServerGroup,
  getServerInfo,
  initFileUpload,
  listActiveTransfers,
  listChannelGroups,
  listClientPermissions,
  listFiles,
  listServerGroups,
  removeIcon,
  renameFile,
  setChannelGroupIcon,
  setClientIcon,
  setServerGroupIcon,
  setServerIcon,
  stopFileTransfer,
  iconIDOf,
  type ChannelGroupID,
  type ChannelID,
  type ClientDBID,
  type IconID,
  type ServerGroupID,
} from "@honeybbq/teamspeak";
import type { Client } from "../client/client.js";
import { uploadIcon } from "../client/api/avatars.js";
import type { QueryClient } from "./client.js";
import {
  KINDS,
  LiveSession,
  SKIP,
  pauseAfterSshTests,
  sleep,
  stamp,
  type Kind,
} from "./testing/live.js";

pauseAfterSshTests();

const asCid = (n: number): ChannelID => BigInt(n) as ChannelID;

describe.skipIf(SKIP)("Integration — file area and icons", () => {
  const session = new LiveSession();
  const channels: ChannelID[] = [];
  const channelGroups: ChannelGroupID[] = [];
  const serverGroups: ServerGroupID[] = [];
  const icons: IconID[] = [];
  let owner: Client;
  let ownerDatabaseID: ClientDBID;
  let serverIcon = "0";

  beforeAll(async () => {
    await session.open();
    const admin = session.first();
    serverIcon = (await getServerInfo(admin))[PropertyName.VirtualServerIconID] ?? "0";
    const nickname = stamp("ts-js-files");
    // A Server Admin, so that it may manage icons and upload to a channel.
    owner = await session.voice(nickname, { admin, groupName: /server admin/i });
    ownerDatabaseID = await session.databaseIDOf(nickname);
  }, 90_000);

  afterAll(async () => {
    const admin = session.first();
    await setServerIcon(admin, serverIcon === "0" ? undefined : asIconID(Number(serverIcon))).catch(
      () => {},
    );
    for (const id of icons) await removeIcon(owner, id).catch(() => {});
    for (const id of channelGroups)
      await deleteChannelGroup(admin, id, { force: true }).catch(() => {});
    for (const id of serverGroups)
      await deleteServerGroup(admin, id, { force: true }).catch(() => {});
    await session.deleteChannels(channels);
    await session.close();
  }, 60_000);

  /** Hold an upload of `size` bytes open after sending `sent` of them. */
  async function startUpload(
    cid: ChannelID,
    name: string,
    size: number,
    sent: number,
  ): Promise<{ closed: Promise<boolean>; release: () => void }> {
    const info = await initFileUpload(owner, cid, name, BigInt(size), { overwrite: true });
    const socket = connect({ host: owner.host, port: info.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(info.fileTransferKey);
    socket.write(Buffer.alloc(sent, 1));
    const closed = new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      socket.on("error", () => {});
    });
    return {
      closed,
      release: () => socket.destroy(),
    };
  }

  describe.each(KINDS)("over %s", (kind: Kind) => {
    const admin = (): QueryClient => session.clients.get(kind)!;

    // WebQuery refuses every file command, whatever the key's scope.
    it.skipIf(kind !== "web")("refuses file commands over WebQuery", async () => {
      await expect(createDirectory(admin(), asCid(1), "/x")).rejects.toMatchObject({ code: 5120 });
      await expect(listActiveTransfers(admin())).rejects.toMatchObject({ code: 5120 });
    });

    it.skipIf(kind === "web")(
      "creates a directory, uploads a file into it, renames both and removes them",
      async () => {
        const cid = await createChannel(admin(), { name: stamp("ts-js-files"), isPermanent: true });
        channels.push(cid);
        const dir = `/dir-${stamp("d")}`;
        await createDirectory(admin(), cid, dir);
        const root = await listFiles(admin(), cid, "/");
        expect(root.find((f) => `/${f.name}` === dir)).toMatchObject({ isDirectory: true });

        const moved = `${dir}-moved`;
        await renameFile(admin(), cid, dir, moved);
        const after = await listFiles(admin(), cid, "/");
        expect(after.some((f) => `/${f.name}` === dir)).toBe(false);
        expect(after.find((f) => `/${f.name}` === moved)).toMatchObject({ isDirectory: true });

        // A file, renamed within the channel and then into another.
        const upload = await initFileUpload(owner, cid, "/before.txt", 5n, { overwrite: true });
        await owner.uploadFileData(owner.host, upload, Readable.from([Buffer.from("hello")]));
        await renameFile(admin(), cid, "/before.txt", "/after.txt");
        expect((await listFiles(admin(), cid, "/")).map((f) => f.name)).toContain("after.txt");

        const other = await createChannel(admin(), {
          name: stamp("ts-js-files2"),
          isPermanent: true,
        });
        channels.push(other);
        await renameFile(admin(), cid, "/after.txt", "/inside.txt", { targetChannelID: other });
        expect((await listFiles(admin(), other, "/")).map((f) => f.name)).toContain("inside.txt");
        expect((await listFiles(admin(), cid, "/")).map((f) => f.name)).not.toContain("after.txt");

        await deleteFile(admin(), other, "/inside.txt");
        await deleteFile(admin(), cid, moved);
        expect(
          (await listFiles(admin(), cid, "/").catch(() => [])).some((f) => `/${f.name}` === moved),
        ).toBe(false);
      },
      60_000,
    );

    it.skipIf(kind === "web")(
      "sees a transfer in flight, and stops it",
      async () => {
        const cid = await createChannel(admin(), {
          name: stamp("ts-js-transfer"),
          isPermanent: true,
        });
        channels.push(cid);
        const name = `/held-${stamp("h")}.bin`;
        const held = await startUpload(cid, name, 100_000, 10_000);
        try {
          // The server lists the transfer once it has read the key.
          const deadline = Date.now() + 10_000;
          let seen = (await listActiveTransfers(admin())).find((t) => name.endsWith(t.name));
          while (seen === undefined && Date.now() < deadline) {
            await sleep(200);
            seen = (await listActiveTransfers(admin())).find((t) => name.endsWith(t.name));
          }
          expect(seen, "the held transfer is listed").toBeDefined();
          expect(seen).toMatchObject({ clientID: owner.clientID, size: 100_000n });
          expect(seen!.sizeDone).toBeLessThan(100_000n);

          // Only the client that owns the transfer stops it here. A stop sent over
          // ServerQuery for another client's transfer does nothing on TS3, and on
          // TS6 (6.0.0-beta13.1) it crashed the server on
          // each of the three tries, so it is not sent.
          await stopFileTransfer(owner, seen!.serverFileTransferID, { removePartialFile: true });
          expect(
            await Promise.race([held.closed, sleep(5_000).then(() => false)]),
            "the server closed the data connection",
          ).toBe(true);
          const gone = Date.now() + 10_000;
          while (Date.now() < gone) {
            if (
              !(await listActiveTransfers(admin())).some(
                (t) => t.serverFileTransferID === seen!.serverFileTransferID,
              )
            )
              break;
            await sleep(200);
          }
          expect(
            (await listActiveTransfers(admin())).some(
              (t) => t.serverFileTransferID === seen!.serverFileTransferID,
            ),
            "the stopped transfer is no longer listed",
          ).toBe(false);
          expect((await listFiles(admin(), cid, "/")).map((f) => `/${f.name}`)).not.toContain(name);
        } finally {
          held.release();
        }
      },
      60_000,
    );

    it("gives a server, a server group, a channel group and a client an icon, and takes it away", async () => {
      const data = Buffer.from(`\x89PNG icon ${stamp("i")}`);
      const id = await uploadIcon(owner, data);
      icons.push(id);
      expect(id).toBe(iconIDOf(data));

      const cg = await createChannelGroup(admin(), stamp("ts-js-icg"), GroupType.Regular);
      channelGroups.push(cg);
      const sg = await createServerGroup(admin(), stamp("ts-js-isg"), GroupType.Regular);
      serverGroups.push(sg);

      await setServerIcon(admin(), id);
      expect((await getServerInfo(admin()))[PropertyName.VirtualServerIconID]).toBe(String(id));
      await setServerIcon(admin(), serverIcon === "0" ? undefined : asIconID(Number(serverIcon)));
      expect((await getServerInfo(admin()))[PropertyName.VirtualServerIconID]).toBe(serverIcon);

      await setServerGroupIcon(admin(), sg, id);
      expect((await listServerGroups(admin())).find((g) => g.id === sg)?.iconID).toBe(id);
      await setServerGroupIcon(admin(), sg, undefined);
      expect((await listServerGroups(admin())).find((g) => g.id === sg)?.iconID).toBeUndefined();

      await setChannelGroupIcon(admin(), cg, id);
      expect((await listChannelGroups(admin())).find((g) => g.id === cg)?.iconID).toBe(id);
      await setChannelGroupIcon(admin(), cg, undefined);
      expect((await listChannelGroups(admin())).find((g) => g.id === cg)?.iconID).toBeUndefined();

      // A permission value is a signed 32-bit number, so an id above 2^31 reads back negative.
      const stored = Number(id) | 0;
      await setClientIcon(admin(), ownerDatabaseID, id);
      expect(
        (await listClientPermissions(admin(), ownerDatabaseID)).some((e) => e.value === stored),
        "the client's permission list has the icon id",
      ).toBe(true);
      await setClientIcon(admin(), ownerDatabaseID, undefined);
      expect(
        (await listClientPermissions(admin(), ownerDatabaseID)).some((e) => e.value === stored),
      ).toBe(false);

      await removeIcon(owner, id);
      icons.pop();
    }, 60_000);
  });
});
