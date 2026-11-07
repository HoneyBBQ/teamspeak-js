/**
 * Which commands does the FULL CLIENT (voice/UDP) protocol actually accept?
 *
 * The server does not answer commands it does not implement, so an unanswered
 * command shows up as a timeout while a real command answers with either data
 * or an error id. That difference is the discriminator used here.
 *
 * Run against a local server as Server Admin so permissions do not mask
 * protocol availability.
 *
 * The candidates are client-to-server commands only. An earlier list also
 * carried server-to-client message names (`channellistfinished`,
 * `notifyservergrouplist`) and names that exist nowhere (`globalmessage`,
 * `permid`, `notifyregister`); those were the "unavailable" commands, and with
 * them gone every candidate answers.
 *
 * This only tells whether a command is accepted. How its data comes back is
 * scripts/probe-response-shapes.mts.
 */
import { generateIdentitySync } from "../src/client/crypto/identity.js";
import { Client } from "../src/client/client.js";
import { CommandTimeoutError } from "../src/core/index.js";

const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const c = new Client(
  generateIdentitySync(8),
  process.env["ADDR"] ?? "127.0.0.1:9987",
  "js-cmdprobe",
  {
    defaultChannel: process.env["CHANNEL"] ?? "Alpha",
    logger: quiet,
  },
);
await c.connect();
await c.view.whenReady({ signal: AbortSignal.timeout(10_000) });

const me = await c.exec("clientinfo", { timeoutMs: 5000 }).catch(() => []);
const myDbId = me[0]?.["client_database_id"] ?? "1";
console.log(`PROBE clid=${c.clientID} dbid=${myDbId}`);

