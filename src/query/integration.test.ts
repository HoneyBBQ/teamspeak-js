/**
 * Integration tests for the ServerQuery client, against a live server.
 *
 * Opt-in: they run when the fixture has provisioned a query endpoint, which is
 * what `scripts/ts3-fixture.sh` writes into its environment file:
 *
 *   docker run -d --name ts3 -e TS3SERVER_LICENSE=accept \
 *     -p 9987:9987/udp -p 10011:10011 teamspeak:latest
 *   TS3_QUERY_HOST=127.0.0.1 ./scripts/ts3-fixture.sh
 *   set -a; . "${TS3_FIXTURE_ENV:-${TMPDIR:-/tmp}/ts3-fixture.env}"; set +a
 *   pnpm test:integration:query
 *
 * TeamSpeak 6 serves no raw query port, so there the fixture writes a WebQuery
 * URL instead and the suite takes the `web` transport. SSH runs only where
 * `TEAMSPEAK_QUERY_SSH_PORT` is set: TeamSpeak 3 does not publish it, and
 * TeamSpeak 6 leaves it off unless `TSSERVER_QUERY_SSH_ENABLED=1` is set.
 *
 * SSH verifies the server's host key, as the client always does. Against the
 * `known_hosts` file `TEAMSPEAK_QUERY_SSH_KNOWN_HOSTS` names when it is set, and
 * otherwise against the key the server presents, recorded first: there is no
 * run that accepts any key.
 *
 * One server at a time. The query flood limit bans an address that connects
 * too quickly, and a rerun straight after a failure can do the same.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, type TestContext } from "vitest";
import {
  ClientStatus,
  ErrorCode,
  Reason,
  TextMessageTarget,
  addAPIKey,
  addBan,
  copyChannelGroup,
  copyServerGroup,
  createChannelGroup,
  createServerGroup,
  deleteChannelGroup,
  deleteServerGroup,
  listChannelGroups,
  listServerGroups,
  asChannelGroupID,
  asServerGroupID,
  GroupType,
  type ChannelGroupID,
  type CommandExecutor,
  type ServerGroupID,
  addQueryLogin,
  createChannel,
  createServerSnapshot,
  deleteAPIKey,
  deleteBan,
  deleteCustomProperty,
  deleteQueryLogin,
  findBans,
  findClients,
  findCustomProperty,
  getOwnPermission,
  PropertyName,
  deleteChannel,
  editChannel,
  editServer,
  getServerInfo,
  getInstanceInfo,
  getVersion,
  kickClient,
  listAPIKeys,
  listBans,
  listChannels,
  listClientDatabase,
  listCustomProperties,
  listQueryLogins,
  listServers,
  moveChannel,
  moveClient,
  permissionByName,
  sendChannelMessage,
  setCustomProperty,
  sendChatComposing,
  sendPluginCommand,
  updateClient,
  whoAmI,
  asServerID,
  asUID,
  type BanID,
  type ChannelID,
} from "@honeybbq/teamspeak";
import { Client } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { QueryClient } from "./client.js";
import { GuestAccessError, QueryAuthError, SshHostKeyError } from "./errors.js";
import type { QueryClientOptions } from "./options.js";
import { connectSsh } from "./ssh.js";
import type { SshHostKey } from "./ssh.js";
import { newSshKeyPair } from "./testing/ssh-keys.js";
import type {
  ClientEnterEvent,
  ClientMovedEvent,
  KickedEvent,
  TextMessageEvent,
} from "@honeybbq/teamspeak";

const VOICE_ADDR = process.env["TEAMSPEAK_ADDR"];
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const SERVER_PASSWORD = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";

const SERVER_FAMILY = process.env["TEAMSPEAK_QUERY_FAMILY"] ?? "";
const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const QUERY_HOST = process.env["TEAMSPEAK_QUERY_HOST"] ?? "";
const QUERY_PORT = Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011");
const QUERY_URL = process.env["TEAMSPEAK_QUERY_URL"] ?? "";
const QUERY_API_KEY = process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "";
const LOGIN_NAME = process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "";
const LOGIN_PASSWORD = process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "";

const SSH_PORT = Number(process.env["TEAMSPEAK_QUERY_SSH_PORT"] ?? "0");
const SSH_HOST = process.env["TEAMSPEAK_QUERY_SSH_HOST"] ?? QUERY_HOST;
const SSH_USER = process.env["TEAMSPEAK_QUERY_SSH_USER"] ?? "";
const SSH_PASSWORD = process.env["TEAMSPEAK_QUERY_SSH_PASSWORD"] ?? "";
const SSH_KNOWN_HOSTS = process.env["TEAMSPEAK_QUERY_SSH_KNOWN_HOSTS"] ?? "";
/** Set where the server accepts guest logins: TeamSpeak 6 beta13 and later, not TS3. */
const GUEST = process.env["TEAMSPEAK_QUERY_GUEST"] === "1";

const NOT_IN_API_KEY_SCOPE = ErrorCode.APIKeyOutOfScope;

const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const EVENT_TIMEOUT_MS = 10_000;

type Kind = "tcp" | "web" | "ssh";

/** The transports this run can use, from what the fixture provisioned. */
const KINDS: readonly Kind[] = [
  ...(QUERY_KIND === "tcp" || QUERY_HOST !== "" ? (["tcp"] as const) : []),
  ...(QUERY_KIND === "web" || (QUERY_URL !== "" && QUERY_API_KEY !== "") ? (["web"] as const) : []),
  ...(SSH_PORT > 0 ? (["ssh"] as const) : []),
];

const SKIP = VOICE_ADDR === undefined || KINDS.length === 0;

/** The `known_hosts` file the SSH transport verifies against; set once the suite starts. */
let sshKnownHosts = "";

/** A line of a `known_hosts` file for the SSH server at `host`:`port`, holding `key`. */
function knownHostsLine(key: Pick<SshHostKey, "keyType" | "key">): string {
  return `[${SSH_HOST}]:${SSH_PORT} ${key.keyType} ${Buffer.from(key.key).toString("base64")}\n`;
}

