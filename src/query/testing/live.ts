/**
 * What the live ServerQuery suites share: the environment the fixture writes,
 * one connected client per transport, and a voice client to stand in as the
 * other party. The suites that use it live in `*.integration.test.ts` files and
 * run when `scripts/ts3-fixture.sh` has provisioned a server; see
 * `src/query/integration.test.ts` for how to start one.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  GroupType,
  addPrivilegeKey,
  deleteChannel,
  listChannels,
  listClients,
  listServerGroups,
  type ChannelID,
  type ClientDBID,
  type CommandExecutor,
} from "@honeybbq/teamspeak";
import { Client } from "../../client/client.js";
import { generateIdentitySync } from "../../client/crypto/identity.js";
import { QueryClient } from "../client.js";
import type { QueryClientOptions } from "../options.js";
import { connectSsh } from "../ssh.js";
import type { SshHostKey } from "../ssh.js";

export const VOICE_ADDR: string | undefined = process.env["TEAMSPEAK_ADDR"];
export const DEFAULT_CHANNEL: string = process.env["TEAMSPEAK_DEFAULT_CHANNEL"] ?? "";
export const SERVER_PASSWORD: string = process.env["TEAMSPEAK_SERVER_PASSWORD"] ?? "";
export const SERVER_FAMILY: string = process.env["TEAMSPEAK_QUERY_FAMILY"] ?? "";

const QUERY_KIND = process.env["TEAMSPEAK_QUERY_KIND"];
const QUERY_HOST = process.env["TEAMSPEAK_QUERY_HOST"] ?? "";
const QUERY_PORT = Number(process.env["TEAMSPEAK_QUERY_PORT"] ?? "10011");
const QUERY_URL = process.env["TEAMSPEAK_QUERY_URL"] ?? "";
const QUERY_API_KEY = process.env["TEAMSPEAK_QUERY_API_KEY"] ?? "";
export const LOGIN_NAME: string = process.env["TEAMSPEAK_QUERY_LOGIN_NAME"] ?? "";
export const LOGIN_PASSWORD: string = process.env["TEAMSPEAK_QUERY_LOGIN_PASSWORD"] ?? "";

const SSH_PORT = Number(process.env["TEAMSPEAK_QUERY_SSH_PORT"] ?? "0");
const SSH_HOST = process.env["TEAMSPEAK_QUERY_SSH_HOST"] ?? QUERY_HOST;
const SSH_USER = process.env["TEAMSPEAK_QUERY_SSH_USER"] ?? "";
const SSH_PASSWORD = process.env["TEAMSPEAK_QUERY_SSH_PASSWORD"] ?? "";
const SSH_KNOWN_HOSTS = process.env["TEAMSPEAK_QUERY_SSH_KNOWN_HOSTS"] ?? "";

export type Kind = "tcp" | "web" | "ssh";

/** The transports this run can use, from what the fixture provisioned. */
export const KINDS: readonly Kind[] = [
  ...(QUERY_KIND === "tcp" || QUERY_HOST !== "" ? (["tcp"] as const) : []),
  ...(QUERY_KIND === "web" || (QUERY_URL !== "" && QUERY_API_KEY !== "") ? (["web"] as const) : []),
  ...(SSH_PORT > 0 ? (["ssh"] as const) : []),
];

/** True when no server was provisioned: the suites skip rather than fail. */
export const SKIP: boolean = VOICE_ADDR === undefined || KINDS.length === 0;

/**
 * Whether the run may stop and delete virtual servers and edit the instance:
 * only against a server that is thrown away afterwards, such as the one a CI
 * job starts.
 */
export const DESTRUCTIVE: boolean = process.env["TEAMSPEAK_QUERY_DESTRUCTIVE"] === "1";

/** Whether the run may stop the server process, which ends every test after it. */
export const STOP_INSTANCE: boolean = process.env["TEAMSPEAK_QUERY_STOP_INSTANCE"] === "1";

export const CONNECT_TIMEOUT_MS: number = 15_000;
export const EVENT_TIMEOUT_MS: number = 10_000;
const CONNECT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * Time to let a TeamSpeak 3 server finish closing an SSH query session, as
 * `src/query/integration.test.ts` explains.
 */
const SSH_TEARDOWN_MS = 50;

/** Register the pause after each test that an SSH run needs. Call it once per file. */
export function pauseAfterSshTests(): void {
  afterEach(async () => {
    if (KINDS.includes("ssh")) await new Promise((resolve) => setTimeout(resolve, SSH_TEARDOWN_MS));
  });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Reject rather than hang when something expected never arrives. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = EVENT_TIMEOUT_MS,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("it did not arrive in time")), timeoutMs),
    ),
  ]);
}

/** A name no earlier run used, for what a test creates on the shared server. */
export function stamp(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** The options for one transport kind; `knownHosts` is the file SSH verifies against. */
export function optionsFor(
  kind: Kind,
  knownHosts: string,
  nickname: string = "ts-js-live",
): QueryClientOptions {
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
        nickname,
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
          knownHosts,
        },
        server: { id: 1 },
        nickname,
      };
    default:
      throw new TypeError(`unknown query transport ${String(kind)}`);
  }
}

