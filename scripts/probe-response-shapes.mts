/**
 * How does the server answer each query over the voice protocol?
 *
 * ServerQuery answers a query with nameless data rows followed by `error`. The
 * voice protocol often does not: it answers `servergrouplist` with a
 * `notifyservergrouplist` command, `clientgetuidfromclid` with
 * `notifyclientuidfromclid`, and so on — a named notification, not a data row.
 * A client that only collects nameless rows sees an empty success for those
 * commands, which is exactly the mistake this probe exists to rule out.
 *
 * For each query the SDK sends, this records what arrives between sending it
 * and the `error` carrying its return_code, and what arrives shortly after.
 * Notifications do not carry a return_code, so the response a command declares
 * is the only way to attribute one — and this is the measurement those
 * declarations are checked against.
 *
 * Needs Server Admin so permissions do not mask the shape:
 *
 *   PRIVILEGE_KEY=... ADDR=127.0.0.1:9987 pnpm tsx scripts/probe-response-shapes.mts
 *
 * Create the key over ServerQuery with
 * `privilegekeyadd tokentype=0 tokenid1=<server admin sgid> tokenid2=0`.
 */
import { Readable } from "node:stream";
import { initFileUpload } from "../src/core/api/files.js";
import { Client, clientInternals } from "../src/client/client.js";
import { CommandTimeoutError, ServerError } from "../src/core/index.js";
import { asChannelID } from "../src/core/command/ids.js";
import { escape } from "../src/core/command/command.js";
import { parseCommand } from "../src/core/command/parser.js";
import { generateIdentitySync } from "../src/client/crypto/identity.js";
import { packetType, PacketType } from "../src/client/transport/packet.js";

const addr = process.env["ADDR"] ?? "127.0.0.1:9987";
const privilegeKey = process.env["PRIVILEGE_KEY"] ?? "";
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Arrival {
  at: number;
  /** Command name, or "" for a nameless data row. */
  name: string;
  params: Record<string, string>;
}

const timeline: Arrival[] = [];

async function connect(nickname: string): Promise<Client> {
  const client = new Client(generateIdentitySync(8), addr, nickname, {
    defaultChannel: process.env["CHANNEL"] ?? "Alpha",
    logger: quiet,
  });
  await client.connect();
  await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  return client;
}

const me = await connect("shape-probe");
const victim = await connect("shape-victim");