/** The key the SSH server presented, once {@link presentedSshKey} has asked. */
let presentedKey: Promise<SshHostKey> | undefined;

/**
 * The key the SSH server presents. It does not change during a run, so it is
 * probed once.
 */
function presentedSshKey(): Promise<SshHostKey> {
  presentedKey ??= probeSshKey();
  return presentedKey;
}

/**
 * Ask the SSH server for its key. The check runs before the login, so a probe
 * that refuses the key has seen it and sent nothing.
 */
async function probeSshKey(): Promise<SshHostKey> {
  let presented: SshHostKey | undefined;
  await connectSsh({
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    password: SSH_PASSWORD,
    hostKey: (key) => {
      presented = key;
      throw new Error("recorded, and not trusted yet");
    },
  }).catch(() => {});
  if (presented === undefined) {
    throw new Error(`the server at ${SSH_HOST}:${SSH_PORT} sent no key`);
  }
  return presented;
}

/** The options for one transport kind. */
function optionsFor(kind: Kind): QueryClientOptions {
  switch (kind) {
    case "tcp":
      return {
        transport: {
          kind: "tcp",
          host: QUERY_HOST,
          port: QUERY_PORT,
          login: { name: LOGIN_NAME, password: LOGIN_PASSWORD },
        },
        server: { id: 1 },
        nickname: "ts-js-query",
      };
    case "web":
      return {
        transport: { kind: "web", url: QUERY_URL, apiKey: QUERY_API_KEY },
        server: { id: 1 },
      };
    case "ssh":
      return {
        transport: {
          kind: "ssh",
          host: SSH_HOST,
          port: SSH_PORT,
          username: SSH_USER,
          password: SSH_PASSWORD,
          knownHosts: sshKnownHosts,
        },
        server: { id: 1 },
        nickname: "ts-js-query",
      };
    default:
      // Every kind is handled; a name from the environment that is not one of
      // them would otherwise connect with no transport at all.
      throw new TypeError(`unknown query transport ${String(kind)}`);
  }
}

/**
 * Connect, trying again when an attempt fails: the query flood limit refuses
 * an address that arrives too fast, and the suite should not fail on that.
 */
