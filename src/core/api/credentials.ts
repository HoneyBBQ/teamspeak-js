/**
 * API keys and ServerQuery logins.
 *
 * Both are credentials for a query connection, which is why they sit together:
 * an API key is what WebQuery takes in place of a login, and a query login is
 * the name and password `login` takes over raw TCP. The keys and passwords the
 * server generates are returned once, as a property that logging the result
 * does not print (see {@link APIKeyCreated}).
 */

import {
  nonZero,
  firstRow,
  exec,
  query,
  list,
  encodeFields,
  str,
  big,
  date,
  durationMs,
  SECOND,
} from "./command.js";
import type { WireNames } from "./command.js";
import type { CommandExecutor, CommandOptions } from "../command/request.js";
import type { APIKeyID, ClientDBID, ServerID } from "../command/ids.js";
import { asAPIKeyID, asClientDBID, asServerID } from "../command/ids.js";
import type { APIKeyScope } from "../enums.js";

// ---- API keys ---------------------------------------------------------------

/**
 * An API key, as `apikeylist` reports it. The key itself is not listed: the
 * server shows it once, when it is created.
 */
export interface APIKey {
  /** The key's id, which {@link deleteAPIKey} takes (`id`). */
  readonly id: APIKeyID;
  /** The virtual server the key belongs to (`sid`); 0 for the instance. */
  readonly serverID: ServerID;
  /** The client the key acts as (`cldbid`). */
  readonly ownerDatabaseID: ClientDBID;
  /** What the key may do, one of {@link APIKeyScope} (`scope`). */
  readonly scope: string;
  /** When the key was created (`created_at`). */
  readonly createdAt: Date | undefined;
  /**
   * When the key stops working (`expires_at`); undefined for a key that never
   * does. The server sends `expires_at` equal to `created_at` for such a key,
   * and `time_left=unlimited`, which is what this follows.
   */
  readonly expiresAt: Date | undefined;
  /**
   * How long the key has left, in milliseconds (`time_left`, sent in
   * seconds); undefined for a key that never expires.
   */
  readonly remainingMs: number | undefined;
  /** The key's custom id (`custom_id`): TS6 sends one, TS3 none, which reads as "". */
  readonly customID: string;
}

/** A key as {@link addAPIKey} creates it: the record, and the key itself. */
export interface APIKeyCreated extends APIKey {
  /**
   * The key, to send as the `x-api-key` of a WebQuery request (`apikey`). A
   * secret the server shows only this once: store it where it is needed, and do
   * not log it.
   */
  readonly key: string;
}

const parseAPIKey = (row: Record<string, string>): APIKey => {
  const unlimited = str(row, "time_left") === "unlimited";
  return {
    id: asAPIKeyID(big(row, "id")),
    serverID: asServerID(big(row, "sid")),
    ownerDatabaseID: asClientDBID(big(row, "cldbid")),
    scope: str(row, "scope"),
    createdAt: date(row, "created_at"),
    expiresAt: unlimited ? undefined : date(row, "expires_at"),
    remainingMs: unlimited ? undefined : durationMs(row, "time_left", SECOND),
    customID: str(row, "custom_id"),
  };
};

/** How {@link addAPIKey} creates a key. */
export interface APIKeyOptions extends CommandOptions {
  /**
   * How many days the key works; 0 for a key that never expires, unset for the
   * server's default of 14 (`lifetime`).
   */
  readonly lifetimeDays?: number | undefined;
  /**
   * The client the key acts as; unset for the connection's own client, and
   * another client's needs `b_virtualserver_apikey_manage` (`cldbid`).
   */
  readonly ownerDatabaseID?: ClientDBID | undefined;
}

const apiKeyNames: WireNames<APIKeyOptions> = {
  lifetimeDays: "lifetime",
  ownerDatabaseID: "cldbid",
};

/**
 * Create an API key with the given scope.
 *
 * Needs `b_virtualserver_apikey_add`. Over ServerQuery, with the owner left
 * unset, the key belongs to the query client's login. Over the voice protocol
 * the answer arrives as a notification, which the client pairs with this
 * command. TS6 also reports a `custom_id`.
 *
 * Returns the key with its record. The key grants access to the server and is
 * shown only this once: store it, and do not log it.
 */
export async function addAPIKey(
  client: CommandExecutor,
  scope: APIKeyScope,
  options: APIKeyOptions = {},
): Promise<APIKeyCreated> {
  const { lifetimeDays } = options;
  if (lifetimeDays !== undefined && (!Number.isInteger(lifetimeDays) || lifetimeDays < 0)) {
    throw new RangeError(`a lifetime is a whole number of days, 0 or more, not ${lifetimeDays}`);
  }
  const rows = await query(
    client,
    "apikeyadd",
    [["scope", scope], ...encodeFields(options, apiKeyNames)],
    options,
  );
  const row = firstRow(rows, "apikeyadd", "apikey");
  return { ...parseAPIKey(row), key: str(row, "apikey") };
}

/** Which keys {@link listAPIKeys} reports, and how many. */
export interface APIKeyListOptions extends CommandOptions {
  /**
   * Whose keys: a client's database id, or "all" for every client's; unset
   * for the connection's own. Anyone else's needs
   * `b_virtualserver_apikey_manage` (`cldbid`, `*` for "all").
   */
  readonly owner?: ClientDBID | "all" | undefined;
  /** Skip this many keys (`start`). */
  readonly start?: number | undefined;
  /** Report at most this many keys (`duration`). */
  readonly limit?: number | undefined;
}

const apiKeyListNames: WireNames<APIKeyListOptions> = {
  owner: ["cldbid", (owner) => (owner === "all" ? "*" : owner)],
  start: "start",
  limit: "duration",
};

