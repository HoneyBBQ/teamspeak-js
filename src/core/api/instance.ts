/**
 * Virtual servers, snapshots and the instance process.
 *
 * These address the instance rather than one virtual server, so they need the
 * `b_serverinstance_*` and `b_virtualserver_*` permissions of an instance
 * administrator, which not even a virtual server's Server Admin holds: over the
 * voice protocol they answer error 2568. They are for a ServerQuery connection
 * logged in as the instance's administrator; for most of them, one with no
 * virtual server selected. Both TS3 and TS6 limit an unlicensed instance to one
 * running virtual server, and refuse another with error 2816 (virtualserver
 * limit reached).
 */

import {
  firstRow,
  exec,
  query,
  list,
  encodeFields,
  rawProperties,
  nonEmpty,
  str,
  big,
  num,
  bool,
  durationMs,
  withSecret,
  SECOND,
} from "./command.js";
import type { WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type { ChannelID, ServerID } from "../command/ids.js";
import { asChannelID, asServerID } from "../command/ids.js";

// ---- Virtual servers --------------------------------------------------------

/** A virtual server, as `serverlist` reports it. */
export interface VirtualServer {
  /** The server's id (`virtualserver_id`). */
  readonly id: ServerID;
  /** The voice port it listens on (`virtualserver_port`). */
  readonly port: number;
  /**
   * Its state, as the server words it: "online", "offline", "booting up",
   * "shutting down", "online virtual" (`virtualserver_status`).
   */
  readonly status: string;
  /** Its name (`virtualserver_name`); "" with `short`. */
  readonly name: string;
  /** Voice clients connected (`virtualserver_clientsonline`); undefined with `short`, and for a server that is not running. */
  readonly clientsOnline: number | undefined;
  /** ServerQuery clients connected (`virtualserver_queryclientsonline`); undefined as `clientsOnline`. */
  readonly queryClientsOnline: number | undefined;
  /** How many clients it accepts (`virtualserver_maxclients`); undefined as `clientsOnline`. */
  readonly maxClients: number | undefined;
  /** How long it has been running, in milliseconds (`virtualserver_uptime`, sent in seconds); undefined as `clientsOnline`. */
  readonly uptimeMs: number | undefined;
  /** Whether it starts with the instance (`virtualserver_autostart`); undefined with `short`. */
  readonly autoStart: boolean | undefined;
  /** The machine id of the instance that runs it, "" for none (`virtualserver_machine_id`); undefined with `short`. */
  readonly machineID: string | undefined;
  /** Its unique identifier, with `uid`; "" otherwise (`virtualserver_unique_identifier`). */
  readonly uid: string;
}

const optional = <T>(row: Record<string, string>, key: string, read: () => T): T | undefined =>
  row[key] === undefined ? undefined : read();

const parseVirtualServer = (row: Record<string, string>): VirtualServer => ({
  id: asServerID(big(row, "virtualserver_id")),
  port: num(row, "virtualserver_port"),
  status: str(row, "virtualserver_status"),
  name: str(row, "virtualserver_name"),
  clientsOnline: optional(row, "virtualserver_clientsonline", () =>
    num(row, "virtualserver_clientsonline"),
  ),
  queryClientsOnline: optional(row, "virtualserver_queryclientsonline", () =>
    num(row, "virtualserver_queryclientsonline"),
  ),
  maxClients: optional(row, "virtualserver_maxclients", () => num(row, "virtualserver_maxclients")),
  uptimeMs: optional(row, "virtualserver_uptime", () =>
    durationMs(row, "virtualserver_uptime", SECOND),
  ),
  autoStart: optional(row, "virtualserver_autostart", () => bool(row, "virtualserver_autostart")),
  machineID: row["virtualserver_machine_id"],
  uid: str(row, "virtualserver_unique_identifier"),
});

/** Which servers {@link listServers} reports, and with what. */
export interface ServerListOptions extends CommandOptions {
  /** Include each server's unique identifier (`-uid`). */
  readonly uid?: boolean | undefined;
  /** Leave out everything but the id, port and status (`-short`). */
  readonly short?: boolean | undefined;
  /** List every server in the database, whichever instance's machine id they carry (`-all`). */
  readonly all?: boolean | undefined;
  /** Only the servers that are offline (`-onlyoffline`). */
  readonly onlyOffline?: boolean | undefined;
}

const serverListFlags: WireNames<ServerListOptions> = {
  uid: "-uid",
  short: "-short",
  all: "-all",
  onlyOffline: "-onlyoffline",
};

/**
 * The instance's virtual servers. None is an empty list.
 *
 * Needs `b_serverinstance_virtualserver_list`, which a voice client's Server
 * Admin lacks (error 2568). TS6 also reports `guest_can_create_channels`,
 * `guest_can_create_homebase` and `virtualserver_weblist_enabled`, which are
 * not read here.
 */
export async function listServers(
  client: CommandExecutor,
  options: ServerListOptions = {},
): Promise<VirtualServer[]> {
  const rows = await list(client, "serverlist", encodeFields(options, serverListFlags), options);
  return rows.map(parseVirtualServer);
}

/**
 * A server as {@link createServer} made it: its id and port, and the
 * administrator's privilege key.
 *
 * `token` is a secret — whoever has it can make themselves the new server's
 * administrator — and is defined but not enumerable, so `console.log`,
 * `util.inspect` and `JSON.stringify` of the result leave it out. Read it by
 * name; spreading the result does not copy it.
 */
export type ServerCreated = {
  /** The new server's id (`sid`). */
  readonly id: ServerID;
  /** The voice port it was given (`virtualserver_port`). */
  readonly port: number;
} & {
  /** The privilege key that makes its holder the server's administrator (`token`). */
  readonly token: string;
};

/**
 * Create a virtual server and start it.
 *
 * `settings` are raw `virtualserver_*` properties, passed through as given for
 * the reasons {@link editServer} gives; `virtualserver_port` picks the port,
 * and the server takes the first free one from 9987 up when it is unset. Needs
 * `b_virtualserver_create`. An instance without a license that already runs a
 * server refuses with error 2816.
 */
export async function createServer(
  client: CommandExecutor,
  name: string,
  settings: Readonly<Record<string, string>> = {},
  options?: CommandOptions,
): Promise<ServerCreated> {
  const rows = await query(
    client,
    "servercreate",
    [["virtualserver_name", name], ...rawProperties(settings)],
    options,
  );
  const row = firstRow(rows, "servercreate", "sid");
  return withSecret(
    { id: asServerID(big(row, "sid")), port: num(row, "virtualserver_port") },
    "token",
    str(row, "token"),
  );
}

/**
 * Start a virtual server. Needs `b_virtualserver_start_any`, or
 * `b_virtualserver_start` for the server the connection is on.
 *
 * Starting a server that cannot start answers error 2816 when the license
 * limit is reached.
 */
export async function startServer(
  client: CommandExecutor,
  sid: ServerID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "serverstart", [["sid", sid]], options);
}

