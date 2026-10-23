import { AlreadyConnectedError, ErrorCode, ServerError } from "@honeybbq/teamspeak";
import { MissingDependencyError, QueryAuthError, SshHostKeyError } from "./errors.js";

/**
 * Server errors where retrying cannot help.
 *
 * A refused `login` or `use` is the case this exists for. `login` is the only
 * command that can succeed with the wrong credentials and fail with the right
 * ones, and a wrong password stays wrong, so retrying it costs a bounded few
 * attempts and floods the server for nothing. The server's own flood refusal
 * (524) is deliberately *not* here: it clears by itself, and it is what a
 * reconnect loop is most likely to meet right after a drop.
 */
const PERMANENT_SERVER_ERRORS: ReadonlySet<number> = new Set([
  ErrorCode.ClientInvalidPassword, // login: wrong name or password
  ErrorCode.ClientNotLoggedIn, // use: this session has no login, and none is configured
  ErrorCode.ClientLoginNotPermitted, // login: this account may not log in
  ErrorCode.ServerInvalidID, // use: no such server
  ErrorCode.ServerIsNotRunning, // use: that server is down
  ErrorCode.ConnectFailedBanned, // retrying while banned extends the ban
  ErrorCode.BanFlooding, // retrying while flood-banned extends the ban
  ErrorCode.PermissionsClientInsufficient, // the account lacks the permission it needs
]);

/**
 * Errors of a `login` or `use` that {@link isPermanentCommandError} found
 * permanent. The error is the same object `shouldRetry` is later given, so
 * the mark travels with it without changing its type.
 */
const connectRefusals = new WeakSet();

/**
 * Record why a command of `connect()` failed, so that the default
 * `shouldRetry` can tell a refused `login` or `use` from any other failure.
 */
export function noteConnectFailure(command: string, error: unknown): void {
  if (typeof error === "object" && error !== null && isPermanentCommandError(command, error)) {
    connectRefusals.add(error);
  }
}

/** Commands whose refusal is the credentials or the target, not the network. */
const CONNECT_COMMANDS: ReadonlySet<string> = new Set(["login", "use"]);

/**
 * Refusals of those commands that do clear by themselves: the query flood
 * limit, which the client meets because reconnecting is exactly what the limit
 * is about.
 */
const TRANSIENT_SERVER_ERRORS: ReadonlySet<number> = new Set([ErrorCode.ClientIsFlooding]);

/**
 * Whether a failed connection attempt is worth another one.
 *
 * The voice client's `defaultShouldRetry` answers the same question for a
 * dropped voice session, where the failure to retry is a kick or a bad
 * password. ServerQuery has neither a session to be kicked from nor a
 * handshake to fail, so the rule is about the commands `connect()` runs: a
 * refused `login` or `use` is not retried, nor is an ssh account the server
 * will not authenticate, nor a host key that was not accepted, nor a missing
 * `ssh2`. Everything else — a refused
 * TCP connection, a dropped one, an HTTP failure, a server that stopped
 * answering — is.
 *
 * A custom `shouldRetry` replaces this; see `ReconnectOptions`.
 */
export function defaultShouldRetry(error: Error | undefined): boolean {
  // A refused `login` or `use`, whatever its code; see `noteConnectFailure`.
  if (error !== undefined && connectRefusals.has(error)) return false;
  // The client is connected, or connecting, already: nothing is left to retry.
  if (error instanceof AlreadyConnectedError) return false;
  // An account the server refused, or a transport that is on the wrong side
  // of a firewall: both stay refused.
  if (error instanceof QueryAuthError) return false;
  // A key that was refused stays refused: the file or the caller's check says
  // the same thing next time, and a changed key is not one to keep knocking on.
  if (error instanceof SshHostKeyError) return false;
  if (error instanceof MissingDependencyError) return false;
  if (error instanceof ServerError) {
    return !PERMANENT_SERVER_ERRORS.has(error.code);
  }
  // A transport's own failure, such as a refused socket or a reset. The
  // offending command is not known from here, so the loop's own history is
  // what decides; see `QueryClient`.
  return true;
}

/**
 * Whether a command that failed during `connect()` is one to give up on: the
 * commands whose failure is a fact about the account or the target rather than
 * about the connection.
 *
 * `defaultShouldRetry` cannot see which command failed, and does not need to:
 * it is called with the error alone, as `ReconnectOptions` documents, and
 * covers the errors a wrong password arrives as. This covers the rest — a
 * `use` refused with a code that is not in the list above, such as 1542 for a
 * port no virtual server is on.
 */
export function isPermanentCommandError(command: string, error: unknown): boolean {
  if (!CONNECT_COMMANDS.has(command)) return false;
  if (error instanceof QueryAuthError) return true;
  if (error instanceof ServerError) return !TRANSIENT_SERVER_ERRORS.has(error.code);
  return false;
}
