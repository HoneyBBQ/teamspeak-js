import { readFile } from "node:fs/promises";
import { MissingDependencyError, QueryAuthError, SshHostKeyError } from "./errors.js";
import { KnownHosts, fingerprintOf, keyTypeOf } from "./knownhosts.js";
import { StreamTransport } from "./stream.js";
import type { QueryStream } from "./stream.js";

/**
 * The part of an SSH client this transport uses: `ssh2`'s `Client` is one, and
 * so is anything else with these methods.
 *
 * Declared here rather than imported from `@types/ssh2`, which a caller
 * without the optional peer dependency does not have: the types are a
 * devDependency and are not published with the package. A later release may
 * widen this, and every new member will be optional, so an implementation
 * written today keeps compiling.
 */
export interface SshClient {
  /**
   * Begin the connection; `ready` is emitted once the handshake is done.
   *
   * `hostVerifier` is asked about the server's key before anything is
   * authenticated, so before the password is sent. It is given the key's wire
   * encoding and returns whether to go on: a client must end the connection
   * when it returns `false`, and must not treat a missing answer as a yes.
   */
  connect(config: {
    host: string;
    port: number;
    username: string;
    /** Absent for the `guest` account, which logs in without a password. */
    password?: string;
    readyTimeout: number;
    hostVerifier: (key: Uint8Array) => boolean;
  }): void;
  /** Open a shell channel, or report why it could not be opened. */
  shell(pty: false, callback: (error: Error | undefined, channel: SshChannel) => void): void;
  /** End the connection. */
  end(): void;
  /** Listen for the handshake completing, once. */
  once(event: "ready", listener: () => void): unknown;
  /** Listen for the next failure, once. */
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Listen for each failure. */
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Stop listening for failures. */
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** The channel an SSH client's shell opens: a byte stream, and the errors on it. */
export interface SshChannel extends QueryStream {
  /** Report a failure on the stream, as a socket would: the transport reads it. */
  emit(event: "error", error: Error): unknown;
  /** Listen for the stream closing, once. */
  once(event: "close", listener: () => void): unknown;
}

/**
 * An SSH client this transport uses instead of loading `ssh2` itself: either
 * one that is connected already, or a factory that makes one.
 *
 * A caller that holds its own connected client — authenticated through an
 * agent, a jump host or a key file this transport knows nothing about — hands
 * it over. A factory is asked for one per connection attempt, which a
 * reconnection needs.
 */
export type SshConnection = SshClient | (() => Promise<SshClient>);

/**
 * The key an SSH server presented, as the check a caller supplies sees it.
 *
 * A type of this package's own rather than the SSH library's, so a policy can
 * be written without importing that library.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshHostKey {
  /** The host that was dialled, as it was given. */
  readonly host: string;
  /** The port that was dialled. */
  readonly port: number;
  /** The key's algorithm, such as `ssh-ed25519`, as its own encoding names it. */
  readonly keyType: string;
  /** The key's wire encoding: the blob a `known_hosts` line carries in base64. */
  readonly key: Uint8Array;
  /**
   * The key's SHA-256 fingerprint in OpenSSH form, such as `SHA256:HR5y2ZQ…`.
   * It is what `ssh-keygen -lf` and `ssh-keyscan` print, so it can be compared
   * with the one the server's operator published.
   */
  readonly fingerprint: string;
}