/** What {@link stopServer} tells the clients. */
export interface ServerStopOptions extends CommandOptions {
  /** A message sent to the clients before they are disconnected (`reasonmsg`); unset or "" sends none. */
  readonly reason?: string | undefined;
}

const stopNames: WireNames<ServerStopOptions> = { reason: ["reasonmsg", nonEmpty] };

/**
 * Stop a virtual server, disconnecting its clients. Needs
 * `b_virtualserver_stop_any`, or `b_virtualserver_stop` for the server the
 * connection is on. A server that is not running is refused with error 1033.
 */
export async function stopServer(
  client: CommandExecutor,
  sid: ServerID,
  options: ServerStopOptions = {},
): Promise<void> {
  await exec(client, "serverstop", [["sid", sid], ...encodeFields(options, stopNames)], options);
}

/** How {@link deleteServer} reports the deletion. */
export interface ServerDeleteOptions extends CommandOptions {
  /** Do not send the `virtualserver destroyed` event to other query clients (`-noevent`). */
  readonly noEvent?: boolean | undefined;
}

const deleteFlags: WireNames<ServerDeleteOptions> = { noEvent: "-noevent" };

/**
 * Delete a virtual server for good: its channels, groups and client records
 * go with it. Needs `b_virtualserver_delete`.
 *
 * The server must be stopped first, and one a query client has selected is
 * refused with error 1035 even then. An id no server has is refused with 1024. `noEvent` is accepted by TS3 and TS6.
 */
export async function deleteServer(
  client: CommandExecutor,
  sid: ServerID,
  options: ServerDeleteOptions = {},
): Promise<void> {
  await exec(
    client,
    "serverdelete",
    [["sid", sid], ...encodeFields(options, deleteFlags)],
    options,
  );
}

/**
 * Stop the whole instance: the process exits, every virtual server with it,
 * and nothing here can start it again. Needs `b_serverinstance_stop`.
 *
 * The answer comes before the process ends, and the connection drops after it.
 */
export async function stopInstance(
  client: CommandExecutor,
  options: ServerStopOptions = {},
): Promise<void> {
  await exec(client, "serverprocessstop", encodeFields(options, stopNames), options);
}

/**
 * Send a text message to every client on every virtual server of the
 * instance. Needs `b_serverinstance_textmessage_send`.
 */