/**
 * API keys, newest last. None is an empty list. Needs
 * `b_virtualserver_apikey_manage`.
 *
 * `-count`, which adds the total number of keys to the first row, is not sent:
 * the function returns the keys, and the total would be a second result.
 */
export async function listAPIKeys(
  client: CommandExecutor,
  options: APIKeyListOptions = {},
): Promise<APIKey[]> {
  const rows = await list(client, "apikeylist", encodeFields(options, apiKeyListNames), options);
  return rows.map(parseAPIKey);
}

/**
 * Delete an API key. A client can always delete its own; another's needs
 * `b_virtualserver_apikey_manage`.
 *
 * An id no key has is refused with error 5123 (invalid apikey id). Careful
 * with the id of the key a WebQuery connection itself uses: deleting it ends
 * that connection's access.
 */
export async function deleteAPIKey(
  client: CommandExecutor,
  id: APIKeyID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "apikeydel", [["id", id]], options);
}

// ---- ServerQuery logins -----------------------------------------------------

/** A ServerQuery login, as `queryloginlist` reports it. */
export interface QueryLogin {
  /** The client the login belongs to (`cldbid`). */
  readonly databaseID: ClientDBID;
  /** The virtual server it belongs to (`sid`); 0 for a login of the instance. */
  readonly serverID: ServerID;
  /** The login name (`client_login_name`). */
  readonly name: string;
}

/** A login as {@link addQueryLogin} creates it: the record, and its password. */
export interface QueryLoginCreated extends QueryLogin {
  /**
   * The generated password (`client_login_password`). A secret the server shows
   * only this once: store it where it is needed, and do not log it.
   */
  readonly password: string;
}

const parseQueryLogin = (row: Record<string, string>): QueryLogin => ({
  databaseID: asClientDBID(big(row, "cldbid")),
  serverID: asServerID(big(row, "sid")),
  name: str(row, "client_login_name"),
});

/** Which logins {@link listQueryLogins} reports. */
export interface QueryLoginListOptions extends CommandOptions {
  /** Only names matching this pattern, which may hold the SQL wildcard `%` (`pattern`). */
  readonly pattern?: string | undefined;
  /** Skip this many logins (`start`). */
  readonly start?: number | undefined;
  /** Report at most this many logins (`duration`). */
  readonly limit?: number | undefined;
}

const queryLoginListNames: WireNames<QueryLoginListOptions> = {
  pattern: "pattern",
  start: "start",
  limit: "duration",
};

/**
 * ServerQuery logins of the selected virtual server, or of all of them when
 * none is selected. None is an empty list.
 *
 * ServerQuery only: a voice client gets error 2 (not implemented). Needs
 * `b_serverquery_login_list`.
 */
export async function listQueryLogins(
  client: CommandExecutor,
  options: QueryLoginListOptions = {},
): Promise<QueryLogin[]> {
  const rows = await list(
    client,
    "queryloginlist",
    encodeFields(options, queryLoginListNames),
    options,
  );
  return rows.map(parseQueryLogin);
}

/** For which client {@link addQueryLogin} creates a login. */
export interface QueryLoginAddOptions extends CommandOptions {
  /**
   * The client to enable the login for (`cldbid`; 0 is unset). With a virtual
   * server selected it is required, and names a client already in that
   * server's database: a login is attached to one. With none selected the
   * login is the instance's own, and the server makes the client.
   */
  readonly databaseID?: ClientDBID | undefined;
}

const queryLoginAddNames: WireNames<QueryLoginAddOptions> = {
  databaseID: ["cldbid", nonZero],
};

/**
 * Create a ServerQuery login, or enable one for an existing client; asking
 * again for the same client sets a new password.
 *
 * ServerQuery only: a voice client gets error 2 (not implemented). Needs
 * `b_serverquery_login_create`. Returns the login with its generated
 * password, a secret the server shows once: store it, and do not log it.
 */
export async function addQueryLogin(
  client: CommandExecutor,
  name: string,
  options: QueryLoginAddOptions = {},
): Promise<QueryLoginCreated> {
  const rows = await query(
    client,
    "queryloginadd",
    [["client_login_name", name], ...encodeFields(options, queryLoginAddNames)],
    options,
  );
  const row = firstRow(rows, "queryloginadd", "client_login_password");
  return { ...parseQueryLogin(row), password: str(row, "client_login_password") };
}

/**
 * Delete a client's ServerQuery login. The server refuses a client with none
 * with error 1538 (invalid parameter) and an unknown one with 512.
 *
 * ServerQuery only: a voice client gets error 2 (not implemented). Needs
 * `b_serverquery_login_delete`.
 */
export async function deleteQueryLogin(
  client: CommandExecutor,
  databaseID: ClientDBID,
  options?: CommandOptions,
): Promise<void> {
  await exec(client, "querylogindel", [["cldbid", databaseID]], options);
}

/**
 * Set this client's own ServerQuery login name, and return the password the
 * server generates for it.
 *
 * Works over the voice protocol, where the answer is a notification the
 * client pairs with this command. A ServerQuery connection gets error 512 on
 * TS3 and TS6 alike: its own client has no database record to attach the login
 * to; use {@link addQueryLogin} there. Needs
 * `b_client_create_modify_serverquery_login`. The password is a secret the
 * server shows only this once: store it, and do not log it.
 */
export async function setQueryLogin(
  client: CommandExecutor,
  name: string,
  options?: CommandOptions,
): Promise<string> {
  const rows = await query(
    client,
    "clientsetserverquerylogin",
    [["client_login_name", name]],
    options,
  );
  return str(
    firstRow(rows, "clientsetserverquerylogin", "client_login_password"),
    "client_login_password",
  );
}