/**
 * A caller's check of an SSH server's host key: returns to accept the key and
 * throws to refuse it.
 *
 * Throwing is how a callback with no error channel says no, and the error it
 * throws is kept as the `cause` of the {@link SshHostKeyError} the connection
 * fails with. It runs before the login is sent, and it has to be synchronous
 * and return nothing: a return value, a `false` included, is not an answer this
 * can read, so it refuses the key rather than guess, as does a promise, whose
 * rejection would arrive too late to stop anything.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshHostKeyVerifier = (key: SshHostKey) => void;

/**
 * Your own check of the server's host key. Use it when the key you trust does
 * not live in a `known_hosts` file: a fingerprint from configuration, a pinned
 * key, a lookup somewhere else.
 *
 * One of the three arms of {@link SshHostKeyPolicy}: giving it excludes the
 * other two.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshHostKeyCallbackPolicy {
  /**
   * The check; see {@link SshHostKeyVerifier}. Called once per connection
   * attempt, before the login is sent.
   */
  readonly hostKey: SshHostKeyVerifier;
  /** Left out: `hostKey` is the policy, and a second one would not say which decides. */
  readonly knownHosts?: never;
  /** Left out: `hostKey` is the policy, and a second one would not say which decides. */
  readonly insecureIgnoreHostKey?: never;
}

/**
 * Accept whatever key the server presents. Use it for a test or a throwaway
 * server on a network that is already trusted, and for nothing else.
 *
 * One of the three arms of {@link SshHostKeyPolicy}: giving it excludes the
 * other two.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshInsecureHostKeyPolicy {
  /**
   * Only `true` is a value: this is not a switch to be left `false`, but a
   * decision a call site makes out loud.
   *
   * It gives up the one thing the host key is for. Anyone who can answer the
   * port, on the path or at the address, receives the query login and its
   * password and is indistinguishable from the server. Use
   * {@link SshKnownHostsPolicy.knownHosts} otherwise.
   */
  readonly insecureIgnoreHostKey: true;
  /** Left out: accepting any key leaves nothing for a second policy to decide. */
  readonly hostKey?: never;
  /** Left out: accepting any key leaves nothing for a second policy to decide. */
  readonly knownHosts?: never;
}

// Declared last, on purpose. When no arm matches, TypeScript names one arm's
// missing property in the error, and which one depends on the compiler: 5.x names
// the arm declared last. This is the arm to point a user at, and the others are
// not: `insecureIgnoreHostKey` is the one to be least likely to be added to make
// an error go away.
/**
 * Check the server against an OpenSSH `known_hosts` file. Use it for a server
 * whose key you have recorded with `ssh-keyscan`, or already trust through
 * `ssh`.
 *
 * One of the three arms of {@link SshHostKeyPolicy}: giving it excludes the
 * other two.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshKnownHostsPolicy {
  /**
   * A path to the `known_hosts` file, in the format `ssh-keyscan` writes and
   * `ssh-keygen -H` hashes.
   *
   * Read when each connection is attempted, so a reconnection sees the file as
   * it is then, and only from the path given: `~/.ssh/known_hosts` is never
   * assumed, because a library reading the home directory on its own is a
   * surprise. The check is what `ssh` does with `StrictHostKeyChecking=yes`: a
   * host the file does not mention is refused, so is one recorded with another
   * key, and so is a key a `@revoked` line names. Plain, `[host]:port` and
   * hashed entries are read; a line that cannot be read fails the connection
   * rather than being skipped.
   *
   * A port other than 22 is recorded as `[host]:port`, which is what
   * `ssh-keyscan -p` writes: an entry for port 22 does not vouch for the query
   * port.
   */
  readonly knownHosts: string;
  /** Left out: `knownHosts` is the policy, and a second one would not say which decides. */
  readonly hostKey?: never;
  /** Left out: `knownHosts` is the policy, and a second one would not say which decides. */
  readonly insecureIgnoreHostKey?: never;
}