export async function sendGlobalMessage(
  client: CommandExecutor,
  message: string,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "gm", [["msg", message]], options);
}

// ---- Snapshots --------------------------------------------------------------

/**
 * A snapshot of a virtual server, as `serversnapshotcreate` returns it and
 * `serversnapshotdeploy` takes it back.
 *
 * It holds the server's settings, groups, permissions, channels and the
 * identities of every client it knows, so it is as sensitive as the server's
 * database: store it as such, and do not log it. Without a `password` it is
 * only compressed and encoded; with one it is encrypted.
 */
export interface ServerSnapshot {
  /** The snapshot format's version (`version`); 3 on TS3 3.13 and TS6. */
  readonly version: number;
  /** The salt of the password the snapshot is encrypted with (`salt`); "" when it is not. */
  readonly salt: string;
  /** The snapshot itself (`data`), a base64 string, often several kilobytes. */
  readonly data: string;
}

/** How {@link createServerSnapshot} protects the snapshot. */
export interface ServerSnapshotOptions extends CommandOptions {
  /** Encrypt the snapshot with this password; unset or "" leaves it unencrypted (`password`). */
  readonly password?: string | undefined;
}

const snapshotNames: WireNames<ServerSnapshotOptions> = { password: ["password", nonEmpty] };

/**
 * Take a snapshot of the selected virtual server.
 *
 * Needs `b_virtualserver_snapshot_create`, which a voice client's Server Admin
 * lacks (error 2568). The same answer, `version`, `data` and with a password
 * `salt`, comes over raw TCP, SSH and WebQuery on TS3 and TS6.
 */
export async function createServerSnapshot(
  client: CommandExecutor,
  options: ServerSnapshotOptions = {},
): Promise<ServerSnapshot> {
  const rows = await query(
    client,
    "serversnapshotcreate",
    encodeFields(options, snapshotNames),
    options,
  );
  const row = firstRow(rows, "serversnapshotcreate", "data");
  return { version: num(row, "version"), salt: str(row, "salt"), data: str(row, "data") };
}

/** How {@link deployServerSnapshot} restores. */
export interface ServerSnapshotDeployOptions extends CommandOptions {
  /** The password the snapshot was encrypted with; unset or "" for an unencrypted one (`password`). */
  readonly password?: string | undefined;
  /** Keep the files of the channels that exist both on the server and in the snapshot (`-keepfiles`). */
  readonly keepFiles?: boolean | undefined;
  /** Report which new channel each of the snapshot's channels became (`-mapping`). */
  readonly mapping?: boolean | undefined;
}

const deployNames: WireNames<ServerSnapshotDeployOptions> = {
  password: ["password", nonEmpty],
  keepFiles: "-keepfiles",
  mapping: "-mapping",
};

/** Which channel of a snapshot became which channel on the server, as `-mapping` reports it. */
export interface ChannelMapping {
  /** The channel's id in the snapshot (`ocid`). */
  readonly oldID: ChannelID;
  /** Its id on the server now (`ncid`). */
  readonly newID: ChannelID;
}

/**
 * Restore a virtual server from a snapshot.
 *
 * With a server selected, the snapshot replaces that server's settings,
 * groups, channels and client records; the channels get new ids, which
 * `mapping` reports as one entry per channel (the result is `[]` without it).
 * With none selected, the server makes a new virtual server from it, which an
 * unlicensed instance that is already running one refuses with error 2816. The
 * server does not check permissions while deploying, so the right to do it is
 * the right to give oneself any permission: needs
 * `b_virtualserver_snapshot_deploy`, which a voice client's Server Admin lacks
 * (error 2568).
 *
 * Over raw TCP and SSH the virtual server restarts, which ends the
 * connection's selection of it: the next command is refused with error 1024
 * until the connection selects it again with `use`. An encrypted snapshot
 * with the wrong password is refused with error 1538; an unencrypted one
 * ignores the password.
 */
export async function deployServerSnapshot(
  client: CommandExecutor,
  snapshot: ServerSnapshot,
  options: ServerSnapshotDeployOptions = {},
): Promise<ChannelMapping[]> {
  const rows = await query(
    client,
    "serversnapshotdeploy",
    [
      ...encodeFields(options, deployNames),
      ["version", snapshot.version],
      ["salt", nonEmpty(snapshot.salt ?? "")],
      ["data", snapshot.data],
    ],
    options,
  );
  return rows.flatMap((row) =>
    row["ocid"] === undefined
      ? []
      : [{ oldID: asChannelID(big(row, "ocid")), newID: asChannelID(big(row, "ncid")) }],
  );
}