async function connectWithRetries(client: QueryClient): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      return;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      console.warn(`query connect attempt ${attempt} of ${CONNECT_ATTEMPTS}: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

/**
 * Time to let a TeamSpeak 3 server finish closing an SSH query session.
 *
 * A connection made within a few milliseconds of an SSH session ending is
 * accepted and closed at once, with nothing read from it: the client sees
 * "socket hang up" before any response byte, whatever the request is (measured
 * on 3.13.8 for POST and GET, 200 and 401, with and without a body: 4 to 14 of
 * every 100 requests sent straight after an SSH close, none from 3 ms on). The
 * server logs "Bad file descriptor" for them. TeamSpeak 6 and a raw session's
 * end do not do it. The server is what drops the connection, so the suite
 * waits rather than retrying: a retry cannot know the command was not run. The
 * SDK does nothing for it. See "Server behaviour the SDK works around" in
 * `docs/serverquery-responses.md`.
 */
const SSH_TEARDOWN_MS = 50;

afterEach(async () => {
  if (KINDS.includes("ssh")) await new Promise((resolve) => setTimeout(resolve, SSH_TEARDOWN_MS));
});

/** Reject rather than hang when a pushed event never arrives. */
function withTimeout<T>(promise: Promise<T>, timeoutMs = EVENT_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("the event did not arrive")), timeoutMs),
    ),
  ]);
}

describe.skipIf(SKIP)("Integration — ServerQuery client", () => {
  /** One client per transport, connected once and shared by the tests. */
  const clients = new Map<Kind, QueryClient>();
  /** A voice client, for the cases that need one on the other side. */
  let voice: Client | undefined;
  /** The channels created here, to remove afterwards. */
  const created: ChannelID[] = [];
  const scratch = mkdtempSync(join(tmpdir(), "query-ssh-"));

  /** A `known_hosts` file holding `line`, for a connection that is meant to be refused. */
  function knownHostsFile(name: string, line: string): string {
    const path = join(scratch, name);
    writeFileSync(path, line);
    return path;
  }

  beforeAll(async () => {
    if (SKIP) return;
    if (KINDS.includes("ssh")) {
      sshKnownHosts =
        SSH_KNOWN_HOSTS !== ""
          ? SSH_KNOWN_HOSTS
          : knownHostsFile("recorded", knownHostsLine(await presentedSshKey()));
    }
    for (const kind of KINDS) {
      const client = new QueryClient(optionsFor(kind));
      await connectWithRetries(client);
      clients.set(kind, client);
    }
  }, 90_000);

  afterAll(async () => {
    const cleaner = clients.get("tcp") ?? clients.get("ssh") ?? clients.get("web");
    if (cleaner !== undefined) {
      for (const id of created)
        await cleaner.exec(`channeldelete cid=${id} force=1`).catch(() => {});
    }
    // The voice client goes first: the query client's events are what the last
    // tests are about, and a leave is one of them.
    if (voice !== undefined) await voice.disconnect().catch(() => {});
    for (const client of clients.values()) await client.disconnect().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  /**
   * The clients that receive pushed events. A test about events skips when
   * there are none, rather than passing having checked nothing: WebQuery has no
   * event categories, so a run with only that transport has nothing to test.
   */
  function eventClients(ctx: TestContext): Array<[Kind, QueryClient]> {
    const receiving = [...clients].filter(([, client]) => client.eventCategories.length > 0);
    if (receiving.length === 0) ctx.skip("no transport in this run delivers events");
    return receiving;
  }

  /** A voice client, connected once and reused: antiflood counts every connect. */
  async function voiceClient(): Promise<Client> {
    if (voice !== undefined) return voice;
    const client = new Client(generateIdentitySync(8), VOICE_ADDR!, "ts-js-query-voice", {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: DEFAULT_CHANNEL,
    });
    await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    voice = client;
    return client;
  }

  it("connects, selects a server and runs the typed commands", async () => {
    for (const [kind, client] of clients) {
      expect(client.status, kind).toBe(ClientStatus.Connected);
      // The server says which generation it is, so this is read, not assumed.
      // The fixture read it too, from the version, without this client's help.
      expect(["ts3", "ts6"], kind).toContain(client.serverFamily);
      if (SERVER_FAMILY !== "") expect(client.serverFamily, kind).toBe(SERVER_FAMILY);

      const version = await getVersion(client);
      console.log(`${kind}: version=${version.version} platform=${version.platform}`);
      expect(version.version, kind).not.toBe("");

      const me = await whoAmI(client);
      expect(me.nickname, kind).not.toBe("");
      expect(me.serverID, kind).toBeGreaterThan(0);

      const channels = await listChannels(client);
      expect(
        channels.some((channel) => channel.name === DEFAULT_CHANNEL),
        kind,
      ).toBe(true);
    }
  }, 40_000);

  // The rule this proves: ServerQuery takes a channel password in clear text
  // and hashes it server-side, where the voice protocol wants the hash.
  it("creates a password-protected channel the voice client can join", async () => {
    const [kind, client] = [...clients][0]!;
    const name = `query-${Date.now()}`;
    const password = "cleartext pass$|1";

    const id = await createChannel(client, { name, password, isPermanent: true });
    created.push(id);
    expect(id, kind).toBeGreaterThan(0n);

    const mine = (await listChannels(client)).find((channel) => channel.id === id);
    expect(mine?.hasPassword, kind).toBe(true);

    // The voice client is the proof: refused with the wrong password, and in
    // with the one the query client was handed in the clear.
    const joiner = await voiceClient();
    await expect(moveClient(joiner, joiner.clientID, id, { password: "wrong" })).rejects.toThrow();
    await moveClient(joiner, joiner.clientID, id, { password });
    expect(joiner.channelID, kind).toBe(id);
  }, 40_000);

  // A text message reaches the channel the sender is in, and a query client
  // sits in whichever channel it selected, so the voice client joins that one
  // first — which is the move this test is about as well.
  it("receives a move and a text message as typed events", async (ctx) => {
    const receiving = eventClients(ctx);
    const joiner = await voiceClient();
    for (const [kind, client] of receiving) {
      const me = await whoAmI(client);
      // Out of the way first, so that the move below is a move either way.
      if (joiner.channelID === me.channelID) {
        const alpha = (await listChannels(joiner)).find((c) => c.name === DEFAULT_CHANNEL);
        await moveClient(joiner, joiner.clientID, alpha!.id);
      }

      const moved = new Promise<ClientMovedEvent>((resolve) =>
        client.on("clientMoved", (event) => {
          // The move out of the way above can still be on its way: a second
          // query client sees it after this listener is attached.
          if (event.clientID === joiner.clientID && event.targetChannelID === me.channelID) {
            resolve(event);
          }
        }),
      );
      await moveClient(joiner, joiner.clientID, me.channelID);

      const move = await withTimeout(moved);
      expect(move, `${kind}: clientMoved`).toMatchObject({
        clientID: joiner.clientID,
        targetChannelID: me.channelID,
        reason: Reason.None,
      });

      const message = new Promise<TextMessageEvent>((resolve) =>
        client.on("textMessage", (event) => {
          if (event.message.startsWith(`hello-${kind}`)) resolve(event);
        }),
      );
      await sendChannelMessage(joiner, `hello-${kind}`);

      const text = await withTimeout(message);
      expect(text, `${kind}: textMessage`).toMatchObject({
        message: `hello-${kind}`,
        invokerName: "ts-js-query-voice",
        targetMode: TextMessageTarget.Channel,
      });
      // The groups are the sender's, which the client learned from the enter
      // notification that carried them: a text message has none of its own.
      expect(text.invokerGroups, kind).toBeDefined();
    }
  }, 60_000);

  // An enter is announced only for a client that arrives after registering,
  // which is why the client lists the ones already connected when it connects.
  it("receives a client entering as a typed event", async (ctx) => {
    for (const [kind, client] of eventClients(ctx)) {
      const entered = new Promise<ClientEnterEvent>((resolve) =>
        client.on("clientEnter", (info) => {
          if (info.nickname === "ts-js-query-late") resolve(info);
        }),
      );

      const late = new Client(generateIdentitySync(8), VOICE_ADDR!, "ts-js-query-late", {
        serverPassword: SERVER_PASSWORD,
        defaultChannel: DEFAULT_CHANNEL,
      });
      await late.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      try {
        const info = await withTimeout(entered);
        expect(info.type, kind).toBe(0); // a voice client
        expect(info.uid, kind).not.toBe("");
        expect(info.channelID, kind).toBeGreaterThan(0n);
      } finally {
        await late.disconnect();
      }
    }
  }, 60_000);

  // A query client is never kicked from the server: `clientkick` with
  // `reasonid=5` aimed at one is refused with 516 whoever sends it. A channel
  // kick is accepted, and reaches it as a move of its own — which the client
  // reports as a kick, because that is what it is.
  it("takes a channel kick as its own kick", async (ctx) => {
    for (const [kind, client] of eventClients(ctx)) {
      const me = await whoAmI(client);
      const target = (await listChannels(client)).find(
        (channel) => channel.name === PASSWORD_CHANNEL,
      );
      expect(target, kind).toBeDefined();

      // A kick moves the client out of its channel, so it has to be in one it
      // can be moved out of: the default channel would answer 770.
      await moveClient(client, me.clientID, target!.id, {
        password: PASSWORD_CHANNEL_PASSWORD,
      });

      const kicked = new Promise<KickedEvent>((resolve) => client.on("kicked", resolve));
      await kickClient(client, me.clientID, Reason.KickChannel, {
        reasonMessage: `out-${kind}`,
      });

      const event = await withTimeout(kicked);
      expect(event, kind).toMatchObject({
        reason: Reason.KickChannel,
        reasonMessage: `out-${kind}`,
      });
      // Still connected: a channel kick moves the client, it does not remove
      // it from the server.
      expect(client.status, kind).toBe(ClientStatus.Connected);
    }
  }, 60_000);

  // A refused `use` leaves the connection on no server, and the next one makes
  // it a client of that server with an id of its own: a server answers a `use`
  // of the server already selected with nothing at all, so this is the id change
  // a lone server allows. The client has to read the new id, or the channel kick
  // of itself below is a move of somebody else.
  it("recognises its own kick after the server it is on was selected again", async (ctx) => {
    for (const [kind] of eventClients(ctx)) {
      const client = new QueryClient({ ...optionsFor(kind), nickname: `ts-js-reuse-${kind}` });
      await connectWithRetries(client);
      try {
        const before = await whoAmI(client);
        await expect(client.use({ id: 9999 }), kind).rejects.toMatchObject({ code: 1033 });
        // No server is selected: the server answers a registration with 1024.
        await expect(client.registerNotifications("server"), kind).rejects.toMatchObject({
          code: 1024,
        });
        await client.use({ id: 1 }, { nickname: `ts-js-reuse-${kind}` });
        const after = await whoAmI(client);
        expect(after.clientID, kind).not.toBe(before.clientID);

        for (const category of client.eventCategories) {
          await client.registerNotifications(category, category === "channel" ? 0 : undefined);
        }
        const target = (await listChannels(client)).find(
          (channel) => channel.name === PASSWORD_CHANNEL,
        );
        expect(target, kind).toBeDefined();
        await moveClient(client, after.clientID, target!.id, {
          password: PASSWORD_CHANNEL_PASSWORD,
        });
        const kicked = new Promise<KickedEvent>((resolve) => client.on("kicked", resolve));
        await kickClient(client, after.clientID, Reason.KickChannel, {
          reasonMessage: `again-${kind}`,
        });
        expect(await withTimeout(kicked), kind).toMatchObject({ reasonMessage: `again-${kind}` });
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
  }, 90_000);

  it.skipIf(!KINDS.includes("web"))(
    "delivers no events over WebQuery, and refuses to register for them",
    async () => {
      const web = clients.get("web")!;
      expect(web.eventCategories).toEqual([]);
      // A listener for a server event could never run, so the client refuses one
      // rather than accepting a listener that stays silent forever.
      expect(() => web.on("textMessage", () => {})).toThrow(TypeError);
      // The server refuses the command itself with 5120, which is why the client
      // never sends it there.
      await expect(web.registerNotifications("textserver")).rejects.toMatchObject({
        code: NOT_IN_API_KEY_SCOPE,
      });
    },
    30_000,
  );

  // The SSH transport writes an empty line to release a reply the server holds
  // back. That rests on the server taking an empty line and sending nothing
  // for it; this pins that, and that the session carries on normally after.
  it.skipIf(!KINDS.includes("ssh"))(
    "answers an empty line over SSH with nothing, and the next command normally",
    async () => {
      const transport = await connectSsh({
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        password: SSH_PASSWORD,
        knownHosts: sshKnownHosts,
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      const lines: string[] = [];
      transport.onLine = (line) => lines.push(line);
      const until = async (done: () => boolean): Promise<void> => {
        const limit = Date.now() + 10_000;
        while (!done()) {
          if (Date.now() > limit) throw new Error(`no answer; saw ${JSON.stringify(lines)}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      try {
        await transport.send("use 1");
        await until(() => lines.some((l) => l.startsWith("error ")));
        lines.length = 0;

        await transport.send("");
        await new Promise((r) => setTimeout(r, 1_000));
        expect(lines).toEqual([]);

        await transport.send("version");
        await until(() => lines.some((l) => l.startsWith("error ")));
        console.log("ssh empty line: lines after the next command", lines);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain("version=");
        expect(lines[1]).toMatch(/^error id=0 msg=ok/);
      } finally {
        await transport.close();
      }
    },
    30_000,
  );

  // The point of the check: a server that is not the one recorded is refused
  // before the login goes anywhere, whether it presents another key or the
  // address is not the recorded one at all.
  it.skipIf(!KINDS.includes("ssh"))(
    "refuses an SSH server whose host key is not the recorded one",
    async () => {
      const stranger = newSshKeyPair();
      const [keyType, encoded] = stranger.public.trim().split(/\s+/);
      const wrongKey = knownHostsFile(
        "stranger",
        `[${SSH_HOST}]:${SSH_PORT} ${keyType} ${encoded}\n`,
      );
      const client = new QueryClient({
        transport: {
          kind: "ssh",
          host: SSH_HOST,
          port: SSH_PORT,
          username: SSH_USER,
          password: SSH_PASSWORD,
          knownHosts: wrongKey,
        },
      });

      const error = await client
        .connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(SshHostKeyError);
      expect((error as SshHostKeyError).message).toContain("something else is answering");
      expect(client.status).toBe(ClientStatus.Disconnected);
      console.log(`ssh with the wrong key recorded: ${(error as Error).message}`);
    },
    30_000,
  );

  it.skipIf(!KINDS.includes("ssh"))(
    "refuses an SSH server that is not in the known_hosts file",
    async () => {
      const presented = await presentedSshKey();
      // The right key, recorded for another port: what a mistyped port looks like.
      const elsewhere = knownHostsFile(
        "other-port",
        `[${SSH_HOST}]:${SSH_PORT + 1} ${presented.keyType} ${Buffer.from(presented.key).toString("base64")}\n`,
      );
      const client = new QueryClient({
        transport: {
          kind: "ssh",
          host: SSH_HOST,
          port: SSH_PORT,
          username: SSH_USER,
          password: SSH_PASSWORD,
          knownHosts: elsewhere,
        },
      });

      const error = await client
        .connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) })
        .catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(SshHostKeyError);
      expect((error as SshHostKeyError).message).toContain("is not in");
      console.log(`ssh with the port not recorded: ${(error as Error).message}`);
    },
    30_000,
  );

  // With no server selected the server refuses `servernotifyregister` and
  // `clientlist` (1024) and answers the instance-level commands, so a client
  // with no `server` connects, and registers its events at the first `use`.
  it.each(KINDS.filter((kind) => kind !== "web"))(
    "connects over %s with no server selected, and selects one later",
    async (kind) => {
      const { server: _server, nickname: _nickname, ...options } = optionsFor(kind);
      const client = new QueryClient(options);
      await connectWithRetries(client);
      try {
        expect(client.status).toBe("connected");
        expect((await client.exec("instanceinfo")).length).toBe(1);
        expect((await client.exec("serverlist")).length).toBeGreaterThan(0);
        await client.use({ id: 1 });
        expect(Number((await client.exec("whoami"))[0]?.["client_id"])).toBeGreaterThan(0);
      } finally {
        await client.disconnect();
      }
    },
    30_000,
  );

  // The commands below are measured on TS3 and TS6 over every transport, and
  // each test leaves nothing behind. One test per transport, so a transport that
  // lacks a command skips just its own.
  describe.each(KINDS)("typed administration over %s", (kind) => {
    const connected = (): QueryClient => clients.get(kind)!;

    it("creates, lists and deletes an API key", async () => {
      const client = connected();
      const key = await addAPIKey(client, "read", { lifetimeDays: 1 });
      try {
        expect(key.key).not.toBe("");
        expect(key.scope).toBe("read");
        expect(key.expiresAt).toBeDefined();
        const listed = (await listAPIKeys(client)).find((entry) => entry.id === key.id);
        expect(listed).toMatchObject({ scope: "read", ownerDatabaseID: key.ownerDatabaseID });
      } finally {
        await deleteAPIKey(client, key.id);
      }
      expect((await listAPIKeys(client)).some((entry) => entry.id === key.id)).toBe(false);
      await expect(deleteAPIKey(client, key.id)).rejects.toMatchObject({ code: 5123 });
    }, 30_000);

    it("sets, lists, finds and deletes a custom property", async () => {
      const client = connected();
      const { databaseID } = await whoAmI(client);
      const ident = `ts_js_${Date.now()}`;
      try {
        await setCustomProperty(client, databaseID, ident, "hello world|x");
        expect(await listCustomProperties(client, databaseID)).toContainEqual({
          ident,
          value: "hello world|x",
        });
        expect(await findCustomProperty(client, ident, "%world%")).toEqual([
          { databaseID, ident, value: "hello world|x" },
        ]);
        expect(await findCustomProperty(client, ident, "nomatch")).toEqual([]);
      } finally {
        await deleteCustomProperty(client, databaseID, ident);
      }
      expect(await findCustomProperty(client, ident, "%")).toEqual([]);
    }, 30_000);

    it("enables a query login for a client, lists it and removes it", async (ctx) => {
      const client = connected();
      // A login belongs to a client record, and the records here are the voice
      // clients the other tests connected; one is borrowed and left as it was.
      const target = (await listClientDatabase(client, { limit: 50 })).find(
        (entry) => entry.uid !== "" && entry.uid !== "ServerQuery" && entry.uid !== "serveradmin",
      );
      if (target === undefined) {
        ctx.skip("the server has no voice client record to attach a login to");
        return;
      }
      const name = `tsjs${Date.now() % 1_000_000}`;
      const login = await addQueryLogin(client, name, { databaseID: target.databaseID });
      try {
        expect(login.password).not.toBe("");
        expect(login).toMatchObject({ databaseID: target.databaseID, name });
        const listed = await listQueryLogins(client, { pattern: `${name}%` });
        expect(listed.map((entry) => entry.name)).toEqual([name]);
      } finally {
        await deleteQueryLogin(client, target.databaseID);
      }
      expect(await listQueryLogins(client, { pattern: `${name}%` })).toEqual([]);
    }, 30_000);

    it("reads one of its own permissions", async () => {
      const permission = await getOwnPermission(connected(), permissionByName("b_client_ban_list"));
      expect(permission).toMatchObject({ name: "b_client_ban_list", value: 1 });
      expect(permission.id).toBeGreaterThan(0);
    }, 30_000);

    it("pages the ban list, bans by uid with a last nickname, and finds the ban", async (ctx) => {
      const client = connected();
      const uid = asUID(`tsjs${Date.now()}=`);
      const ids: BanID[] = [];
      try {
        const first = await addBan(client, { uid, lastNickname: "tsjs-nick", durationMs: 60_000 });
        ids.push(first!);
        const second = await addBan(client, {
          uid: asUID(`${uid}2`),
          lastNickname: "tsjs-nick2",
          durationMs: 60_000,
        });
        ids.push(second!);

        const all = await listBans(client);
        // Other bans can come and go on a shared server, so the page is checked
        // against the list rather than against a position in it.
        const page = await listBans(client, { start: 0, limit: 1 });
        expect(page).toHaveLength(1);
        expect(all.map((ban) => ban.id)).toContain(page[0]?.id);
        expect(await listBans(client, { start: 1_000_000 })).toEqual([]);

        const mine = all.find((ban) => ban.id === first);
        expect(mine).toMatchObject({ uid, lastNickname: "tsjs-nick" });
        expect(mine?.mytsid, "TS3 sends none, TS6 an empty one").toBe("");

        if (client.serverFamily !== "ts6" || kind === "web") {
          // TS3 has no banfind, and WebQuery answers it as an unknown command.
          await expect(findBans(client, { uid })).rejects.toBeDefined();
          ctx.skip("banfind is not served here");
          return;
        }
        expect((await findBans(client, { uid })).map((ban) => ban.id)).toEqual([first]);
        expect(await findBans(client, { uid: asUID("tsjs-absent=") })).toEqual([]);
      } finally {
        for (const id of ids) await deleteBan(client, id).catch(() => {});
      }
    }, 30_000);

    it("bans by myTeamSpeak id", async (ctx) => {
      const client = connected();
      if (client.serverFamily !== "ts6") {
        ctx.skip("TS3 has no myTeamSpeak id");
        return;
      }
      // 44 characters of base64: the only form the server accepts.
      const mytsid = `${"A".repeat(42)}${String.fromCharCode(65 + (Date.now() % 26))}=`;
      const id = await addBan(client, { mytsid, durationMs: 60_000 });
      try {
        expect((await listBans(client)).find((ban) => ban.id === id)?.mytsid).toBe(mytsid);
      } finally {
        await deleteBan(client, id!);
      }
    }, 30_000);

    it("reports a found client's channel on TS6, and ignores the flags on TS3", async () => {
      const client = connected();
      const me = await whoAmI(client);
      const matches = await findClients(client, me.nickname, { channelID: true, channelUID: true });
      // The pattern matches by substring, so other clients may be among them.
      const match = matches.find((entry) => entry.id === me.clientID);
      expect(match).toBeDefined();
      if (client.serverFamily === "ts6") {
        expect(match?.channelID).toBe(me.channelID);
        expect(match?.channelUID).not.toBe("");
      } else {
        expect(match?.channelID).toBeUndefined();
      }
    }, 30_000);

    it("lists the virtual servers", async () => {
      const client = connected();
      const servers = await listServers(client, { uid: true });
      const mine = servers.find((server) => server.id === asServerID(1));
      expect(mine).toMatchObject({ status: expect.stringContaining("online") as string });
      expect(mine?.port).toBeGreaterThan(0);
      expect(mine?.uid).not.toBe("");
      const [short] = await listServers(client, { short: true });
      expect(short).toMatchObject({ name: "", clientsOnline: undefined });
    }, 30_000);

    it("takes a snapshot, with and without a password", async () => {
      const client = connected();
      const plain = await createServerSnapshot(client);
      expect(plain.version).toBe(3);
      expect(plain.salt).toBe("");
      expect(plain.data.length).toBeGreaterThan(100);
      const encrypted = await createServerSnapshot(client, { password: "tsjs password" });
      expect(encrypted.salt).not.toBe("");
      expect(encrypted.data).not.toBe(plain.data);
    }, 30_000);

    it("logs out and unregisters notifications on a connection of its own", async (ctx) => {
      if (kind === "web") {
        // The api key is the login and nothing is registered: both are refused
        // as outside the key's scope.
        await expect(connected().logout()).rejects.toMatchObject({ code: NOT_IN_API_KEY_SCOPE });
        await expect(connected().unregisterNotifications()).rejects.toMatchObject({
          code: NOT_IN_API_KEY_SCOPE,
        });
        ctx.skip("WebQuery has neither a login to end nor events to unregister");
        return;
      }
      const own = new QueryClient(optionsFor(kind));
      await connectWithRetries(own);
      try {
        await own.unregisterNotifications("server");
        await own.unregisterNotifications();
        expect((await whoAmI(own)).serverID).toBe(1n);

        await own.logout();
        // Logging out deselects the virtual server as well.
        expect((await whoAmI(own)).serverID).toBe(0n);
        await expect(listChannels(own)).rejects.toMatchObject({
          code: expect.any(Number) as number,
        });
      } finally {
        await own.disconnect();
      }
    }, 60_000);
  });

  // The channel and server categories are registered by default, so the
  // events they carry reach every transport that can receive.
  it("receives channel and server changes as typed events", async (ctx) => {
    const receiving = eventClients(ctx);
    const actor = [...clients.values()][0]!;
    const alpha = (await listChannels(actor)).find((c) => c.name === DEFAULT_CHANNEL)!.id;
    const info = await getServerInfo(actor);
    const serverName = info[PropertyName.VirtualServerName] ?? "";
    const name = `ts-js-query-ev-${Date.now().toString(36)}`;

    /** Every receiving client's next event of `event` that `match` accepts. */
    const everyone = (event: string, match: (payload: Record<string, unknown>) => boolean) =>
      Promise.all(
        receiving.map(([kind, client]) =>
          withTimeout(
            new Promise<Record<string, unknown>>((resolve) => {
              const off = (
                client as unknown as {
                  on(n: string, l: (p: Record<string, unknown>) => void): () => void;
                }
              ).on(event, (payload) => {
                if (!match(payload)) return;
                off();
                resolve(payload);
              });
            }),
          ).catch((error: unknown) => {
            throw new Error(`${kind}: ${event}: ${String(error)}`);
          }),
        ),
      );
    const field = (payload: unknown, key: string): unknown =>
      (payload as Record<string, unknown>)[key];

    let cid: ChannelID | undefined;
    try {
      const madeEvents = everyone(
        "channelCreated",
        (e) =>
          field(e, "channelID") !== undefined &&
          (field(e, "changes") as { name?: string }).name === name,
      );
      cid = await createChannel(actor, { name, topic: "t1", isPermanent: true });
      const target = cid;
      for (const e of await madeEvents) {
        expect(field(e, "channelID")).toBe(target);
        expect(Object.keys(field(e, "changes") as object)).toEqual(
          expect.arrayContaining(["name", "topic", "isPermanent", "order"]),
        );
      }

      const edited = everyone("channelEdited", (e) => field(e, "channelID") === target);
      await editChannel(actor, target, { topic: "t2" });
      for (const e of await edited) {
        expect(Object.keys(field(e, "changes") as object)).toEqual(["topic"]);
        expect(field(e, "reason")).toBe(Reason.ChannelEdit);
      }

      const description = everyone(
        "channelDescriptionChanged",
        (e) => field(e, "channelID") === target,
      );
      await editChannel(actor, target, { description: "text" });
      await description;

      const password = everyone("channelPasswordChanged", (e) => field(e, "channelID") === target);
      await editChannel(actor, target, { password: "pw-ev" });
      await password;
      const cleared = everyone("channelPasswordChanged", (e) => field(e, "channelID") === target);
      await editChannel(actor, target, { password: "" });
      await cleared;

      const moved = everyone("channelMoved", (e) => field(e, "channelID") === target);
      await moveChannel(actor, target, alpha, { order: 0n as ChannelID });
      for (const e of await moved) expect(field(e, "parentID")).toBe(alpha);

      const deleted = everyone("channelDeleted", (e) => field(e, "channelID") === target);
      await deleteChannel(actor, target, { force: true });
      cid = undefined;
      await deleted;

      const renamed = everyone(
        "serverEdited",
        (e) => PropertyName.VirtualServerName in (field(e, "changes") as object),
      );
      await editServer(actor, { [PropertyName.VirtualServerName]: `${serverName} (ev)` });
      for (const e of await renamed) {
        expect(field(e, "changes")).toEqual({
          [PropertyName.VirtualServerName]: `${serverName} (ev)`,
        });
      }
    } finally {
      if (cid !== undefined) await deleteChannel(actor, cid, { force: true }).catch(() => {});
      await editServer(actor, { [PropertyName.VirtualServerName]: serverName }).catch(() => {});
    }
  }, 90_000);

  // Measured: neither TS3 over raw TCP nor TS6 over SSH sends a query client
  // these. Pinned, so that a server that starts to send one shows up, and the
  // event can then move to the shared map.
  it("receives none of the voice-only notifications", async (ctx) => {
    const receiving = eventClients(ctx);
    const speaker = await voiceClient();
    const seen = new Map<Kind, Set<string>>();
    const offs = receiving.map(([kind, client]) => {
      const names = new Set<string>();
      seen.set(kind, names);
      return client.on("notification", (n) => names.add(n.name));
    });
    try {
      await updateClient(speaker, { isAway: true, awayMessage: "ev" });
      await sendPluginCommand(speaker, "ts-js-plug", "x", "server");
      await sendChatComposing(speaker, speaker.clientID);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } finally {
      for (const off of offs) off();
      await updateClient(speaker, { isAway: false, awayMessage: "" }).catch(() => {});
    }
    for (const [kind, names] of seen) {
      console.log(`${kind}: notifications seen`, [...names]);
      for (const voiceOnly of [
        "notifyclientupdated",
        "notifyservergroupclientadded",
        "notifyservergroupclientdeleted",
        "notifyclientchannelgroupchanged",
        "notifyplugincmd",
        "notifyclientchatcomposing",
        "notifychannelsubscribed",
        "notifychannelunsubscribed",
      ]) {
        expect(names.has(voiceOnly), `${kind}: ${voiceOnly}`).toBe(false);
      }
    }
  }, 30_000);

  it.skipIf(KINDS.length < 2)(
    "reports the same channels over every transport it can use",
    async () => {
      const [, first] = [...clients][0]!;
      const expected = (await listChannels(first)).map((channel) => channel.name).sort();
      for (const [kind, other] of [...clients].slice(1)) {
        const names = (await listChannels(other)).map((channel) => channel.name).sort();
        expect(names, kind).toEqual(expected);
      }
    },
    40_000,
  );
});

