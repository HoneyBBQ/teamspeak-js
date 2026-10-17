/**
 * Can a ServerQuery client run every typed command and event of the core?
 *
 * The core's typed commands and event payloads were shaped by the voice
 * protocol. This runs each of the commands through a QueryClient against real
 * servers and records, per command:
 *
 *   - whether the server accepts it: data, a plain `ok`, an error id, or no
 *     answer at all;
 *   - the keys of the rows it answers with;
 *   - which keys the core's parser read and did not find, which is what a
 *     silent `""` or `0` in a parsed result means: the parser reads every
 *     field through a row, so each row is wrapped to notice a missing key;
 *   - for a create, whether the new id comes back.
 *
 * Then it checks the cases a type cannot show: empty and no-match answers,
 * paging, passwords against a voice client, file transfers and events.
 *
 * Three targets, run one after another:
 *
 *   ts3     TeamSpeak 3, raw TCP on 10011
 *   ts6     TeamSpeak 6, WebQuery on 10080 (no raw TCP, and SSH is off by default)
 *   ts6ssh  a second TeamSpeak 6 started with `TSSERVER_QUERY_SSH_ENABLED=1`, SSH
 *
 * The servers need the fixture first (scripts/ts3-fixture.sh), and ts6ssh a
 * container of its own:
 *
 *   docker run -d --name ts6ssh -e TSSERVER_LICENSE_ACCEPTED=accept \
 *     -e TSSERVER_QUERY_HTTP_ENABLED=1 -e TSSERVER_QUERY_SSH_ENABLED=1 \
 *     -e TSSERVER_QUERY_ADMIN_PASSWORD=probepass1 \
 *     -e TSSERVER_QUERY_ADMIN_API_KEY=<key> -e TSSERVER_FILE_TRANSFER_PORT=30035 \
 *     -p 10122:10022 -p 10180:10080 -p 9989:9987/udp -p 30035:30035 \
 *     teamspeaksystems/teamspeak6-server:latest
 *
 *   pnpm tsx scripts/probe-serverquery.mts
 *
 * Credentials are read from the containers' logs. TARGETS=ts3,ts6 picks
 * targets and OUT=file.json keeps the measurements.
 *
 * The probe cleans up what it creates and leaves the fixture's channels, the
 * instance settings and every permission as it found them. It skips
 * `permreset`, which resets the whole server, and runs `bandelall` only when
 * every ban on the server is its own.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  CommandTimeoutError,
  GroupType,
  PermissionName,
  ServerError,
  addBan,
  addChannelClientPermission,
  addChannelGroupPermission,
  addChannelPermission,
  addClientPermission,
  addClientToServerGroup,
  addComplaint,
  addLog,
  addPrivilegeKey,
  addServerGroupPermission,
  addTempPassword,
  asChannelGroupID,
  asChannelID,
  asClientDBID,
  asClientID,
  asServerFileTransferID,
  asServerGroupID,
  asUID,
  banClient,
  copyChannelGroup,
  copyServerGroup,
  createChannel,
  createChannelGroup,
  createDirectory,
  createServerGroup,
  deleteAllBans,
  deleteAllComplaints,
  deleteBan,
  deleteChannel,
  deleteChannelClientPermission,
  deleteChannelGroup,
  deleteChannelGroupPermission,
  deleteChannelPermission,
  deleteClientDatabase,
  deleteClientPermission,
  deleteComplaint,
  deleteFile,
  deleteMessage,
  deletePrivilegeKey,
  deleteServerGroup,
  deleteServerGroupPermission,
  deleteTempPassword,
  editChannel,
  editClient,
  editClientDatabase,
  editInstance,
  editServer,
  findChannels,
  findClientDatabase,
  findClients,
  findPermission,
  getChannelInfo,
  getClientDBIDByUID,
  getClientDatabaseInfo,
  getClientIDs,
  getClientProperties,
  getClientNameByDBID,
  getClientNameByUID,
  getClientUIDByID,
  getConnectionInfo,
  getFileInfo,
  getHostInfo,
  getInstanceInfo,
  getMessage,
  getPermissionIDByName,
  getPermissionOverview,
  getServerGroupsByClient,
  getServerIDByPort,
  getServerInfo,
  getVersion,
  initFileDownload,
  initFileUpload,
  iterateClientDatabase,
  kickClient,
  listActiveTransfers,
  listBans,
  listBindings,
  listChannelClientPermissions,
  listChannelGroupClients,
  listChannelGroupPermissions,
  listChannelGroups,
  listChannelPermissions,
  listChannels,
  listClientDatabase,
  listClientPermissions,
  listClients,
  listComplaints,
  listFiles,
  listMessages,
  listPermissions,
  listPrivilegeKeys,
  listServerGroupClients,
  listServerGroupPermissions,
  listServerGroups,
  listTempPasswords,
  moveChannel,
  moveClient,
  permissionByName,
  pokeClient,
  removeClientFromServerGroup,
  renameChannelGroup,
  renameFile,
  renameServerGroup,
  sendChannelMessage,
  sendPrivateMessage,
  sendServerMessage,
  setClientChannelGroup,
  stopFileTransfer,
  updateClient,
  updateMessageFlag,
  usePrivilegeKey,
  viewLog,
  whoAmI,
} from "../src/core/index.js";
import type {
  ChannelID,
  ClientEnterEvent,
  CommandExecutor,
  CommandOptions,
  CommandRequest,
  NotificationEvent,
} from "../src/core/index.js";
import { parseCommand, splitCommandRows } from "../src/core/internal.js";
import { Client } from "../src/client/client.js";
import { handleNotification } from "../src/core/internal.js";
import { generateIdentitySync } from "../src/client/crypto/identity.js";
import { uploadFileData, downloadFileData } from "../src/client/transfer.js";
import { QueryClient } from "../src/query/client.js";
import { WebQueryTransport } from "../src/query/web.js";
import { connectTcp } from "../src/query/tcp.js";
import { connectSsh } from "../src/query/ssh.js";
import type { QueryTransport } from "../src/query/transport.js";

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tag = Date.now().toString(36).slice(-5);

// ---- Targets ----------------------------------------------------------------

function dockerLog(container: string): string {
  const out = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  return `${out.stdout}${out.stderr}`;
}

function logged(container: string, key: string): string {
  const match = new RegExp(`${key}= "([^"]*)"`).exec(dockerLog(container));
  if (!match) throw new Error(`no ${key} in the logs of ${container}`);
  return match[1] ?? "";
}

interface Target {
  readonly name: string;
  readonly label: string;
  readonly kind: "raw" | "web" | "ssh";
  /** The voice address the helper clients connect to. */
  readonly voice: string;
  readonly host: string;
  readonly open: () => Promise<QueryTransport>;
}

