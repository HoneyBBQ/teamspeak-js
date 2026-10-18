/**
 * Live round trips of the administration commands that no other suite runs:
 * bans of a connected client, edits of another client and of a client database
 * record, complaints, temporary passwords, the log, offline-message flags, a
 * query login set from a voice client, and the read-only getters. Each test
 * leaves what it touched as it found it.
 *
 * The commands that change the whole server or the instance are in
 * `instance.integration.test.ts`, which runs only against a server thrown away
 * afterwards.
 *
 * Opt-in, like the other query suites: see `src/query/integration.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ErrorCode,
  LogLevel,
  addComplaint,
  addTempPassword,
  banClient,
  createChannel,
  deleteAllComplaints,
  deleteBan,
  deleteClientDatabase,
  deleteComplaint,
  deleteQueryLogin,
  deleteTempPassword,
  editClient,
  editClientDatabase,
  findChannels,
  findClientDatabase,
  getClientDatabaseInfo,
  getClientProperties,
  getConnectionInfo,
  getHostInfo,
  getMessage,
  getServerIDByPort,
  getServerInfo,
  listBans,
  listBindings,
  listChannelGroupClients,
  listChannelGroups,
  listChannels,
  listClientDatabase,
  listClients,
  listComplaints,
  listMessages,
  listQueryLogins,
  listTempPasswords,
  deleteMessage,
  iterateClientDatabase,
  moveClient,
  PropertyName,
  sendOfflineMessage,
  setClientChannelGroup,
  setQueryLogin,
  updateMessageFlag,
  viewLog,
  addLog,
  whoAmI,
  GroupType,
  type BanID,
  type ChannelID,
  type ClientDBID,
  type QueryLogin,
} from "@honeybbq/teamspeak";
import type { Client } from "../client/client.js";
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

/** The text of an offline message, which a later run must not mistake for its own. */
const SUBJECT = "ts-js-live-flag";