describe.skipIf(SKIP)("Integration — group creates whose answer carries no data", () => {
  // Its own known_hosts file: the suite above removes its scratch directory,
  // and `sshKnownHosts` with it, once it is done.
  const scratch = mkdtempSync(join(tmpdir(), "query-recover-"));

  beforeAll(async () => {
    if (!KINDS.includes("ssh")) return;
    if (SSH_KNOWN_HOSTS !== "") {
      sshKnownHosts = SSH_KNOWN_HOSTS;
      return;
    }
    const path = join(scratch, "recorded");
    writeFileSync(path, knownHostsLine(await presentedSshKey()));
    sshKnownHosts = path;
  }, 30_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each(KINDS)(
    "finds the new group by name and type over %s",
    async (kind) => {
      const client = new QueryClient(optionsFor(kind));
      await connectWithRetries(client);
      // The server's quirk cannot be forced, so the answer's rows are dropped
      // for the create commands alone.
      const dropping: CommandExecutor = {
        send: async (request, options) => {
          const rows = await client.send(request, options);
          return /^(servergroup|channelgroup)(add|copy)$/.test(request.command) ? [] : rows;
        },
      };
      const name = `recover-${Date.now()}`;
      const sgids: ServerGroupID[] = [];
      const cgids: ChannelGroupID[] = [];
      try {
        const sg = await createServerGroup(dropping, name, GroupType.Regular);
        sgids.push(sg);
        const listedSG = (await listServerGroups(client)).find((g) => g.id === sg);
        console.log(`${kind}: servergrouplist type=${String(listedSG?.type)}`);
        expect(listedSG).toMatchObject({ name, type: GroupType.Regular });
        const sgCopy = await copyServerGroup(
          dropping,
          sg,
          asServerGroupID(0n),
          `${name}-c`,
          GroupType.Regular,
        );
        sgids.push(sgCopy);
        expect(sgCopy).not.toBe(sg);
        expect((await listServerGroups(client)).find((g) => g.id === sgCopy)?.name).toBe(
          `${name}-c`,
        );

        const cg = await createChannelGroup(dropping, name, GroupType.Regular);
        cgids.push(cg);
        const listedCG = (await listChannelGroups(client)).find((g) => g.id === cg);
        console.log(`${kind}: channelgrouplist type=${String(listedCG?.type)}`);
        expect(listedCG).toMatchObject({ name, type: GroupType.Regular });
        const cgCopy = await copyChannelGroup(
          dropping,
          cg,
          asChannelGroupID(0n),
          `${name}-c`,
          GroupType.Regular,
        );
        cgids.push(cgCopy);
        expect(cgCopy).not.toBe(cg);
      } finally {
        for (const id of sgids)
          await deleteServerGroup(client, id, { force: true }).catch(() => {});
        for (const id of cgids)
          await deleteChannelGroup(client, id, { force: true }).catch(() => {});
        await client.disconnect().catch(() => {});
      }
    },
    60_000,
  );
});

// A guest is a TeamSpeak 6 beta13 account with no credential: SSH user `guest`
// with no password, and a WebQuery request without an api key. It runs with the
// Guest Server Query group's permissions, so what it may do is the server's to
// say. Measured on beta13.1: `version` and `whoami` answer; `instanceinfo` is
// refused with 2568 over SSH, and WebQuery refuses `apikeylist` with 5120, a
// command outside the guest scope.
describe.skipIf(SKIP || !GUEST)("Integration — guest ServerQuery", () => {
  const scratch = mkdtempSync(join(tmpdir(), "query-guest-"));
  let knownHosts = "";

  /** The guest transports this run can use. */
  const guestKinds = KINDS.filter((kind): kind is "ssh" | "web" => kind !== "tcp");

  function guestOptions(kind: "ssh" | "web"): QueryClientOptions {
    return {
      transport:
        kind === "ssh"
          ? { kind: "ssh", host: SSH_HOST, port: SSH_PORT, guest: true, knownHosts }
          : { kind: "web", url: QUERY_URL, guest: true },
      server: { id: 1 },
      // The Guest Server Query group decides whether a guest may register for
      // notifications; a client that does not need them does not ask.
      events: kind === "ssh" ? false : undefined,
    };
  }

  beforeAll(async () => {
    if (SKIP || !GUEST) return;
    if (KINDS.includes("ssh")) {
      const line = SSH_KNOWN_HOSTS !== "" ? undefined : knownHostsLine(await presentedSshKey());
      knownHosts = SSH_KNOWN_HOSTS;
      if (line !== undefined) {
        knownHosts = join(scratch, "recorded");
        writeFileSync(knownHosts, line);
      }
    }
  }, 30_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Connect as a guest over `kind`, then check one admin-only command is refused. */
  async function guestIsRefusedWhatIsAdminOnly(kind: "ssh" | "web"): Promise<void> {
    const client = new QueryClient(guestOptions(kind));
    await connectWithRetries(client);
    try {
      expect(client.status).toBe(ClientStatus.Connected);
      expect((await getVersion(client)).version).not.toBe("");
      // The guest is its own account, not the administrator.
      const me = await whoAmI(client);
      expect(me.loginName).not.toBe("serveradmin");

      const refused = await (kind === "ssh" ? getInstanceInfo(client) : listAPIKeys(client)).catch(
        (failure: unknown) => failure,
      );
      expect(refused).toMatchObject({ code: kind === "ssh" ? 2568 : NOT_IN_API_KEY_SCOPE });
      console.log(
        `guest over ${kind}: an admin-only command refused with ${String((refused as { code?: unknown }).code)}`,
      );
    } finally {
      await client.disconnect();
    }
  }

  it.skipIf(!guestKinds.includes("ssh"))(
    "a guest connects over ssh, and is refused what is admin-only",
    () => guestIsRefusedWhatIsAdminOnly("ssh"),
    60_000,
  );

  it.skipIf(!guestKinds.includes("web"))(
    "a guest connects over web, and is refused what is admin-only",
    () => guestIsRefusedWhatIsAdminOnly("web"),
    60_000,
  );

  it.skipIf(!guestKinds.includes("web"))(
    "a guest over web is refused hostinfo, and the answer names the permission",
    async () => {
      const client = new QueryClient(guestOptions("web"));
      await connectWithRetries(client);
      try {
        const refused = await client.exec("hostinfo").catch((failure: unknown) => failure);
        expect(refused).toMatchObject({
          code: 2568,
          failedPermission: "b_serverinstance_info_view",
          failedPermissionID: undefined,
        });
      } finally {
        await client.disconnect();
      }
    },
    60_000,
  );

  it.skipIf(!KINDS.includes("web"))(
    "a WebQuery request with a wrong api key is not a guest",
    async () => {
      const client = new QueryClient({
        transport: { kind: "web", url: QUERY_URL, apiKey: "not-a-key" },
        server: { id: 1 },
      });
      await expect(
        client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) }),
      ).rejects.toBeDefined();
    },
    30_000,
  );
});