// A representative argument set for each command. Wrong arguments still prove
// the command exists, because the server answers with a parameter error.
const candidates: Array<[string, string]> = [
  ["banadd", "banadd ip=192.0.2.1 banreason=probe time=60"],
  ["banclient", `banclient clid=${c.clientID} time=60`],
  ["bandel", "bandel banid=1"],
  ["bandelall", "bandelall"],
  ["banlist", "banlist"],
  ["bindinglist", "bindinglist"],
  ["channeladdperm", "channeladdperm cid=1 permsid=i_channel_join_power permvalue=1"],
  [
    "channelclientaddperm",
    `channelclientaddperm cid=1 cldbid=${myDbId} permsid=i_channel_join_power permvalue=1`,
  ],
  [
    "channelclientdelperm",
    `channelclientdelperm cid=1 cldbid=${myDbId} permsid=i_channel_join_power`,
  ],
  ["channelclientpermlist", `channelclientpermlist cid=1 cldbid=${myDbId}`],
  ["channelcreate", "channelcreate channel_name=ProbeCreate"],
  ["channeldelete", "channeldelete cid=1 force=1"],
  ["channeldelperm", "channeldelperm cid=1 permsid=i_channel_join_power"],
  ["channeledit", "channeledit cid=1 channel_description=probe"],
  ["channelfind", "channelfind pattern=Probe"],
  ["channelgetdescription", "channelgetdescription cid=1"],
  ["channelgroupadd", "channelgroupadd name=ProbeCG type=0"],
  ["channelgroupaddperm", "channelgroupaddperm cgid=8 permsid=i_channel_join_power permvalue=1"],
  ["channelgroupclientlist", "channelgroupclientlist cid=1"],
  ["channelgroupcopy", "channelgroupcopy scgid=8 tcgid=9 name=ProbeCopy type=0"],
  ["channelgroupdel", "channelgroupdel cgid=8 force=1"],
  ["channelgroupdelperm", "channelgroupdelperm cgid=8 permsid=i_channel_join_power"],
  ["channelgrouplist", "channelgrouplist"],
  ["channelgrouppermlist", "channelgrouppermlist cgid=8"],
  ["channelgrouprename", "channelgrouprename cgid=8 name=ProbeRen"],
  ["channelinfo", "channelinfo cid=1"],
  ["channellist", "channellist"],
  ["channelmove", "channelmove cid=1 cpid=0 order=0"],
  ["channelpermlist", "channelpermlist cid=1"],
  ["channelsubscribe", "channelsubscribe cid=1"],
  ["channelsubscribeall", "channelsubscribeall"],
  ["channelunsubscribe", "channelunsubscribe cid=1"],
  ["channelunsubscribeall", "channelunsubscribeall"],
  ["clientaddperm", `clientaddperm cldbid=${myDbId} permsid=i_channel_join_power permvalue=1`],
  ["clientchatclosed", "clientchatclosed clid=1"],
  ["clientdbdelete", `clientdbdelete cldbid=${myDbId}`],
  ["clientdbedit", `clientdbedit cldbid=${myDbId} client_description=probe`],
  ["clientdbfind", "clientdbfind pattern=probe"],
  ["clientdbinfo", `clientdbinfo cldbid=${myDbId}`],
  ["clientdblist", "clientdblist start=0 duration=10"],
  ["clientdelperm", `clientdelperm cldbid=${myDbId} permsid=i_channel_join_power`],
  ["clientedit", `clientedit clid=${c.clientID} client_description=probe`],
  ["clientfind", "clientfind pattern=probe"],
  ["clientgetdbidfromuid", "clientgetdbidfromuid cluid=probeuid"],
  ["clientgetids", "clientgetids cluid=probeuid"],
  ["clientgetnamefromdbid", `clientgetnamefromdbid cldbid=${myDbId}`],
  ["clientgetnamefromuid", "clientgetnamefromuid cluid=probeuid"],
  ["clientgetuidfromclid", `clientgetuidfromclid clid=${c.clientID}`],
  ["clientgetvariables", `clientgetvariables clid=${c.clientID}`],
  ["clientinfo", `clientinfo clid=${c.clientID}`],
  ["clientkick", `clientkick clid=${c.clientID} reasonid=5`],
  ["clientlist", "clientlist"],
  ["clientmove", `clientmove clid=${c.clientID} cid=1`],
  ["clientpermlist", `clientpermlist cldbid=${myDbId}`],
  ["clientpoke", `clientpoke clid=${c.clientID} msg=probe`],
  ["clientsetserverquerylogin", "clientsetserverquerylogin client_login_name=probe"],
  ["clientupdate", "clientupdate client_description=probe"],
  ["complainadd", `complainadd tcldbid=${myDbId} message=probe`],
  ["complaindel", `complaindel tcldbid=${myDbId} fcldbid=${myDbId}`],
  ["complaindelall", `complaindelall tcldbid=${myDbId}`],
  ["complainlist", "complainlist"],
  ["ftcreatedir", "ftcreatedir cid=1 dirname=/probedir cpw="],
  ["ftdeletefile", "ftdeletefile cid=1 name=/probe"],
  ["ftgetfileinfo", "ftgetfileinfo cid=1 name=/probe"],
  ["ftgetfilelist", "ftgetfilelist cid=1 path=/"],
  ["ftinitdownload", "ftinitdownload cid=1 name=/probe clientftfid=1"],
  ["ftinitupload", "ftinitupload cid=1 name=/probe clientftfid=1 size=1 overwrite=1 resume=0"],
  ["ftlist", "ftlist cid=1"],
  ["ftrenamefile", "ftrenamefile cid=1 oldname=/a newname=/b"],
  ["ftstop", "ftstop serverftfid=1"],
  ["gm", "gm msg=probe"],
  ["hostinfo", "hostinfo"],
  ["instanceedit", "instanceedit serverinstance_database_id=1"],
  ["instanceinfo", "instanceinfo"],
  ["logadd", "logadd loglevel=1 logmsg=probe"],
  ["logview", "logview"],
  ["messagedel", "messagedel msgid=1"],
  ["messageget", "messageget msgid=1"],
  ["messagelist", "messagelist"],
  ["messageupdateflag", "messageupdateflag msgid=1 flag=1"],
  ["permfind", "permfind permsid=i_channel_join_power"],
  ["permidgetbyname", "permidgetbyname permsid=i_channel_join_power"],
  ["permissionlist", "permissionlist"],
  ["permoverview", "permoverview cid=1 cldbid=1 permid=1"],
  ["permreset", "permreset"],
  ["privilegekeyadd", "privilegekeyadd tokentype=0 tokenid1=6 tokenid2=0"],
  ["privilegekeydelete", "privilegekeydelete token=probe"],
  ["privilegekeylist", "privilegekeylist"],
  ["privilegekeyuse", "privilegekeyuse token=probe"],
  ["sendtextmessage", "sendtextmessage targetmode=3 target=1 msg=probe"],
  ["serveredit", "serveredit virtualserver_name=Probe"],
  ["servergroupadd", "servergroupadd name=ProbeSG type=0"],
  ["servergroupaddclient", `servergroupaddclient sgid=6 cldbid=${myDbId}`],
  ["servergroupaddperm", "servergroupaddperm sgid=6 permsid=i_channel_join_power permvalue=1"],
  [
    "servergroupautoaddperm",
    "servergroupautoaddperm sgid=6 permsid=i_channel_join_power permvalue=1",
  ],
  ["servergroupautodelperm", "servergroupautodelperm sgid=6 permsid=i_channel_join_power"],
  ["servergroupclientlist", "servergroupclientlist sgid=6 -names"],
  ["servergroupcopy", "servergroupcopy ssgid=6 tsgid=7 name=ProbeCopy type=0"],
  ["servergroupdel", "servergroupdel sgid=6 force=1"],
  ["servergroupdelclient", `servergroupdelclient sgid=6 cldbid=${myDbId}`],
  ["servergroupdelperm", "servergroupdelperm sgid=6 permsid=i_channel_join_power"],
  ["servergrouplist", "servergrouplist"],
  ["servergrouppermlist", "servergrouppermlist sgid=6"],
  ["servergrouprename", "servergrouprename sgid=6 name=ProbeSG"],
  ["servergroupsbyclientid", `servergroupsbyclientid cldbid=${myDbId}`],
  ["serveridgetbyport", "serveridgetbyport virtualserver_port=9987"],
  ["serverinfo", "serverinfo"],
  ["serverrequestconnectioninfo", "serverrequestconnectioninfo"],
  ["serversnapshotcreate", "serversnapshotcreate"],
  ["servertemppasswordadd", "servertemppasswordadd pw=probe desc=x duration=60 tcid=1"],
  ["servertemppassworddel", "servertemppassworddel pw=probe"],
  ["servertemppasswordlist", "servertemppasswordlist"],
  ["setclientchannelgroup", `setclientchannelgroup cgid=8 cid=1 cldbid=${myDbId}`],
  ["tokenadd", "tokenadd tokentype=0 tokenid1=6 tokenid2=0"],
  ["tokendelete", "tokendelete token=probe"],
  ["tokenlist", "tokenlist"],
  ["tokenuse", "tokenuse token=probe"],
  ["version", "version"],
  ["whoami", "whoami"],
];