/**
 * How the server's host key is checked: exactly one of `hostKey`, `knownHosts`
 * and `insecureIgnoreHostKey`.
 *
 * There is no default, and a missing or doubled choice does not compile. The
 * query login is a credential, normally `serveradmin`'s, and a client that
 * accepts any key hands it to whatever answers the port. The same rule is
 * checked when the program runs, for callers that are not type checked.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshHostKeyPolicy =
  | SshHostKeyCallbackPolicy
  | SshKnownHostsPolicy
  | SshInsecureHostKeyPolicy;

/**
 * The address and the login of a server this transport dials itself: the part
 * of {@link SshDialOptions} that is not the host key policy.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshDialTarget {
  /** The server's host. */
  readonly host: string;
  /** The SSH query port; 10022 by default. */
  readonly port?: number | undefined;
  /** The query login name, such as `serveradmin`. */
  readonly username: string;
  /** The query login's password. */
  readonly password: string;
  /** Left out: a login with a name and a password is not a guest's. */
  readonly guest?: never;
  /** Left out: a connection of your own is {@link SshSuppliedConnectionOptions}. */
  readonly connection?: never;
}

/**
 * The address of a server to connect to as its `guest` account: TeamSpeak 6
 * beta13 and later accept the SSH user `guest` without a password, and run it
 * with the Guest Server Query group's permissions.
 *
 * Connecting as a guest is a choice that is made out loud: a missing
 * `username` or `password` in {@link SshDialTarget} is an error and never
 * becomes a guest connection. The host key is still checked, by the same
 * policy: a guest's answers are only as good as the server they come from.
 *
 * What a guest may do is the server's to say. On beta13.1, `version` and
 * `whoami` answer, `serverinfo` and the like are refused with 2568, and
 * `servernotifyregister` is the Guest group's permission to give or withhold,
 * so pass `events: false` to a `QueryClient` that should not register for any.
 * A server that offers no guest access (TeamSpeak 3 has none, and TeamSpeak 6
 * can be started with `--query-ssh-allow-guest=0`) fails the login, which a
 * `QueryClient` reports as a `GuestAccessError` whose `cause` is the
 * {@link QueryAuthError}.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshGuestTarget {
  /** The server's host. */
  readonly host: string;
  /** The SSH query port; 10022 by default. */
  readonly port?: number | undefined;
  /** Only `true` is a value: log in as `guest`, with no password. */
  readonly guest: true;
  /** Left out: a guest logs in as `guest`. */
  readonly username?: never;
  /** Left out: a guest has no password. */
  readonly password?: never;
  /** Left out: a connection of your own is {@link SshSuppliedConnectionOptions}. */
  readonly connection?: never;
}

/**
 * Connect to a server this transport dials itself: with a login, and with a
 * host key policy. The usual way, and the one to use unless you already hold a
 * connected SSH client.
 *
 * It is {@link SshHostKeyPolicy} together with the address and the login, so
 * leaving the policy out is a type error that names the three ways to give one.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshDialOptions = (SshDialTarget | SshGuestTarget) & SshHostKeyPolicy;

/**
 * Use an SSH client you made and connected yourself, or a factory for one:
 * authenticated through an agent, a jump host or a key file this transport
 * knows nothing about.
 *
 * Only a shell is opened on it, so no login and no host key policy are taken:
 * the client you supply has done both already, and an option nothing would
 * read is a type error rather than something that could suggest the key was
 * verified here. The host and port are the server's identity, for messages.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface SshSuppliedConnectionOptions {
  /** The server's host, for identity and messages: nothing is dialled. */
  readonly host: string;
  /** The server's SSH query port, for identity and messages; 10022 by default. */
  readonly port?: number | undefined;
  /**
   * The SSH client to use, or a factory for one. A client that is already
   * connected skips the handshake; a factory is asked for one per connection
   * attempt, which a reconnection needs.
   *
   * Deliberately narrow, so a later release can widen it without breaking an
   * implementation written today. Its host key is checked by whoever made it.
   */
  readonly connection: SshConnection;
  /** Left out: the supplied client is authenticated already. */
  readonly guest?: never;
  /** Left out: the supplied client is authenticated already. */
  readonly username?: never;
  /** Left out: the supplied client is authenticated already. */
  readonly password?: never;
  /** Left out: the supplied client's host key is checked by whoever made it. */
  readonly hostKey?: never;
  /** Left out: the supplied client's host key is checked by whoever made it. */
  readonly knownHosts?: never;
  /** Left out: the supplied client's host key is checked by whoever made it. */
  readonly insecureIgnoreHostKey?: never;
}