// Record every command line the probe client receives, before the client
// itself interprets it. Splitting batches here mirrors what the client does.
const handler = clientInternals(me).handler;
const deliver = handler.onPacket;
handler.onPacket = (p) => {
  const type = packetType(p);
  if (type === PacketType.Command || type === PacketType.CommandLow) {
    for (const line of new TextDecoder().decode(p.data).split("\n")) {
      for (const row of line.split("|")) {
        const cmd = parseCommand(row.trim());
        if (cmd) timeline.push({ at: Date.now(), name: cmd.name, params: cmd.params });
      }
    }
  }
  deliver?.(p);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

if (privilegeKey !== "") {
  await me.exec(`privilegekeyuse token=${privilegeKey}`, { timeoutMs: 5000 });
  await sleep(500);
}

/** Raw rows the client returned, and the shape the wire actually had. */
interface Shape {
  error: string;
  returnedRows: number;
  before: Map<string, number>;
  after: Map<string, number>;
  firstRow: Record<string, string> | undefined;
}

async function measure(cmd: string): Promise<Shape> {
  const start = timeline.length;
  let returnedRows = 0;
  let error = "0";
  try {
    returnedRows = (await me.exec(cmd, { timeoutMs: 5000 })).length;
  } catch (e) {
    error =
      e instanceof ServerError
        ? String(e.code)
        : e instanceof CommandTimeoutError
          ? "timeout"
          : e instanceof Error
            ? e.message
            : String(e);
  }
  await sleep(800);

  const seen = timeline.slice(start);
  const end = seen.findIndex((a) => a.name === "error" && a.params["return_code"] !== undefined);
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  let firstRow: Record<string, string> | undefined;
  seen.forEach((a, i) => {
    if (a.name === "error") return;
    const bucket = end === -1 || i < end ? before : after;
    const key = a.name === "" ? "(row)" : a.name;
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    if (firstRow === undefined && bucket === before) firstRow = a.params;
  });
  return { error, returnedRows, before, after, firstRow };
}

// Facts later arguments depend on, read through queries already known to work.
const myClid = me.clientID;
const [self] = await me.exec(`clientinfo clid=${myClid}`, { timeoutMs: 5000 });
const myDbid = self?.["client_database_id"] ?? "1";
const myUid = self?.["client_unique_identifier"] ?? "";
const [victimInfo] = await me.exec(`clientinfo clid=${victim.clientID}`, { timeoutMs: 5000 });
const victimDbid = victimInfo?.["client_database_id"] ?? "1";
const [server] = await me.exec("serverinfo", { timeoutMs: 5000 });
const defaultSgid = server?.["virtualserver_default_server_group"] ?? "8";
const defaultCgid = server?.["virtualserver_default_channel_group"] ?? "8";
const tag = Date.now().toString(36);
const uid = escape(myUid);

// Give the list commands something to list.
await me
  .exec(`channeladdperm cid=1 permsid=i_channel_needed_join_power permvalue=0`, { timeoutMs: 5000 })
  .catch(() => {});
await me
  .exec(`channelclientaddperm cid=1 cldbid=${myDbid} permsid=i_channel_join_power permvalue=1`, {
    timeoutMs: 5000,
  })
  .catch(() => {});
await me
  .exec(`clientaddperm cldbid=${myDbid} permsid=i_client_talk_power permvalue=1 permskip=0`, {
    timeoutMs: 5000,
  })
  .catch(() => {});
await me
  .exec(`complainadd tcldbid=${victimDbid} message=probe`, { timeoutMs: 5000 })
  .catch(() => {});
await me.exec(`ftcreatedir cid=1 cpw= dirname=\\/probe${tag}`, { timeoutMs: 5000 }).catch(() => {});

/** Rows of one named response, read off the wire while the client cannot. */
async function rowsOf(cmd: string, response: string): Promise<Array<Record<string, string>>> {
  const start = timeline.length;
  await me.exec(cmd, { timeoutMs: 5000 }).catch(() => {});
  await sleep(300);
  const seen = timeline.slice(start);
  const first = seen.findIndex((a) => a.name === response);
  const head = seen[first];
  if (head === undefined) return [];
  const rows = [head.params];
  for (const a of seen.slice(first + 1)) {
    if (a.name !== "") break;
    rows.push({ ...rows[rows.length - 1], ...a.params });
  }
  return rows;
}

// Members and entries for the lists that are otherwise empty on a fresh server.
const channelGroups = await rowsOf("channelgrouplist", "notifychannelgrouplist");
const channelAdmin =
  channelGroups.find((g) => g["type"] === "1" && g["cgid"] !== defaultCgid)?.["cgid"] ?? "5";
await me
  .exec(`setclientchannelgroup cgid=${channelAdmin} cid=1 cldbid=${victimDbid}`, {
    timeoutMs: 5000,
  })
  .catch(() => {});
await me
  .exec(`messageadd cluid=${uid} subject=probe message=probe`, { timeoutMs: 5000 })
  .catch(() => {});
const messages = await rowsOf("messagelist", "notifymessagelist");
const msgid = messages[0]?.["msgid"] ?? "1";
const upload = await initFileUpload(me, asChannelID(1n), "/probe.txt", 3n)
  .then(async (info) => {
    const host = addr.slice(0, addr.lastIndexOf(":"));
    await me.uploadFileData(host, info, Readable.from([Buffer.from([1, 2, 3])]));
    return "uploaded";
  })
  .catch((e: Error) => `upload failed: ${e.message}`);
console.log(`setup: channel admin cgid=${channelAdmin} msgid=${msgid} ${upload}`);

// Instance-level commands answered 2568 even as Server Admin. Grant the
// instance permissions to the admin group to tell "missing permission" apart
// from "not reachable over the voice protocol".
for (const perm of [
  "b_serverinstance_info_view",
  "b_serverinstance_binding_list",
  "b_serverinstance_virtualserver_list",
  "b_serverinstance_permission_list",
  "b_serverinstance_permission_find",
]) {
  await me
    .exec(`servergroupaddperm sgid=6 permsid=${perm} permvalue=1 permnegated=0 permskip=0`, {
      timeoutMs: 5000,
    })
    .catch((e: Error) => console.log(`grant ${perm}: ${e.message}`));
}
await sleep(500);

const queries: string[] = [
  "banadd ip=192.0.2.1 banreason=probe time=60",
  "banlist",
  "bindinglist",
  `channelclientpermlist cid=1 cldbid=${myDbid}`,
  `channelcreate channel_name=probe${tag}`,
  "channelfind pattern=Alpha",
  "channelgetdescription cid=1",
  `channelgroupadd name=pcg${tag} type=1`,
  `channelgroupclientlist cid=1 cgid=${channelAdmin}`,
  `channelgroupcopy scgid=${defaultCgid} tcgid=0 name=pcgc${tag} type=1`,
  "channelgrouplist",
  `channelgrouppermlist cgid=${defaultCgid}`,
  "channelinfo cid=1",
  "channellist",
  "channelpermlist cid=1",
  `clientdbfind pattern=${uid} -uid`,
  `clientdbinfo cldbid=${myDbid}`,
  "clientdblist",
  "clientfind pattern=shape",
  `clientgetdbidfromuid cluid=${uid}`,
  `clientgetids cluid=${uid}`,
  `clientgetnamefromdbid cldbid=${myDbid}`,
  `clientgetnamefromuid cluid=${uid}`,
  `clientgetuidfromclid clid=${myClid}`,
  `clientinfo clid=${myClid}`,
  "clientlist",
  `clientpermlist cldbid=${myDbid}`,
  "complainlist",
  "ftgetfileinfo cid=1 cpw= name=\\/probe.txt",
  "ftgetfilelist cid=1 cpw= path=\\/",
  `ftinitdownload clientftfid=901 name=\\/probe${tag} cid=1 cpw= seekpos=0 proto=1`,
  "ftinitupload clientftfid=902 name=\\/probe.txt cid=1 cpw= size=3 overwrite=1 resume=0 proto=1",
  "ftlist",
  "hostinfo",
  "instanceinfo",
  "logview lines=3",
  `messageget msgid=${msgid}`,
  "messagelist",
  "permfind permsid=i_channel_join_power",
  "permidgetbyname permsid=i_channel_join_power",
  "permissionlist",
  `permoverview cid=1 cldbid=${myDbid} permid=0`,
  "privilegekeyadd tokentype=0 tokenid1=" + defaultSgid + " tokenid2=0",
  "privilegekeylist",
  `servergroupadd name=psg${tag} type=1`,
  "servergroupclientlist sgid=6",
  `servergroupcopy ssgid=${defaultSgid} tsgid=0 name=psgc${tag} type=1`,
  "servergrouplist",
  `servergrouppermlist sgid=${defaultSgid}`,
  `servergroupsbyclientid cldbid=${myDbid}`,
  "serveridgetbyport virtualserver_port=9987",
  "serverinfo",
  "serverrequestconnectioninfo",
  "servertemppasswordadd pw=probe desc=probe duration=60",
  "servertemppasswordlist",
  "version",
  "whoami",
  // Last: banning the victim drops it, which is noise for anything after.
  `banclient clid=${victim.clientID} time=1`,
];

const fmt = (m: Map<string, number>) =>
  [...m].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(" ") || "-";

const results: Record<string, unknown> = {};
for (const q of queries) {
  const name = q.split(" ")[0] ?? q;
  const s = await measure(q);
  results[name] = {
    error: s.error,
    returnedRows: s.returnedRows,
    before: Object.fromEntries(s.before),
    after: Object.fromEntries(s.after),
    firstRowKeys: s.firstRow ? Object.keys(s.firstRow) : [],
  };
  console.log(
    `${name.padEnd(28)} error=${s.error.padEnd(5)} returned=${String(s.returnedRows).padEnd(4)} ` +
      `before=[${fmt(s.before)}] after=[${fmt(s.after)}]`,
  );
}

if (process.env["OUT"]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env["OUT"], JSON.stringify(results, null, 2));
}

await victim.disconnect().catch(() => {});
await me.disconnect().catch(() => {});
process.exit(0);