describe.skipIf(SKIP)("Integration — administration round trips", () => {
  const session = new LiveSession();
  const channels: ChannelID[] = [];
  const records: ClientDBID[] = [];
  const logins: ClientDBID[] = [];
  const voices: Client[] = [];

  beforeAll(async () => {
    await session.open();
  }, 90_000);

  afterAll(async () => {
    const admin = session.first();
    for (const id of logins) await deleteQueryLogin(admin, id).catch(() => {});
    for (const voice of voices) await voice.disconnect().catch(() => {});
    await session.deleteChannels(channels);
    for (const id of records) await deleteClientDatabase(admin, id).catch(() => {});
    await session.close();
  }, 60_000);

  /** A voice client that the session disconnects at the end, and the database id it was given. */
  async function guest(prefix: string): Promise<{ voice: Client; databaseID: ClientDBID }> {
    const nickname = stamp(prefix);
    const voice = await session.voice(nickname);
    voices.push(voice);
    const databaseID = await session.databaseIDOf(nickname);
    records.push(databaseID);
    return { voice, databaseID };
  }

  async function leave(voice: Client): Promise<void> {
    await voice.disconnect().catch(() => {});
    voices.splice(voices.indexOf(voice), 1);
  }

  describe.each(KINDS)("over %s", (kind: Kind) => {
    const admin = (): QueryClient => session.clients.get(kind)!;

    it("bans a connected client, finds the bans it made, and lifts them", async () => {
      const { voice } = await guest("ts-js-ban");
      const clid = voice.clientID;
      const reason = stamp("ts-js-ban-reason");
      const ids = await banClient(admin(), clid, { durationMs: 60_000, reason });
      // Whatever the server made, found by the reason: a ban left behind would
      // refuse the next client that connects from this address.
      const made = async (): Promise<BanID[]> =>
        (await listBans(admin()).catch(emptyResult))
          .filter((b) => b.reason === reason)
          .map((b) => b.id);
      try {
        const listed = await made();
        expect(listed.length, "the bans the server made").toBeGreaterThan(0);
        expect(ids.length, "one ban id per count the server bans on").toBeGreaterThan(0);
        for (const id of ids) expect(listed).toContain(id);
        // The ban removes the client from the server.
        const gone = await (async () => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            if (!(await listClients(admin())).some((c) => c.id === clid)) return true;
            await sleep(250);
          }
          return false;
        })();
        expect(gone, "the banned client left the client list").toBe(true);
      } finally {
        await leave(voice);
        for (const id of await made()) await deleteBan(admin(), id).catch(() => {});
      }
      expect(await made()).toEqual([]);
    }, 60_000);

    it("edits another client's description, and its talker flag in a channel that needs talk power", async () => {
      const { voice } = await guest("ts-js-edit");
      const clid = voice.clientID;
      const cid = await createChannel(admin(), {
        name: stamp("ts-js-talk"),
        isPermanent: true,
        neededTalkPower: 50,
      });
      channels.push(cid);
      await moveClient(admin(), clid, cid);

      const fresh = async () =>
        (await listClients(admin(), { voice: true })).find((c) => c.id === clid)!;
      const description = `edited by the live suite ${kind}`;
      await editClient(admin(), clid, { description });
      expect((await getClientProperties(admin(), clid))[PropertyName.ClientDescription]).toBe(
        description,
      );
      await editClient(admin(), clid, { description: "" });

      expect((await fresh()).isTalker, "not a talker to begin with").toBe(false);
      await editClient(admin(), clid, { isTalker: true });
      const talker = await fresh();
      expect(talker.isTalker).toBe(true);
      await editClient(admin(), clid, { isTalker: false });
      expect((await fresh()).isTalker).toBe(false);
      await leave(voice);
    }, 60_000);

    it("edits and deletes the database record of a client that has gone", async () => {
      const { voice, databaseID } = await guest("ts-js-dbrec");
      const uid = voice.uid;
      await leave(voice);

      const description = `record of ${stamp("d")}`;
      await editClientDatabase(admin(), databaseID, { description });
      const info = await getClientDatabaseInfo(admin(), databaseID);
      expect(info).toMatchObject({ databaseID, uid, description });
      expect(await findClientDatabase(admin(), info.nickname)).toContain(databaseID);
      expect(
        (await listClientDatabase(admin(), { start: 0, limit: 200 })).some(
          (e) => e.databaseID === databaseID,
        ),
      ).toBe(true);
      let found = false;
      for await (const entry of iterateClientDatabase(admin(), { pageSize: 50 })) {
        if (entry.databaseID === databaseID) found = true;
      }
      expect(found, "iterateClientDatabase reaches the record").toBe(true);

      await deleteClientDatabase(admin(), databaseID);
      records.splice(records.indexOf(databaseID), 1);
      await expect(getClientDatabaseInfo(admin(), databaseID)).rejects.toMatchObject({
        code: ErrorCode.ClientInvalidID,
      });
      expect(await findClientDatabase(admin(), info.nickname).catch(emptyResult)).not.toContain(
        databaseID,
      );
    }, 60_000);

    it("files, lists and removes complaints", async () => {
      const { databaseID: target } = await guest("ts-js-compl");
      const me = (await whoAmI(admin())).databaseID;
      const text = `complaint ${stamp("c")}`;
      await addComplaint(admin(), target, text);
      try {
        const listed = await listComplaints(admin(), { targetDatabaseID: target });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
          targetDatabaseID: target,
          fromDatabaseID: me,
          message: text,
        });
        expect(listed[0]!.createdAt).toBeInstanceOf(Date);
        expect((await listComplaints(admin())).some((c) => c.targetDatabaseID === target)).toBe(
          true,
        );

        await deleteComplaint(admin(), target, me);
        expect(
          await listComplaints(admin(), { targetDatabaseID: target }).catch(emptyResult),
        ).toEqual([]);

        await addComplaint(admin(), target, `${text} again`);
        await deleteAllComplaints(admin(), target);
        expect(
          await listComplaints(admin(), { targetDatabaseID: target }).catch(emptyResult),
        ).toEqual([]);
      } finally {
        await deleteAllComplaints(admin(), target).catch(() => {});
      }
    }, 60_000);

    it("adds, lists and deletes a temporary password", async () => {
      const password = stamp("tmp");
      const cid = await createChannel(admin(), { name: stamp("ts-js-temp"), isPermanent: true });
      channels.push(cid);
      await addTempPassword(admin(), {
        password,
        description: "ts-js live",
        durationMs: 120_000,
        targetChannelID: cid,
      });
      try {
        const listed = (await listTempPasswords(admin())).find((p) => p.password === password);
        expect(listed).toMatchObject({ description: "ts-js live", targetChannelID: cid });
        expect(listed!.creatorNickname).not.toBe("");
        expect(listed!.endsAt!.getTime() - listed!.startsAt!.getTime()).toBe(120_000);
      } finally {
        await deleteTempPassword(admin(), password);
      }
      expect(
        (await listTempPasswords(admin()).catch(emptyResult)).some((p) => p.password === password),
      ).toBe(false);
    }, 60_000);

    it("writes a log line and finds it again", async () => {
      const marker = stamp("ts-js-log");
      await addLog(admin(), LogLevel.Info, marker);
      // The newest lines first; the server may take a moment to flush.
      const deadline = Date.now() + 10_000;
      let line: string | undefined;
      while (line === undefined && Date.now() < deadline) {
        const page = await viewLog(admin(), { reverse: true, lines: 100 });
        line = page.lines.find((l) => l.includes(marker));
        if (line === undefined) await sleep(250);
      }
      expect(line, "the line the server logged").toBeDefined();
      const page = await viewLog(admin(), { reverse: true, lines: 1 });
      expect(page.fileSize).toBeGreaterThan(0);
    }, 60_000);

    it("marks an offline message read and unread", async () => {
      // A query client has no mailbox to read back, so the voice client is the
      // recipient and reads its own.
      const { voice } = await guest("ts-js-mail");
      const subject = stamp(SUBJECT);
      await sendOfflineMessage(admin(), voice.uid, subject, "flag test");
      const message = (await listMessages(voice)).find((m) => m.subject === subject);
      expect(message, "the message reached the mailbox").toBeDefined();
      try {
        expect(message!.isRead).toBe(false);
        await updateMessageFlag(voice, message!.id, { read: true });
        expect((await listMessages(voice)).find((m) => m.id === message!.id)?.isRead).toBe(true);
        expect((await getMessage(voice, message!.id)).message).toBe("flag test");
        await updateMessageFlag(voice, message!.id, { read: false });
        expect((await listMessages(voice)).find((m) => m.id === message!.id)?.isRead).toBe(false);
      } finally {
        await deleteMessage(voice, message!.id).catch(() => {});
      }
      await leave(voice);
    }, 60_000);

    it("reads the server's connection, host and binding details, and finds channels and servers", async () => {
      const connection = await getConnectionInfo(admin());
      expect(connection.connectedTimeMs).toBeGreaterThan(0);
      expect(connection.bytesReceived).toBeGreaterThan(0);

      const host = await getHostInfo(admin());
      expect(host[PropertyName.HostTimestampUTC] ?? Object.keys(host)).toBeDefined();
      expect(Object.keys(host).length).toBeGreaterThan(0);

      const bindings = await listBindings(admin());
      expect(bindings.length).toBeGreaterThan(0);
      expect(bindings.every((b) => b.ip !== "")).toBe(true);
      const voice = await listBindings(admin(), { subsystem: "voice" });
      expect(voice.every((b) => b.subsystem === "voice")).toBe(true);

      const info = await getServerInfo(admin());
      const port = Number(info[PropertyName.VirtualServerPort]);
      expect(await getServerIDByPort(admin(), port)).toBe((await whoAmI(admin())).serverID);

      const alpha = (await listChannels(admin())).find(
        (c) => c.name === process.env["TEAMSPEAK_DEFAULT_CHANNEL"],
      );
      expect(await findChannels(admin(), alpha!.name)).toContainEqual({
        id: alpha!.id,
        name: alpha!.name,
      });
      expect(await findChannels(admin(), "no-such-channel-anywhere")).toEqual([]);
    }, 60_000);

    it("lists the members of a channel group in a channel", async () => {
      const { databaseID } = await guest("ts-js-cgc");
      const cid = await createChannel(admin(), { name: stamp("ts-js-cgc"), isPermanent: true });
      channels.push(cid);
      const group = (await listChannelGroups(admin())).find((g) => g.type === GroupType.Regular)!;
      await setClientChannelGroup(admin(), group.id, cid, databaseID);
      const members = await listChannelGroupClients(admin(), { channelID: cid });
      expect(members).toContainEqual({ channelID: cid, databaseID, groupID: group.id });
      expect(await listChannelGroupClients(admin(), { databaseID, channelID: cid })).toHaveLength(
        1,
      );
    }, 60_000);
  });

  // Over the voice protocol only: ServerQuery has no database record of its own
  // to attach a login to. The login is removed again, with the record it was on.
  it("sets a query login from a voice client and removes it", async () => {
    const admin = session.first();
    const nickname = stamp("ts-js-ql");
    const voice = await session.voice(nickname, { admin, groupName: /server admin/i });
    voices.push(voice);
    const databaseID = await session.databaseIDOf(nickname);
    records.push(databaseID);
    const name = stamp("tsjsql").slice(0, 24);
    const password = await setQueryLogin(voice, name);
    logins.push(databaseID);
    expect(password).not.toBe("");
    const listed = (await listQueryLogins(admin)).find(
      (l: QueryLogin) => l.databaseID === databaseID,
    );
    expect(listed).toMatchObject({ name });
    await deleteQueryLogin(admin, databaseID);
    logins.pop();
    expect((await listQueryLogins(admin)).some((l) => l.databaseID === databaseID)).toBe(false);
  }, 60_000);
});

/** A list the server reports as empty by refusing with this code, answered as []. */
function emptyResult(error: unknown): never[] {
  if ((error as { code?: number }).code === ErrorCode.DatabaseEmptyResult) return [];
  throw error;
}