/**
 * How a ServerQuery over SSH is reached, without the cancellation: one of
 * {@link SshDialOptions} and {@link SshSuppliedConnectionOptions}.
 *
 * What a `QueryClient`'s `ssh` transport is built from, so that the two cannot
 * drift apart.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshConnectOptions = SshDialOptions | SshSuppliedConnectionOptions;

/**
 * Where a ServerQuery over SSH listens, who logs in, and how the server's host
 * key is checked.
 *
 * One of two shapes. The usual one, {@link SshDialOptions}, takes the host, the
 * login and exactly one of `hostKey`, `knownHosts` and `insecureIgnoreHostKey`:
 * there is no default, because the login is a credential and a client that
 * accepts any key hands it to whatever answers the port. The other,
 * {@link SshSuppliedConnectionOptions}, takes an SSH client you connected
 * yourself, and no login or policy.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type SshOptions = SshConnectOptions & {
  /** Abandons the connection attempt. */
  readonly signal?: AbortSignal | undefined;
};

/** How the host key is to be decided, once the options have been read. */
export type HostKeyDecision =
  | { readonly kind: "verifier"; readonly verify: SshHostKeyVerifier }
  | { readonly kind: "knownHosts"; readonly path: string }
  | { readonly kind: "insecure" }
  /** The caller supplied the connection, so the key was theirs to check. */
  | { readonly kind: "connection" };

/**
 * What the decision reads. Every member is `unknown`: the types of
 * {@link SshOptions} already make a wrong combination a compile error, and this
 * is for the callers they do not reach, a JavaScript program or an `as` cast.
 */
export interface SshChoice {
  readonly hostKey?: unknown;
  readonly knownHosts?: unknown;
  readonly insecureIgnoreHostKey?: unknown;
  readonly connection?: unknown;
  readonly username?: unknown;
  readonly password?: unknown;
  readonly guest?: unknown;
}

/**
 * Read the trust decision out of the options, or refuse them.
 *
 * Fails closed: with none of the three there is no policy, and this throws
 * rather than choose one. Two is a `TypeError`, since a caller who passed both
 * has not decided which is authoritative. Runs when a client is built as well
 * as when it connects, so a missing decision is heard about before the first
 * attempt.
 *
 * The same rule as the types state, for the callers they do not reach.
 */
export function hostKeyDecision(options: SshChoice): HostKeyDecision {
  const { hostKey, knownHosts, insecureIgnoreHostKey, connection, username, password, guest } =
    options;
  if (hostKey !== undefined && typeof hostKey !== "function") {
    throw new TypeError("hostKey is a function that throws to refuse a host key");
  }
  if (knownHosts !== undefined && (typeof knownHosts !== "string" || knownHosts === "")) {
    throw new TypeError("knownHosts is the path of a known_hosts file");
  }
  if (insecureIgnoreHostKey !== undefined && insecureIgnoreHostKey !== true) {
    throw new TypeError(
      "insecureIgnoreHostKey is `true` or left out: it is a decision, not a switch to set to false",
    );
  }

  const given: string[] = [];
  if (hostKey !== undefined) given.push("hostKey");
  if (knownHosts !== undefined) given.push("knownHosts");
  if (insecureIgnoreHostKey !== undefined) given.push("insecureIgnoreHostKey");
  if (given.length > 1) {
    throw new TypeError(
      `${given.join(", ")} were given together; exactly one of hostKey, knownHosts and insecureIgnoreHostKey decides whether the host key is accepted`,
    );
  }
  if (connection !== undefined) {
    if (given.length > 0) {
      throw new TypeError(
        `${given[0]} has no effect with connection, which makes the connection itself: its host key is checked by whoever made it`,
      );
    }
    if (username !== undefined || password !== undefined || guest !== undefined) {
      throw new TypeError(
        "username, password and guest have no effect with connection, which is authenticated already: nothing would send them",
      );
    }
    return { kind: "connection" };
  }
  if (hostKey !== undefined) return { kind: "verifier", verify: hostKey as SshHostKeyVerifier };
  if (knownHosts !== undefined) return { kind: "knownHosts", path: knownHosts };
  if (insecureIgnoreHostKey !== undefined) return { kind: "insecure" };
  throw new Error(
    "the SSH host key has to be checked, and none of hostKey, knownHosts or insecureIgnoreHostKey was given: a query login is a credential, normally serveradmin's, and this client will not send it to a host it has not verified",
  );
}