// The server does not answer commands it does not implement. It also drops a
// client whose ping lapses, so a command that stalls the event loop would
// poison every later probe. Reconnect between batches to keep that isolated.
const available: string[] = [];
const unavailable: string[] = [];
let client = c;
for (let i = 0; i < candidates.length; i++) {
  if (i > 0 && i % 25 === 0) {
    await client.disconnect().catch(() => {});
    client = new Client(
      generateIdentitySync(8),
      process.env["ADDR"] ?? "127.0.0.1:9987",
      `js-cmdprobe-${i}`,
      {
        defaultChannel: process.env["CHANNEL"] ?? "Alpha",
        logger: quiet,
      },
    );
    await client.connect();
    await client.view.whenReady({ signal: AbortSignal.timeout(10_000) });
  }
  const candidate = candidates[i];
  if (candidate === undefined) continue;
  const [name, cmd] = candidate;
  try {
    const rows = await client.exec(cmd, { timeoutMs: 3000 });
    available.push(name);
    console.log(`AVAILABLE   ${name.padEnd(26)} rows=${rows.length}`);
  } catch (e) {
    if (e instanceof CommandTimeoutError) {
      unavailable.push(name);
      console.log(`NOT-SUPPORTED ${name.padEnd(26)} (no response)`);
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      available.push(name);
      console.log(
        `AVAILABLE   ${name.padEnd(26)} ${msg.replace("TeamSpeak server error: ", "").slice(0, 40)}`,
      );
    }
  }
}

console.log(`\nAVAILABLE: ${available.length}  NOT-SUPPORTED: ${unavailable.length}`);
console.log(`NOT-SUPPORTED list: ${unavailable.join(", ")}`);

await c.disconnect();
process.exit(0);