const targets: Target[] = [
  {
    name: "ts3",
    label: "TS3, raw TCP",
    kind: "raw",
    voice: "127.0.0.1:9987",
    host: "127.0.0.1",
    open: () => connectTcp({ host: "127.0.0.1", port: 10011 }),
  },
  {
    name: "ts6",
    label: "TS6, WebQuery",
    kind: "web",
    voice: "127.0.0.1:9988",
    host: "127.0.0.1",
    open: async () =>
      new WebQueryTransport({
        url: "http://127.0.0.1:10080",
        apiKey: logged("ts6", "apikey"),
        serverID: 1,
      }),
  },
  {
    name: "ts6ssh",
    label: "TS6, SSH",
    kind: "ssh",
    voice: "127.0.0.1:9989",
    host: "127.0.0.1",
    open: () =>
      connectSsh({
        host: "127.0.0.1",
        port: 10122,
        username: "serveradmin",
        password: process.env["TS6SSH_PASSWORD"] ?? "probepass1",
        // A throwaway container on this machine, whose key changes with every
        // container: there is no recorded key to check it against, and nobody
        // else to answer the loopback port.
        insecureIgnoreHostKey: true,
      }),
  },
];

/** A transport that keeps every line the server sent, for comparing with what the client made of it. */
class Tap implements QueryTransport {
  lines: string[] = [];
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;
  #inner: QueryTransport;
  constructor(inner: QueryTransport) {
    this.#inner = inner;
    inner.onLine = (line) => {
      this.lines.push(line);
      this.onLine?.(line);
    };
    inner.onClose = (error) => this.onClose?.(error);
  }
  send(line: string): Promise<void> {
    return this.#inner.send(line);
  }
  close(): Promise<void> {
    return this.#inner.close();
  }
}

// ---- Recording --------------------------------------------------------------

interface Call {
  command: string;
  outcome: "rows" | "ok" | "error" | "timeout" | "transport";
  errorId?: number;
  errorMessage?: string;
  extraMessage?: string | undefined;
  rows: number;
  keys: string[];
  /** Keys the core's parser asked a row for and the row did not have. */
  missing: string[];
  /** Data lines whose rows would differ if each were completed from the row before. */
  inheritDiffs: number;
  /** Where the parser's lookups are collected until its caller has finished with the rows. */
  watch?: Set<string> | undefined;
}

interface Step {
  fn: string;
  calls: Call[];
  value?: string;
  thrown?: string;
  note?: string;
}

const replacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value}n` : value instanceof Date ? value.toISOString() : value;
const show = (value: unknown, max = 400): string => {
  const text = JSON.stringify(value, replacer) ?? "undefined";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** An executor that notes what each command answered and which keys the parser looked for in vain. */
class Recorder implements CommandExecutor {
  calls: Call[] = [];
  readonly client: QueryClient;
  readonly tap: Tap;
  readonly kind: Target["kind"];
  constructor(tap: Tap, kind: Target["kind"]) {
    this.tap = tap;
    this.kind = kind;
    this.client = new QueryClient(tap);
  }

  async send(
    request: CommandRequest,
    options: CommandOptions = {},
  ): Promise<Array<Record<string, string>>> {
    const command = request.command;
    const from = this.tap.lines.length;
    const call: Call = {
      command,
      outcome: "ok",
      rows: 0,
      keys: [],
      missing: [],
      inheritDiffs: 0,
    };
    this.calls.push(call);
    try {
      const rows = await this.client.send(request, { timeoutMs: 8000, ...options });
      call.rows = rows.length;
      call.outcome = rows.length > 0 ? "rows" : "ok";
      call.keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      call.inheritDiffs = this.#inheritDiffs(this.tap.lines.slice(from));
      const missing = new Set<string>();
      const watched = rows.map(
        (row) =>
          new Proxy(row, {
            get(target, key) {
              if (typeof key === "string" && !(key in target) && key !== "then" && key !== "toJSON")
                missing.add(key);
              return target[key as string];
            },
          }),
      );
      // The proxies are read by the caller after this returns; the step
      // reports `missing` once the caller has finished.
      call.watch = missing;
      return watched;
    } catch (error) {
      if (error instanceof ServerError) {
        call.outcome = "error";
        call.errorId = error.code;
        call.errorMessage = error.message;
        call.extraMessage = error.extraMessage;
      } else if (error instanceof CommandTimeoutError) {
        call.outcome = "timeout";
      } else {
        call.outcome = "transport";
        call.errorMessage = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  #inheritDiffs(lines: string[]): number {
    let diffs = 0;
    for (const line of lines) {
      const head = parseCommand(line);
      if (!line.includes("|") || head === null || line.startsWith("error ")) continue;
      if (head.name.startsWith("notify")) continue;
      const completed = splitCommandRows(line).map((row) => parseCommand(row)?.params);
      const plain = line.split("|").map((row, i) => {
        const text = i > 0 && head.name !== "" ? `${head.name} ${row}` : row;
        return parseCommand(text)?.params;
      });
      if (JSON.stringify(completed) !== JSON.stringify(plain)) diffs++;
    }
    return diffs;
  }
}

const results = new Map<string, Step[]>();

type Run = {
  readonly q: Recorder;
  readonly target: Target;
  readonly steps: Step[];
};

/** Run one typed command and record what it answered. */
async function step<T>(
  run: Run,
  fn: string,
  body: () => Promise<T>,
  note?: string,
): Promise<T | undefined> {
  const before = run.q.calls.length;
  const record: Step = { fn, calls: [], ...(note === undefined ? {} : { note }) };
  run.steps.push(record);
  let value: T | undefined;
  try {
    value = await body();
    record.value = show(value);
  } catch (error) {
    record.thrown =
      error instanceof ServerError
        ? `ServerError ${error.code} ${error.message}`
        : error instanceof Error
          ? `${error.constructor.name}: ${error.message}`
          : String(error);
  }
  // The parser has read every row by now: collect the keys it asked for in vain.
  record.calls = run.q.calls.slice(before);
  for (const call of record.calls) {
    if (call.watch) call.missing = [...call.watch];
    delete call.watch;
  }
  const first = record.calls[0];
  console.log(
    `${run.target.name.padEnd(6)} ${fn.padEnd(30)} ${describe(first)}` +
      (record.thrown ? `  threw ${record.thrown}` : "") +
      (record.calls.some((c) => c.missing.length)
        ? `  missing=${[...new Set(record.calls.flatMap((c) => c.missing))].join(",")}`
        : ""),
  );
  return value;
}

function describe(call: Call | undefined): string {
  if (!call) return "no command sent";
  switch (call.outcome) {
    case "rows":
      return `rows(${call.rows}) [${call.keys.slice(0, 6).join(",")}${call.keys.length > 6 ? ",…" : ""}]`;
    case "ok":
      return "ok";
    case "error":
      return `error ${call.errorId} ${call.errorMessage}${call.extraMessage ? ` (${call.extraMessage})` : ""}`;
    case "timeout":
      return "no answer";
    case "transport":
      return `transport: ${call.errorMessage}`;
    default:
      return "unknown";
  }
}

// ---- Voice clients ----------------------------------------------------------

async function voice(target: Target, nickname: string, extra: { serverPassword?: string } = {}) {
  const client = new Client(generateIdentitySync(8), target.voice, nickname, {
    defaultChannel: "Alpha",
    logger: quiet,
    ...extra,
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect({ signal: AbortSignal.timeout(10_000) });
      return client;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1500);
    }
  }
}

const cleanups: Array<[string, () => Promise<unknown>]> = [];
const later = (what: string, fn: () => Promise<unknown>) => cleanups.push([what, fn]);

// ---- One target -------------------------------------------------------------

interface Findings {
  steps: Step[];
  extra: Record<string, unknown>;
}

async function probe(target: Target): Promise<Findings> {
  const transport = await target.open();
  const q = new Recorder(new Tap(transport), target.kind);
  const run: Run = { q, target, steps: [] };
  const extra: Record<string, unknown> = {};
  results.set(target.name, run.steps);
  const voices: Client[] = [];

  try {
    if (target.kind === "raw")
      await q.client.login("serveradmin", process.env["TS3_ADMIN_PW"] ?? logged("ts3", "password"));
    await q.client.use({ id: 1 }, { nickname: `pq-${tag}` });
    // login/use are not typed commands; note how they answered.
    extra["login+use"] = q.calls.map(describe);

    const me = (await step(run, "whoAmI", () => whoAmI(q)))!;
    const version = await step(run, "getVersion", () => getVersion(q));
    extra["version"] = version;
    await step(run, "getServerInfo", () => getServerInfo(q));
    await step(run, "getHostInfo", () => getHostInfo(q));
    const instance = await step(run, "getInstanceInfo", () => getInstanceInfo(q));
    await step(run, "listBindings", () => listBindings(q));
    await step(run, "getConnectionInfo", () => getConnectionInfo(q));
    await step(
      run,
      "getServerIDByPort",
      () => getServerIDByPort(q, 9987),
      "the virtual server's own port, 9987 inside the container",
    );
    const groups = (await step(run, "listServerGroups", () => listServerGroups(q))) ?? [];
    await step(run, "listPermissions", () => listPermissions(q));
    await step(run, "getPermissionIDByName", () =>
      getPermissionIDByName(q, "i_channel_join_power"),
    );
    const info = await getServerInfo(q);
    await step(
      run,
      "editServer",
      () =>
        editServer(q, { virtualserver_welcomemessage: info["virtualserver_welcomemessage"] ?? "" }),
      "no-op: the welcome message set to its current value",
    );
    const floodKey = "serverinstance_serverquery_flood_commands";
    if (instance?.[floodKey] !== undefined) {
      await step(
        run,
        "editInstance",
        () => editInstance(q, { [floodKey]: instance[floodKey] ?? "" }),
        "no-op: the query flood limit set to its current value",
      );
    } else {
      run.steps.push({
        fn: "editInstance",
        calls: [],
        note: `skipped: instanceinfo has no ${floodKey}`,
      });
    }

    const adminGroup = groups.find(
      (g) => g.name === "Server Admin" && g.type === GroupType.Regular,
    );

    // Channels.
    const channels = (await step(run, "listChannels", () => listChannels(q))) ?? [];
    const alpha = channels.find((c) => c.name === "Alpha")?.id ?? asChannelID(0);
    const pq = await step(run, "createChannel", () =>
      createChannel(q, { name: `pq${tag}`, topic: "probe", isPermanent: true }),
    );
    if (pq === undefined) throw new Error("the probe cannot go on without a channel");
    later("delete channel", () => deleteChannel(q, pq, { force: true }));
    await step(run, "getChannelInfo", () => getChannelInfo(q, pq));
    await step(run, "editChannel", () =>
      editChannel(q, pq, { topic: "probe 2", description: "d" }),
    );
    await step(run, "findChannels", () => findChannels(q, `pq${tag}`));
    await step(run, "findChannels (no match)", () => findChannels(q, `no-such-channel-${tag}`));
    const sub = await step(run, "createChannel (sub)", () =>
      createChannel(q, { name: `ps${tag}`, parentID: pq, isPermanent: true }),
    );
    if (sub !== undefined) {
      // moveChannel puts it at the top level, where deleting pq would not reach it.
      later("delete sub channel", () => deleteChannel(q, sub, { force: true }));
      await step(run, "moveChannel", () => moveChannel(q, sub, asChannelID(0), { order: pq }));
    }
    await step(run, "addChannelPermission", () =>
      addChannelPermission(q, pq, permissionByName(PermissionName.ChannelJoinPower), 5),
    );
    await step(run, "listChannelPermissions", () => listChannelPermissions(q, pq));
    await step(run, "deleteChannelPermission", () =>
      deleteChannelPermission(q, pq, permissionByName(PermissionName.ChannelJoinPower)),
    );
    await step(run, "listChannelPermissions (none)", () => listChannelPermissions(q, pq));

    // Voice clients to act on.
    const vc1 = await voice(target, `pa-${tag}`);
    const vc2 = await voice(target, `pb-${tag}`);
    voices.push(vc1, vc2);
    const vc2uid = vc2.uid;
    if (adminGroup) {
      const token = await addPrivilegeKey(q, { serverGroupID: adminGroup.id });
      await usePrivilegeKey(vc1, token).catch((e) => console.log(`vc1 key: ${String(e)}`));
      await deletePrivilegeKey(q, token).catch(() => {});
    }
    await sleep(500);

    await step(run, "listClients", () =>
      listClients(q, { groups: true, times: true, voice: true, away: true, info: true }),
    );
    await step(run, "getClientProperties", () => getClientProperties(q, vc2.clientID));
    await step(run, "findClients", () => findClients(q, `pb-${tag}`));
    await step(run, "findClients (no match)", () => findClients(q, `no-such-client-${tag}`));
    await step(run, "getClientIDs", () => getClientIDs(q, vc2uid));
    await step(run, "getClientIDs (unknown uid)", () =>
      getClientIDs(q, asUID("AAAAAAAAAAAAAAAAAAAAAAAAAAA=")),
    );
    await step(run, "getClientUIDByID", () => getClientUIDByID(q, vc2.clientID));
    const vc2db =
      (await step(run, "getClientDBIDByUID", () => getClientDBIDByUID(q, vc2uid))) ??
      asClientDBID(0);
    await step(run, "getClientNameByDBID", () => getClientNameByDBID(q, vc2db));
    await step(run, "getClientNameByUID", () => getClientNameByUID(q, vc2uid));
    await step(run, "getClientDatabaseInfo", () => getClientDatabaseInfo(q, vc2db));
    await step(run, "editClientDatabase", () =>
      editClientDatabase(q, vc2db, { description: "probe" }),
    );
    await step(run, "findClientDatabase", () => findClientDatabase(q, `pb-${tag}`));
    await step(run, "findClientDatabase (no match)", () =>
      findClientDatabase(q, `no-such-client-${tag}`),
    );
    await step(run, "listClientDatabase", () => listClientDatabase(q, { start: 0, limit: 5 }));
    await step(run, "moveClient", () => moveClient(q, vc2.clientID, pq));
    await step(run, "editClient", () => editClient(q, vc2.clientID, { description: "probe" }));
    await step(
      run,
      "updateClient",
      () => updateClient(q, { nickname: `pqn-${tag}` }),
      "the query client's own nickname, renamed",
    );
    await step(run, "pokeClient", () => pokeClient(q, vc2.clientID, "probe poke"));
    await step(run, "sendPrivateMessage", () =>
      sendPrivateMessage(q, vc2.clientID, "probe private"),
    );
    await step(run, "sendChannelMessage", () => sendChannelMessage(q, "probe channel"));
    await step(run, "sendServerMessage", () => sendServerMessage(q, "probe server"));

    await step(run, "listClientPermissions", () => listClientPermissions(q, vc2db));
    await step(run, "addClientPermission", () =>
      addClientPermission(q, vc2db, permissionByName(PermissionName.ChannelJoinPower), 3, {
        skip: true,
      }),
    );
    await step(run, "listClientPermissions (some)", () => listClientPermissions(q, vc2db));
    await step(run, "deleteClientPermission", () =>
      deleteClientPermission(q, vc2db, permissionByName(PermissionName.ChannelJoinPower)),
    );
    await step(run, "listChannelClientPermissions", () =>
      listChannelClientPermissions(q, pq, vc2db),
    );
    await step(run, "addChannelClientPermission", () =>
      addChannelClientPermission(
        q,
        pq,
        vc2db,
        permissionByName(PermissionName.ChannelJoinPower),
        3,
      ),
    );
    await step(run, "listChannelClientPermissions (some)", () =>
      listChannelClientPermissions(q, pq, vc2db),
    );
    await step(run, "getPermissionOverview", () => getPermissionOverview(q, pq, vc2db));
    await step(run, "findPermission", () =>
      findPermission(q, permissionByName(PermissionName.ChannelJoinPower)),
    );
    await step(run, "deleteChannelClientPermission", () =>
      deleteChannelClientPermission(
        q,
        pq,
        vc2db,
        permissionByName(PermissionName.ChannelJoinPower),
      ),
    );

    // Server groups.
    const sg = await step(run, "createServerGroup", () =>
      createServerGroup(q, `psg${tag}`, GroupType.Regular),
    );
    if (sg !== undefined) {
      later("delete server group", () => deleteServerGroup(q, sg, { force: true }));
      await step(run, "renameServerGroup", () => renameServerGroup(q, sg, `psg2${tag}`));
      const copy = await step(run, "copyServerGroup", () =>
        copyServerGroup(q, sg, asServerGroupID(0), `psc${tag}`, GroupType.Regular),
      );
      if (copy !== undefined)
        later("delete server group copy", () => deleteServerGroup(q, copy, { force: true }));
      await step(run, "addServerGroupPermission", () =>
        addServerGroupPermission(q, sg, permissionByName(PermissionName.ChannelJoinPower), 7, {
          skip: true,
        }),
      );
      await step(run, "listServerGroupPermissions", () => listServerGroupPermissions(q, sg));
      await step(run, "deleteServerGroupPermission", () =>
        deleteServerGroupPermission(q, sg, permissionByName(PermissionName.ChannelJoinPower)),
      );
      await step(run, "listServerGroupClients (none)", () => listServerGroupClients(q, sg));
      await step(run, "addClientToServerGroup", () => addClientToServerGroup(q, sg, vc2db));
      await step(run, "listServerGroupClients", () =>
        listServerGroupClients(q, sg, { names: true }),
      );
      await step(run, "getServerGroupsByClient", () => getServerGroupsByClient(q, vc2db));
      await step(run, "removeClientFromServerGroup", () =>
        removeClientFromServerGroup(q, sg, vc2db),
      );
      await step(run, "deleteServerGroup", () => deleteServerGroup(q, sg, { force: true }));
    }

    // Channel groups.
    const cg = await step(run, "createChannelGroup", () =>
      createChannelGroup(q, `pcg${tag}`, GroupType.Regular),
    );
    if (cg !== undefined) {
      later("delete channel group", () => deleteChannelGroup(q, cg, { force: true }));
      await step(run, "renameChannelGroup", () => renameChannelGroup(q, cg, `pcg2${tag}`));
      const copy = await step(run, "copyChannelGroup", () =>
        copyChannelGroup(q, cg, asChannelGroupID(0), `pcc${tag}`, GroupType.Regular),
      );
      if (copy !== undefined)
        later("delete channel group copy", () => deleteChannelGroup(q, copy, { force: true }));
      await step(run, "addChannelGroupPermission", () =>
        addChannelGroupPermission(q, cg, permissionByName(PermissionName.ChannelJoinPower), 4),
      );
      await step(run, "listChannelGroupPermissions", () => listChannelGroupPermissions(q, cg));
      await step(run, "deleteChannelGroupPermission", () =>
        deleteChannelGroupPermission(q, cg, permissionByName(PermissionName.ChannelJoinPower)),
      );
      await step(run, "listChannelGroupClients (none)", () =>
        listChannelGroupClients(q, { groupID: cg }),
      );
      await step(run, "setClientChannelGroup", () => setClientChannelGroup(q, cg, pq, vc2db));
      await step(run, "listChannelGroupClients", () => listChannelGroupClients(q, { groupID: cg }));
      await step(run, "deleteChannelGroup", () => deleteChannelGroup(q, cg, { force: true }));
    }
    await step(run, "listChannelGroups", () => listChannelGroups(q));

    // Moderation.
    await step(run, "listBans (none)", () => listBans(q));
    const ban = await step(run, "addBan", () =>
      addBan(q, { ip: "192.0.2.77", reason: "probe", durationMs: 60_000 }),
    );
    const banByUid = await step(run, "addBan (uid)", () =>
      addBan(q, {
        uid: asUID("AAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        reason: "probe",
        durationMs: 60_000,
      }),
    );
    const banByName = await step(run, "addBan (name)", () =>
      addBan(q, { name: `probe-${tag}`, durationMs: 60_000 }),
    );
    const bans = (await step(run, "listBans", () => listBans(q))) ?? [];
    await step(run, "deleteBan", async () => {
      if (ban !== undefined) await deleteBan(q, ban);
    });
    const mine = new Set([banByUid, banByName].filter((b) => b !== undefined).map(String));
    const others = (await listBans(q)).filter((b) => !mine.has(String(b.id)));
    if (others.length === 0)
      await step(
        run,
        "deleteAllBans",
        () => deleteAllBans(q),
        "ran: every ban on the server was the probe's own",
      );
    else
      run.steps.push({
        fn: "deleteAllBans",
        calls: [],
        note: `skipped: ${others.length} ban(s) the probe did not create`,
      });
    extra["bansListed"] = bans.length;
    // A ban of the voice client bans its address, which is the one every other helper
    // uses, so it is kept to two seconds and lifted at once.
    const banned = await step(run, "banClient", () =>
      banClient(q, vc2.clientID, { durationMs: 2000, reason: "probe" }),
    );
    for (const id of banned ?? []) await deleteBan(q, id).catch(() => {});
    for (const b of await listBans(q).catch(() => []))
      if (b.reason === "probe") await deleteBan(q, b.id).catch(() => {});
    await sleep(500);

    // complainadd needs a connected target, and vc2 is gone after banClient.
    const vc1db = await getClientDBIDByUID(q, vc1.uid).catch(() => asClientDBID(0));
    await step(run, "listComplaints (none)", () => listComplaints(q));
    await step(run, "addComplaint", () => addComplaint(q, vc1db, "probe complaint"));
    await step(run, "listComplaints", () => listComplaints(q, { targetDatabaseID: vc1db }));
    await step(run, "deleteComplaint", () => deleteComplaint(q, vc1db, me.databaseID));
    await addComplaint(q, vc1db, "probe complaint 2").catch(() => {});
    await step(
      run,
      "deleteAllComplaints",
      () => deleteAllComplaints(q, vc1db),
      "on the probe's own client",
    );

    await step(run, "listMessages (none)", () => listMessages(q));
    // The list is the query account's own inbox, so a voice client writes to it.
    const queryUID = me.uid;
    extra["messageadd"] = await vc1
      .exec(`messageadd cluid=${queryUID} subject=probe message=probe\\sbody`)
      .then(
        (rows) => `answered with ${rows.length} rows`,
        (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
      );
    await sleep(300);
    const messages = (await step(run, "listMessages", () => listMessages(q))) ?? [];
    const msg = messages[0];
    if (msg) {
      await step(run, "getMessage", () => getMessage(q, msg.id));
      await step(run, "updateMessageFlag", () => updateMessageFlag(q, msg.id, { read: true }));
      await step(run, "deleteMessage", () => deleteMessage(q, msg.id));
    } else {
      for (const fn of ["getMessage", "updateMessageFlag", "deleteMessage"])
        run.steps.push({
          fn,
          calls: [],
          note: "skipped: no offline message reaches the query account (messageadd from a voice client to its uid answers 512; from the query client it answers ok and the list stays empty)",
        });
    }
    await step(run, "viewLog", () => viewLog(q, { lines: 3 }));
    await step(run, "addLog", () => addLog(q, 4, `probe ${tag}`));

    // Keys and temporary passwords.
    await step(run, "listPrivilegeKeys (none)", () => listPrivilegeKeys(q));
    if (sg !== undefined) {
      const sg2 = await createServerGroup(q, `pkg${tag}`, GroupType.Regular).catch(() => undefined);
      if (sg2 !== undefined) {
        later("delete key group", () => deleteServerGroup(q, sg2, { force: true }));
        const token = await step(run, "addPrivilegeKey", () =>
          addPrivilegeKey(q, { serverGroupID: sg2, description: "probe" }),
        );
        await step(run, "listPrivilegeKeys", () => listPrivilegeKeys(q));
        if (token) {
          await step(
            run,
            "usePrivilegeKey",
            () => usePrivilegeKey(q, token),
            "by the query client itself",
          );
          const spare = await addPrivilegeKey(q, { serverGroupID: sg2 });
          extra["usePrivilegeKey by a voice client"] = await usePrivilegeKey(vc1, spare).then(
            () => "accepted",
            (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
          );
          await deletePrivilegeKey(q, spare).catch(() => {});
          await removeClientFromServerGroup(q, sg2, await getClientDBIDByUID(q, vc1.uid)).catch(
            () => {},
          );
          await step(run, "deletePrivilegeKey", () => deletePrivilegeKey(q, token));
        }
      }
    }
    const cg2 = await createChannelGroup(q, `pkc${tag}`, GroupType.Regular).catch(() => undefined);
    if (cg2 !== undefined) {
      later("delete key channel group", () => deleteChannelGroup(q, cg2, { force: true }));
      const token = await step(run, "addPrivilegeKey (channel group)", () =>
        addPrivilegeKey(q, { channelGroupID: cg2, channelID: pq }),
      );
      if (token) await deletePrivilegeKey(q, token).catch(() => {});
    }

    await step(run, "listTempPasswords (none)", () => listTempPasswords(q));
    await step(run, "addTempPassword", () =>
      addTempPassword(q, { password: `tp-${tag}`, description: "probe", durationMs: 60_000 }),
    );
    await step(run, "listTempPasswords", () => listTempPasswords(q));
    await step(run, "deleteTempPassword", () => deleteTempPassword(q, `tp-${tag}`));

    // Files.
    await fileTransfers(run, pq, target, extra);

    await step(run, "listActiveTransfers", () => listActiveTransfers(q));
    // TeamSpeak 6.0.0-beta13.1 crashes on ftstop for a transfer id that does not
    // exist (measured over SSH, twice), where TS3 answers a status row. So it is
    // only sent where the server survives it.
    if (target.kind === "raw") {
      await step(
        run,
        "stopFileTransfer",
        () => stopFileTransfer(q, asServerFileTransferID(65000)),
        "a transfer that does not exist",
      );
    } else {
      run.steps.push({
        fn: "stopFileTransfer",
        calls: [],
        note: "skipped: ftstop for an unknown transfer id crashes TS6 over SSH",
      });
    }
    run.steps.push({
      fn: "resetPermissions",
      calls: [],
      note: "skipped: resets every permission on the server",
    });

    // A client the probe made, gone from the server, then from the database.
    const gone = await voice(target, `pd-${tag}`);
    const goneDB = await getClientDBIDByUID(q, gone.uid).catch(() => asClientDBID(0));
    await gone.disconnect().catch(() => {});
    await sleep(500);
    await step(
      run,
      "deleteClientDatabase",
      () => deleteClientDatabase(q, goneDB),
      "the entry of a voice client the probe created",
    );

    await paging(run, extra);
    await passwords(run, target, pq, extra);
    await events(run, target, me.clientID, alpha, pq, vc1, vc2, extra);
  } finally {
    for (const v of voices) await v.disconnect().catch(() => {});
    for (const [what, fn] of cleanups.splice(0).toReversed()) {
      await fn()
        .catch(() => sleep(1000).then(fn))
        .catch((e: unknown) => {
          // Already deleted by the probe's own step.
          if (!(e instanceof ServerError && (e.code === 2560 || e.code === 768)))
            console.log(`cleanup ${what}: ${String(e)}`);
        });
    }
    await q.client.close().catch(() => {});
  }
  return { steps: run.steps, extra };
}

// ---- File transfers ---------------------------------------------------------

/** Run a raw command and note the answer rows and the notifications that arrive around it. */
async function rawWithNotifications(q: Recorder, line: string) {
  const seen: NotificationEvent[] = [];
  const stop = q.client.onNotification((event) => seen.push(event));
  let rows: Array<Record<string, string>> = [];
  let error: string | undefined;
  try {
    rows = await q.client.exec(line);
  } catch (e) {
    error = e instanceof ServerError ? `${e.code} ${e.message}` : String(e);
  }
  await sleep(700);
  stop();
  return {
    rowKeys: [...new Set(rows.flatMap((row) => Object.keys(row)))],
    error,
    notifications: seen.map((n) => ({ name: n.name, keys: Object.keys(n.params) })),
  };
}

async function fileTransfers(
  run: Run,
  cid: ChannelID,
  target: Target,
  extra: Record<string, unknown>,
) {
  const { q } = run;
  const name = `/pq${tag}.txt`;
  // How the negotiation answers: inline, or by a notification.
  extra["ftinitupload raw"] = await rawWithNotifications(
    q,
    `ftinitupload clientftfid=901 name=\\/raw${tag}.txt cid=${cid} cpw= size=5 overwrite=1 resume=0`,
  );
  extra["ftinitdownload raw (missing file)"] = await rawWithNotifications(
    q,
    `ftinitdownload clientftfid=902 name=\\/missing${tag}.txt cid=${cid} cpw= seekpos=0`,
  );
  extra["ftinitupload raw (same name again)"] = await rawWithNotifications(
    q,
    `ftinitupload clientftfid=903 name=\\/raw${tag}.txt cid=${cid} cpw= size=5 overwrite=1 resume=0`,
  );
  for (const row of await q.client.exec("ftlist").catch(() => [])) {
    if (row["serverftfid"])
      await q.client.exec(`ftstop serverftfid=${row["serverftfid"]} delete=1`).catch(() => {});
  }
  await q.client.exec(`ftdeletefile cid=${cid} cpw= name=\\/raw${tag}.txt`).catch(() => {});
  await step(run, "listFiles", () => listFiles(q, cid, "/"));
  await step(run, "createDirectory", () => createDirectory(q, cid, `/pqdir${tag}`));
  await step(run, "listFiles (after mkdir)", () => listFiles(q, cid, "/"));
  const up = await step(run, "initFileUpload", () =>
    initFileUpload(q, cid, name, 5n, { overwrite: true }),
  );
  if (up) {
    await step(run, "uploadFileData", () =>
      uploadFileData(target.host, up, Readable.from([Buffer.from("probe")])),
    );
  }
  await step(run, "getFileInfo", () => getFileInfo(q, cid, name));
  const down = await step(run, "initFileDownload", () => initFileDownload(q, cid, name));
  if (down) {
    const chunks: Buffer[] = [];
    await step(run, "downloadFileData", async () => {
      await downloadFileData(
        target.host,
        down,
        new Writable({
          write(chunk: Buffer, _enc, done) {
            chunks.push(chunk);
            done();
          },
        }),
      );
      return Buffer.concat(chunks).toString();
    });
  }
  await step(run, "renameFile", () => renameFile(q, cid, name, `/pq${tag}.2.txt`));
  await step(run, "deleteFile", () => deleteFile(q, cid, [`/pq${tag}.2.txt`, `/pqdir${tag}`]));
}

// ---- Paging -----------------------------------------------------------------

async function paging(run: Run, extra: Record<string, unknown>) {
  const { q } = run;
  const walk = async (pageSize: number) => {
    const ids: bigint[] = [];
    for await (const entry of iterateClientDatabase(q, { pageSize })) ids.push(entry.databaseID);
    return ids;
  };
  const before = q.calls.length;
  const byHundred =
    (await step(
      run,
      "iterateClientDatabase (pageSize 100)",
      async () => (await walk(100)).length,
    )) ?? 0;
  const calls100 = q.calls.slice(before).filter((c) => c.command === "clientdblist");
  const mark = q.calls.length;
  const byThousand =
    (await step(
      run,
      "iterateClientDatabase (pageSize 1000)",
      async () => (await walk(1000)).length,
    )) ?? 0;
  const calls1000 = q.calls.slice(mark).filter((c) => c.command === "clientdblist");
  const ids = await walk(100);
  const paged: Record<string, unknown> = {
    walkedByHundred: byHundred,
    walkedByThousand: byThousand,
    ordered: ids.every((id, i) => i === 0 || id > (ids[i - 1] ?? 0n)),
    unique: new Set(ids.map(String)).size === ids.length,
    "calls with pageSize 100": calls100
      .map((c) => (c.outcome === "error" ? `error ${c.errorId}` : `${c.outcome}(${c.rows})`))
      .slice(-4),
    "calls with pageSize 1000": calls1000.map((c) =>
      c.outcome === "error" ? `error ${c.errorId}` : `${c.outcome}(${c.rows})`,
    ),
    "calls with pageSize 100, count": calls100.length,
  };
  for (const line of [
    "clientdblist start=0 duration=1000",
    "clientdblist start=100000 duration=5",
    "clientdblist",
    "clientdblist start=0 duration=0",
  ]) {
    paged[line] = await q.client.exec(line).then(
      (rows) => `rows(${rows.length})`,
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
  }
  extra["paging"] = paged;
}

// ---- Passwords --------------------------------------------------------------

async function passwords(run: Run, target: Target, pq: ChannelID, extra: Record<string, unknown>) {
  const { q } = run;
  const out: Record<string, unknown> = {};
  extra["passwords"] = out;
  const password = `pw ${tag}$|x`;
  const room = await createChannel(q, { name: `pw${tag}`, password, isPermanent: true }).catch(
    (e) => {
      out["createChannel"] = String(e);
      return undefined;
    },
  );
  if (room === undefined) return;
  later("delete password channel", () => deleteChannel(q, room, { force: true }));
  out["hasPassword"] = (await getChannelInfo(q, room)).hasPassword;

  const joiner = await voice(target, `pj-${tag}`);
  try {
    const joined = (): Promise<string> =>
      getClientProperties(q, joiner.clientID).then(
        (row) => row["cid"] ?? row["client_channel_id"] ?? "?",
      );
    out["channel: wrong password"] = await moveClient(joiner, joiner.clientID, room, {
      password: "wrong",
    }).then(
      () => "joined",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    out["channel: no password"] = await moveClient(joiner, joiner.clientID, room).then(
      () => "joined",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    out["channel: right password"] = await moveClient(joiner, joiner.clientID, room, {
      password,
    }).then(
      async () => `joined, in channel ${await joined()} (room is ${room})`,
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    // Editing the password over ServerQuery, then joining with the new one.
    await editChannel(q, room, { password: "second" });
    await moveClient(joiner, joiner.clientID, pq).catch(() => {});
    out["channel: new password after editChannel"] = await moveClient(
      joiner,
      joiner.clientID,
      room,
      {
        password: "second",
      },
    ).then(
      () => "joined",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    await editChannel(q, room, { password: "" });
    out["hasPassword after clearing"] = (await getChannelInfo(q, room)).hasPassword;
  } finally {
    await joiner.disconnect().catch(() => {});
  }

  // A temporary server password: the server gets a password, and a client that
  // knows only the temporary one connects with it.
  const temp = `tp${tag}`;
  const serverPassword = `sp${tag}`;
  const before = (await getServerInfo(q))["virtualserver_flag_password"];
  out["server password flag before"] = before;
  try {
    await addTempPassword(q, {
      password: temp,
      description: "probe",
      durationMs: 120_000,
      targetChannelID: pq,
    });
    await editServer(q, { virtualserver_password: serverPassword });
    const flag = (await getServerInfo(q))["virtualserver_flag_password"];
    out["server password flag set"] = flag;
    const attempt = async (pw: string | undefined) => {
      const c = new Client(generateIdentitySync(8), target.voice, `pt-${tag}`, {
        logger: quiet,
        ...(pw === undefined ? {} : { serverPassword: pw }),
      });
      try {
        await c.connect({ signal: AbortSignal.timeout(8000) });
        await sleep(300);
        const seenIn = (await listClients(q)).find(
          (entry) => entry.nickname === `pt-${tag}`,
        )?.channelID;
        await c.disconnect().catch(() => {});
        return `connected, in channel ${seenIn}`;
      } catch (e) {
        await c.disconnect().catch(() => {});
        return e instanceof ServerError
          ? `error ${e.code} ${e.message}`
          : `${(e as Error).constructor.name}: ${(e as Error).message}`;
      }
    };
    out["server: no password"] = await attempt(undefined);
    out["server: server password"] = await attempt(serverPassword);
    out["server: temporary password"] = await attempt(temp);
    out["target channel of the temporary password"] = String(pq);
    const listed = await listTempPasswords(q);
    out["listTempPasswords has cleartext"] = listed.some((t) => t.password === temp);
  } finally {
    await editServer(q, { virtualserver_password: "" }).catch((e) =>
      console.log(`restore password: ${String(e)}`),
    );
    await deleteTempPassword(q, temp).catch(() => {});
    out["server password flag after"] = (await getServerInfo(q))["virtualserver_flag_password"];
  }
}

// ---- Events -----------------------------------------------------------------

const EVENT_FIELDS = {
  textMessage: [
    "invokerName",
    "invokerUID",
    "message",
    "invokerGroups",
    "targetMode",
    "targetID",
    "invokerID",
  ],
  clientMoved: ["invokerName", "invokerUID", "targetChannelID", "reason", "clientID", "invokerID"],
  clientLeave: ["reasonMessage", "reason", "clientID", "invokerName", "invokerUID", "invokerID"],
  kicked: ["reasonMessage", "reason", "invokerName", "invokerUID", "invokerID"],
  clientEnter: [
    "id",
    "nickname",
    "uid",
    "channelID",
    "type",
    "serverGroups",
    "isAway",
    "isRecording",
    "isTalker",
    "channelGroupID",
    "createdAt",
    "lastConnectedAt",
    "idleTimeMs",
  ],
  poked: ["invokerName", "invokerUID", "invokerID", "message"],
} as const;

async function events(
  run: Run,
  target: Target,
  selfClid: number,
  alpha: ChannelID,
  pq: ChannelID,
  vc1: Client,
  vc2: Client,
  extra: Record<string, unknown>,
) {
  const { q } = run;
  const out: Record<string, unknown> = {};
  extra["events"] = out;
  // banClient above dropped the earlier helper; events need live clients.
  vc2 = await voice(target, `pb2-${tag}`);
  await sleep(500);
  if (target.kind === "web") {
    // WebQuery has no servernotifyregister.
    out["servernotifyregister"] = await q.client.registerNotifications("server").then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    return;
  }
  const seen: NotificationEvent[] = [];
  const stop = q.client.onNotification((event) => seen.push(event));
  const registered: Record<string, string> = {};
  for (const [event, id] of [
    ["server"],
    ["channel", 0],
    ["textserver"],
    ["textchannel"],
    ["textprivate"],
    ["bans"],
  ] as const) {
    registered[event] = await q.client.registerNotifications(event, id).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
  }
  out["register"] = registered;

  const me = await whoAmI(q);
  const mark = (label: string) => {
    const at = seen.length;
    return async () => {
      await sleep(800);
      return { label, from: at, to: seen.length };
    };
  };
  const windows: Array<{ label: string; from: number; to: number }> = [];
  const trigger = async (label: string, action: () => Promise<unknown>) => {
    const done = mark(label);
    await action().catch((e: unknown) => console.log(`${label}: ${String(e)}`));
    windows.push(await done());
  };

  await trigger("query moves itself into a channel", () => moveClient(q, me.clientID, pq));
  await trigger("voice client moves itself into it", () => moveClient(vc1, vc1.clientID, pq));
  await trigger("query moves a voice client", () => moveClient(q, vc2.clientID, pq));
  await trigger("voice client text to channel", () =>
    sendChannelMessage(vc1, "event channel ü & |"),
  );
  await trigger("voice client text to query", () =>
    sendPrivateMessage(vc1, me.clientID, "event private"),
  );
  await trigger("voice client text to server", () => sendServerMessage(vc1, "event server"));
  await trigger("voice client pokes query", () => pokeClient(vc1, me.clientID, "event poke"));
  await trigger("voice client moves itself away", () => moveClient(vc1, vc1.clientID, alpha));
  await trigger("query kicks from channel", () =>
    kickClient(q, vc2.clientID, 4, { reasonMessage: "probe kick" }),
  );
  const vc3 = await voice(target, `pe-${tag}`);
  await trigger("voice client enters (announced)", async () => {
    await sleep(100);
  });
  await sleep(800);
  windows.push({ label: "voice client connected", from: 0, to: seen.length });
  await trigger("voice client leaves", () => vc3.disconnect());
  const vc4 = await voice(target, `pk-${tag}`);
  await sleep(500);
  await trigger("query kicks from server", () =>
    kickClient(q, vc4.clientID, 5, { reasonMessage: "probe kick server" }),
  );
  await vc4.disconnect().catch(() => {});

  // Being kicked: a second query client, kicked by the voice client.
  const kq = new Recorder(new Tap(await target.open()), target.kind);
  const kicks: NotificationEvent[] = [];
  let kqClosed: string | undefined;
  try {
    if (target.kind === "raw")
      await kq.client.login(
        "serveradmin",
        process.env["TS3_ADMIN_PW"] ?? logged("ts3", "password"),
      );
    await kq.client.use({ id: 1 }, { nickname: `pq2-${tag}` });
    await kq.client.registerNotifications("server");
    await kq.client.registerNotifications("channel", 0);
    kq.client.onNotification((n) => kicks.push(n));
    const kqMe = await whoAmI(kq);
    await moveClient(kq, kqMe.clientID, pq);
    await sleep(300);
    await kq.client.registerNotifications("textprivate").catch(() => {});
    out["private text to a query client"] = await sendPrivateMessage(
      q,
      asClientID(kqMe.clientID),
      "to query",
    ).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    out["poke of a query client by a query client"] = await pokeClient(
      q,
      asClientID(kqMe.clientID),
      "poke query",
    ).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    await sleep(500);
    out["kick of a query client by a query client"] = await kickClient(
      q,
      asClientID(kqMe.clientID),
      4,
      { reasonMessage: "probe kicked" },
    ).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    await sleep(500);
    out["kick of a query client by a voice client"] = await kickClient(
      vc1,
      asClientID(kqMe.clientID),
      5,
      { reasonMessage: "probe kicked" },
    ).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    await sleep(500);
    out["kick of a query client from the server by a query client"] = await kickClient(
      q,
      asClientID(kqMe.clientID),
      5,
      { reasonMessage: "probe kicked from server" },
    ).then(
      () => "accepted",
      (e: unknown) => (e instanceof ServerError ? `error ${e.code} ${e.message}` : String(e)),
    );
    await sleep(1000);
    kqClosed = await kq.client.exec("whoami").then(
      () => "still connected",
      (e: unknown) => (e instanceof Error ? e.constructor.name : String(e)),
    );
  } finally {
    await kq.client.close().catch(() => {});
  }
  out["kicked query client received"] = kicks.map((n) => ({ name: n.name, params: n.params }));
  out["kicked query client afterwards"] = kqClosed;
  stop();

  // What arrived, by notification.
  const byName: Record<string, { count: number; keys: string[]; batched: number }> = {};
  for (const n of seen) {
    const entry = (byName[n.name] ??= { count: 0, keys: [], batched: 0 });
    entry.count++;
    for (const key of Object.keys(n.params)) if (!entry.keys.includes(key)) entry.keys.push(key);
  }
  out["notifications"] = byName;
  out["batched lines"] = q.tap.lines.filter(
    (l) => l.startsWith("notify") && l.includes("|"),
  ).length;
  out["notification raw lines"] = q.tap.lines.filter((l) => l.startsWith("notify")).slice(0, 40);

  // Fill the core's event payloads from the notifications, the way the voice
  // client does, and see which fields the notification could not supply.
  const clients = new Map<number, ClientEnterEvent>();
  const filled: Record<
    string,
    { fields: readonly string[]; lookedForInVain: string[]; sample: unknown; seen: number }
  > = {};
  for (const n of seen) {
    const missing = new Set<string>();
    const params = new Proxy(n.params, {
      get(t, key) {
        if (typeof key === "string" && !(key in t)) missing.add(key);
        return t[key as string];
      },
    });
    const result = handleNotification({ name: n.name, params }, selfClidOf(me.clientID), clients);
    const kind =
      result.kind === "clientEnter"
        ? "clientEnter"
        : result.kind === "clientLeave"
          ? "clientLeave"
          : result.kind === "clientMoved"
            ? "clientMoved"
            : result.kind === "textMessage"
              ? "textMessage"
              : result.kind === "poked"
                ? "poked"
                : undefined;
    if (!kind) continue;
    const payload =
      result.kind === "clientEnter"
        ? result.info
        : result.kind === "clientLeave"
          ? result.event
          : result.kind === "clientMoved"
            ? result.event
            : result.kind === "textMessage"
              ? result.message
              : result.kind === "poked"
                ? result.event
                : undefined;
    const entry = (filled[kind] ??= {
      fields: EVENT_FIELDS[kind],
      lookedForInVain: [],
      sample: payload,
      seen: 0,
    });
    entry.seen++;
    for (const key of missing)
      if (!entry.lookedForInVain.includes(key)) entry.lookedForInVain.push(key);
  }
  out["filled"] = filled;
  out["windows"] = windows.map((w) => ({
    trigger: w.label,
    notifications:
      w.label === "voice client connected"
        ? undefined
        : seen.slice(w.from, w.to).map((n) => ({ name: n.name, params: n.params })),
  }));
}

const selfClidOf = (id: number): number => id;

// ---- Main -------------------------------------------------------------------

const wanted = (process.env["TARGETS"] ?? "ts3,ts6,ts6ssh").split(",");
const all: Record<string, Findings | { error: string }> = {};
for (const target of targets.filter((t) => wanted.includes(t.name))) {
  console.log(`\n=== ${target.label} ===`);
  try {
    all[target.name] = await probe(target);
  } catch (error) {
    console.log(`probe of ${target.name} stopped: ${String(error)}`);
    all[target.name] = { error: String(error) };
  }
  // Two minutes apart is the flood protection's advice; the fixture relaxed it, so a pause is enough.
  await sleep(3000);
}

console.log("\n=== Summary ===");
for (const [name, findings] of Object.entries(all)) {
  if ("error" in findings) {
    console.log(`${name}: stopped, ${findings.error}`);
    continue;
  }
  const calls = findings.steps.flatMap((s) => s.calls);
  const count = (outcome: Call["outcome"]) => calls.filter((c) => c.outcome === outcome).length;
  const silent = findings.steps.filter((s) => s.calls.some((c) => c.missing.length > 0));
  console.log(
    `${name}: ${findings.steps.length} steps, ${calls.length} commands sent: ` +
      `rows ${count("rows")}, ok ${count("ok")}, error ${count("error")}, no answer ${count("timeout")}, transport ${count("transport")}; ` +
      `steps with a field the parser looked for and did not find: ${silent.length}; ` +
      `rows that would differ if completed from the row before: ${calls.reduce((n, c) => n + c.inheritDiffs, 0)}`,
  );
}

if (process.env["OUT"]) writeFileSync(process.env["OUT"], JSON.stringify(all, replacer, 2));
process.exit(0);