/**
 * `ssh2`, or a `MissingDependencyError` naming it. Loaded on demand: it is an
 * optional peer dependency, so importing it at the top of this module would
 * make it a requirement of the whole entry point — including the TCP and
 * WebQuery transports, which need nothing but Node.
 */
async function loadSsh2(): Promise<{ Client: new () => SshClient }> {
  try {
    return await import("ssh2");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new MissingDependencyError();
    }
    throw error;
  }
}

/**
 * Open a ServerQuery over SSH.
 *
 * SSH logs in itself, so there is no `login` command to send afterwards: the
 * session is already the query account, and only `use` is left.
 *
 * The server's host key is checked first, by whichever of `hostKey`,
 * `knownHosts` and `insecureIgnoreHostKey` was given, and the password is sent
 * only to a server whose key was accepted. With none of them, or with two,
 * this rejects before anything is opened or dialled.
 */
export async function connectSsh(options: SshOptions): Promise<StreamTransport> {
  const { host, port = 10022, signal, connection } = options;
  const decision = hostKeyDecision(options);
  // The login is read only where this module dials: a supplied client is
  // authenticated already. Checked here, so a missing one fails before ssh2 is
  // loaded or anything is opened.
  const login = connection === undefined ? loginOf(options) : undefined;
  signal?.throwIfAborted();
  const verify = await verifierFor(decision, host, port);
  const ssh = await clientFor(connection);
  signal?.throwIfAborted();

  // What the caller's check said, so that the failure ssh2 reports for a
  // refused key can be told from any other and carry the reason.
  let refusal: Error | undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    const failed = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      ssh.end();
      failed(signal!.reason as Error);
    };
    const onAuthError = (error: Error): void => {
      if (refusal !== undefined) {
        failed(
          new SshHostKeyError(
            host,
            port,
            `the SSH host key of ${host}:${port} was not accepted, so no login was sent: ${refusal.message}`,
            { cause: refusal },
          ),
        );
        return;
      }
      // ssh2 reports a refused credential through `level`, which its types do
      // not name; a wrong password is the one that leaves the client unable to
      // authenticate rather than unable to reach the server.
      const level = (error as { level?: unknown }).level;
      failed(
        level === "client-authentication"
          ? new QueryAuthError(
              login!.username,
              `SSH authentication failed for ${login!.username}`,
              { cause: error },
            )
          : error,
      );
    };
    const openShell = (): void => {
      ssh.shell(false, (error, channel) => {
        if (error) {
          ssh.end();
          failed(error);
          return;
        }
        ssh.off("error", onAuthError);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        // `ssh2` reports a failure after the handshake on the connection, and the
        // stream closes with it.
        ssh.on("error", (failure) => channel.emit("error", failure));
        channel.once("close", () => ssh.end());
        resolve(new StreamTransport(channel, () => ssh.end()));
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (connection !== undefined) {
      // A client the caller handed over is one they say is connected, and one
      // from their own factory is dialled on their terms: neither is connected
      // here, and neither can be a wrong credential this module knows of.
      openShell();
      return;
    }
    ssh.once("error", onAuthError);
    ssh.once("ready", openShell);
    ssh.connect({
      host,
      port,
      // Set exactly when `connection` is not, and this is the dial path.
      username: login!.username,
      // Left out for a guest, so ssh2 offers no password at all.
      ...(login!.password === undefined ? {} : { password: login!.password }),
      readyTimeout: 10_000,
      hostVerifier: (blob) => {
        const outcome = decide(verify, host, port, blob);
        if (outcome !== undefined) refusal = outcome;
        return outcome === undefined;
      },
    });
  });
}

