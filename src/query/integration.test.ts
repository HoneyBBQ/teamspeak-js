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
import { utils } from "ssh2";
import { describe, it, expect, beforeAll, afterAll, type TestContext } from "vitest";
import {
  ClientStatus,
  Reason,
  TextMessageTarget,
  createChannel,
  getVersion,
  kickClient,
  listChannels,
  moveClient,
  sendChannelMessage,
  whoAmI,
  type ChannelID,
} from "@honeybbq/teamspeak";
import { Client } from "../client/client.js";
import { generateIdentitySync } from "../client/crypto/identity.js";
import { QueryClient } from "./client.js";
import { SshHostKeyError } from "./errors.js";
import type { QueryClientOptions } from "./options.js";
import { connectSsh } from "./ssh.js";
import type { SshHostKey } from "./ssh.js";
import type {
  ClientEnterEvent,
  ClientMovedEvent,
  KickedEvent,
  TextMessageEvent,
} from "@honeybbq/teamspeak";

const VOICE_ADDR = process.env["TEAMSPEAK_ADDR"];
const DEFAULT_CHANNEL = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
const PASSWORD_CHANNEL = process.env["TEAMSPEAK_PASSWORD_CHANNEL"] ?? "";
const PASSWORD_CHANNEL_PASSWORD = process.env["TEAMSPEAK_PASSWORD_CHANNEL_PASSWORD"] ?? "";

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

/** 5120, `command not in api key scope`: not a name `ErrorCode` gives. */
const NOT_IN_API_KEY_SCOPE = 5120;

const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const EVENT_TIMEOUT_MS = 10_000;

type Kind = "tcp" | "web" | "ssh";

/** The transports this run can use, from what the fixture provisioned. */
const KINDS: readonly Kind[] = [
  ...(QUERY_KIND === "tcp" ? (["tcp"] as const) : []),
  ...(QUERY_KIND === "web" ? (["web"] as const) : []),
  ...(SSH_PORT > 0 ? (["ssh"] as const) : []),
];

const SKIP = VOICE_ADDR === undefined || KINDS.length === 0;

/** The `known_hosts` file the SSH transport verifies against; set once the suite starts. */
let sshKnownHosts = "";

/** A line of a `known_hosts` file for the SSH server at `host`:`port`, holding `key`. */
function knownHostsLine(key: Pick<SshHostKey, "keyType" | "key">): string {
  return `[${SSH_HOST}]:${SSH_PORT} ${key.keyType} ${Buffer.from(key.key).toString("base64")}\n`;
}

/**
 * The key the SSH server presents. The check runs before the login, so a probe
 * that refuses the key has seen it and sent nothing.
 */
async function presentedSshKey(): Promise<SshHostKey> {
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
  if (presented === undefined) throw new Error(`the server at ${SSH_HOST}:${SSH_PORT} sent no key`);
  return presented;
}

/** The options for one transport kind. */
function optionsFor(kind: Kind): QueryClientOptions {
  switch (kind) {
    case "tcp":
      return {
        transport: { kind: "tcp", host: QUERY_HOST, port: QUERY_PORT },
        login: { name: LOGIN_NAME, password: LOGIN_PASSWORD },
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
      expect(["ts3", "ts6"], kind).toContain(client.serverFamily);

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
          if (event.clientID === joiner.clientID) resolve(event);
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

  // The point of the check: a server that is not the one recorded is refused
  // before the login goes anywhere, whether it presents another key or the
  // address is not the recorded one at all.
  it.skipIf(!KINDS.includes("ssh"))(
    "refuses an SSH server whose host key is not the recorded one",
    async () => {
      const stranger = utils.generateKeyPairSync("ed25519");
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