// Where the fixture does not say the server has guest access (TeamSpeak 3 has
// none; a TeamSpeak 6 started with it off refuses too), a guest connection is
// refused, and the refusal says so. Measured on 3.13.8: WebQuery answers 5124
// ("missing apikey", HTTP 401) and SSH fails the `guest` user's authentication.
describe.skipIf(SKIP || GUEST)("Integration — a server with no guest access", () => {
  const scratch = mkdtempSync(join(tmpdir(), "query-noguest-"));
  let knownHosts = "";

  beforeAll(async () => {
    if (SKIP || GUEST || !KINDS.includes("ssh")) return;
    const line = SSH_KNOWN_HOSTS !== "" ? undefined : knownHostsLine(await presentedSshKey());
    knownHosts = SSH_KNOWN_HOSTS;
    if (line !== undefined) {
      knownHosts = join(scratch, "recorded");
      writeFileSync(knownHosts, line);
    }
  }, 30_000);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The error a guest connection ends in. */
  async function refusal(options: QueryClientOptions): Promise<unknown> {
    const client = new QueryClient(options);
    try {
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    } catch (error) {
      return error;
    }
    await client.disconnect();
    throw new Error("the guest connection was accepted");
  }

  it.skipIf(!KINDS.includes("web"))(
    "a guest over web is told there is no guest access, with the server's code",
    async () => {
      const error = await refusal({
        transport: { kind: "web", url: QUERY_URL, guest: true },
        server: { id: 1 },
      });
      expect(error).toBeInstanceOf(GuestAccessError);
      expect((error as GuestAccessError).code).toBe(5124);
      expect((error as GuestAccessError).message).toContain("does not offer guest access");
    },
    30_000,
  );

  it.skipIf(!KINDS.includes("ssh"))(
    "a guest over ssh is told there is no guest access, with the login failure",
    async () => {
      const error = await refusal({
        transport: { kind: "ssh", host: SSH_HOST, port: SSH_PORT, guest: true, knownHosts },
        server: { id: 1 },
        events: false,
      });
      expect(error).toBeInstanceOf(GuestAccessError);
      expect((error as GuestAccessError).cause).toBeInstanceOf(QueryAuthError);
    },
    30_000,
  );
});