/**
 * Who logs in: the name and password given, or `guest` with none when
 * `guest: true` says so. Missing credentials are an error, never a guest.
 */
function loginOf(options: SshChoice): { username: string; password: string | undefined } {
  if (options.guest !== undefined) {
    if (options.guest !== true) {
      throw new TypeError("guest is `true` or left out: it is a decision, not a switch");
    }
    if (options.username !== undefined || options.password !== undefined) {
      throw new TypeError(
        "username and password were given with guest; a guest logs in as `guest` with no password",
      );
    }
    return { username: "guest", password: undefined };
  }
  const hint = "; to connect without a login, as a guest, set guest to true";
  return {
    username: nonEmptyString(options.username, "username", hint),
    password: nonEmptyString(options.password, "password", hint),
  };
}

function nonEmptyString(value: unknown, name: string, hint = ""): string {
  if (typeof value !== "string" || value === "")
    throw new TypeError(`${name} is a non-empty string${hint}`);
  return value;
}

/**
 * The check the options chose, ready to run: the caller's own, one over the
 * `known_hosts` file read now, or the one that accepts anything.
 *
 * A file that cannot be read or parsed is a failure to verify, and ends the
 * connection as a refused key does.
 */
async function verifierFor(
  policy: HostKeyDecision,
  host: string,
  port: number,
): Promise<SshHostKeyVerifier> {
  if (policy.kind === "verifier") return policy.verify;
  // `connection` never reaches a handshake of ours, so for it this is not asked.
  if (policy.kind !== "knownHosts") return () => {};

  let hosts: KnownHosts;
  try {
    hosts = KnownHosts.parse(await readFile(policy.path, "utf8"), policy.path);
  } catch (error) {
    throw new SshHostKeyError(
      host,
      port,
      `the host key of ${host}:${port} cannot be checked: ${(error as Error).message}`,
      { cause: error },
    );
  }
  return (key) => hosts.verify(key);
}

/**
 * Run the check on the key ssh2 found, returning why it was refused, or
 * `undefined` for a key it accepted.
 *
 * Everything that is not a plain return counts as a refusal: a throw, naturally,
 * but also an answer. A check that returns `false` was written in ssh2's
 * convention and means no; one that returns `true` means yes in that
 * convention, and a promise means whatever it later settles to. None of those
 * is the contract, and acting on a guess at which was meant is how a refused key
 * gets through, so each fails closed and says what to write instead.
 */
function decide(
  verify: SshHostKeyVerifier,
  host: string,
  port: number,
  blob: Uint8Array,
): Error | undefined {
  try {
    const key = new Uint8Array(blob);
    const answer: unknown = verify({
      host,
      port,
      keyType: keyTypeOf(key),
      key,
      fingerprint: fingerprintOf(key),
    });
    if (answer === undefined) return undefined;
    // A rejection nobody awaits would otherwise surface as an unhandled one.
    if (typeof (answer as { then?: unknown }).then === "function") {
      void Promise.resolve(answer).catch(() => {});
    }
    return new TypeError(
      "the hostKey check returned a value; it has to return nothing to accept the key and throw to refuse it, and be synchronous",
    );
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** The client to talk over: the caller's, their factory's, or a fresh `ssh2`. */
async function clientFor(connection: SshConnection | undefined): Promise<SshClient> {
  if (typeof connection === "function") return connection();
  if (connection !== undefined) return connection;
  const { Client } = await loadSsh2();
  return new Client();
}