/** Connect, trying again when the query flood limit refuses an address that arrived too fast. */
export async function connectWithRetries(client: QueryClient): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      return;
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      console.warn(`query connect attempt ${attempt} of ${CONNECT_ATTEMPTS}: ${String(error)}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/**
 * One connected client per transport, and what the suite that made them has
 * to tidy up.
 */
export class LiveSession {
  readonly clients: Map<Kind, QueryClient> = new Map<Kind, QueryClient>();
  readonly #scratch = mkdtempSync(join(tmpdir(), "query-live-"));
  #knownHosts = "";
  readonly #voices: Client[] = [];

  /** The file the SSH transport verifies against: the key the server presents, recorded first. */
  get knownHosts(): string {
    return this.#knownHosts;
  }

  /** Probe the SSH host key once, then connect one client per transport. */
  async open(): Promise<void> {
    if (KINDS.includes("ssh")) {
      if (SSH_KNOWN_HOSTS !== "") {
        this.#knownHosts = SSH_KNOWN_HOSTS;
      } else {
        const key = await probeSshKey();
        this.#knownHosts = join(this.#scratch, "recorded");
        writeFileSync(
          this.#knownHosts,
          `[${SSH_HOST}]:${SSH_PORT} ${key.keyType} ${Buffer.from(key.key).toString("base64")}\n`,
        );
      }
    }
    for (const kind of KINDS) {
      const client = new QueryClient(optionsFor(kind, this.#knownHosts));
      await connectWithRetries(client);
      this.clients.set(kind, client);
    }
  }

  /** A fresh client of one kind, which the caller disconnects. */
  async connectNew(
    kind: Kind,
    nickname: string,
    selectServer: boolean = true,
  ): Promise<QueryClient> {
    const options = optionsFor(kind, this.#knownHosts, nickname);
    const client = new QueryClient(
      selectServer || kind !== "web" ? options : { ...options, server: undefined },
    );
    await connectWithRetries(client);
    return client;
  }

  /**
   * A voice client on a throwaway identity, disconnected by {@link close}.
   * With a `groupName` it joins holding that server group, through a privilege
   * key the `admin` executor makes for it, so it may run admin commands too.
   */
  async voice(
    nickname: string,
    options: { admin?: CommandExecutor; groupName?: RegExp; channel?: string } = {},
  ): Promise<Client> {
    let privilegeKey = "";
    if (options.admin !== undefined && options.groupName !== undefined) {
      const group = (await listServerGroups(options.admin)).find(
        (g) => g.type === GroupType.Regular && options.groupName!.test(g.name),
      );
      if (group === undefined)
        throw new Error(`no server group matches ${String(options.groupName)}`);
      privilegeKey = await addPrivilegeKey(options.admin, {
        serverGroupID: group.id,
        description: nickname,
      });
    }
    const client = new Client(generateIdentitySync(8), VOICE_ADDR!, nickname, {
      serverPassword: SERVER_PASSWORD,
      defaultChannel: options.channel ?? DEFAULT_CHANNEL,
      privilegeKey,
    });
    for (let attempt = 1; ; attempt++) {
      try {
        await client.connect({ signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
        break;
      } catch (error) {
        if (attempt === CONNECT_ATTEMPTS) throw error;
        await sleep(RETRY_DELAY_MS);
      }
    }
    this.#voices.push(client);
    // Antiflood counts connects, and a client that has only just arrived is
    // not yet known to the others.
    await sleep(1_100);
    return client;
  }

  /** Remove channels a test made, whichever transport is at hand. */
  async deleteChannels(ids: Iterable<ChannelID>): Promise<void> {
    const admin = this.first();
    for (const id of ids) await deleteChannel(admin, id, { force: true }).catch(() => {});
  }

  /** The channel with this name, or undefined. */
  async channelNamed(name: string): Promise<ChannelID | undefined> {
    return (await listChannels(this.first())).find((c) => c.name === name)?.id;
  }

  /**
   * The database id of the client with this nickname. A voice client is not
   * always on the list the moment its connect returns, so this looks for up
   * to ten seconds.
   */
  async databaseIDOf(nickname: string): Promise<ClientDBID> {
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    for (;;) {
      const found = (await listClients(this.first())).find((c) => c.nickname === nickname);
      if (found?.databaseID !== undefined) return found.databaseID;
      if (Date.now() > deadline) throw new Error(`no client named ${nickname} on the list`);
      await sleep(250);
    }
  }

  /** The first transport's client. */
  first(): QueryClient {
    return [...this.clients.values()][0]!;
  }

  async close(): Promise<void> {
    for (const voice of this.#voices) await voice.disconnect().catch(() => {});
    for (const client of this.clients.values()) await client.disconnect().catch(() => {});
    rmSync(this.#scratch, { recursive: true, force: true });
  }
}

/** Ask the SSH server for its key; the check runs before the login, so a refusing probe sends nothing. */
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
  if (presented === undefined) throw new Error(`the server at ${SSH_HOST}:${SSH_PORT} sent no key`);
  return presented;
}
