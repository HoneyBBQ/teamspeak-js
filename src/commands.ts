import { ServerError } from "./errors.js";

export interface CommandResult {
  err: Error | null;
  data: Record<string, string>[];
}

/**
 * Tracks in-flight commands by return_code.
 *
 * The TS3/TS5 server sends a "welcome sequence" of unsolicited data immediately
 * after the connection handshake (channellist, channelclientlist, etc.). This
 * data arrives on the event loop AFTER we may have registered our first pending
 * RC, which would contaminate our command responses.
 *
 * Solution: gate all row buffering on a `#welcomeComplete` flag. The flag is
 * set when `notifycliententerview` for our own clid arrives — the last event
 * the TS3/TS5 server sends in its welcome sequence. Any data arriving before
 * that is silently discarded.
 */
export class CommandTracker {
  readonly #pending = new Map<number, (result: CommandResult) => void>();
  #nextRC = 0;
  #buffer: Record<string, string>[] = [];

  /**
   * Set to true when we receive `notifycliententerview` for our own clid,
   * which marks the end of the server's welcome sequence.
   */
  #welcomeComplete = false;

  register(): [rc: number, promise: Promise<CommandResult>] {
    this.#nextRC++;
    const rc = this.#nextRC;
    const promise = new Promise<CommandResult>((resolve) => {
      this.#pending.set(rc, resolve);
    });
    return [rc, promise];
  }

  unregister(rc: number): void {
    this.#pending.delete(rc);
  }

  /**
   * Called when `notifycliententerview` for our own clid arrives.
   * Marks the welcome sequence as complete and discards any accumulated data.
   */
  signalWelcomeComplete(): void {
    this.#welcomeComplete = true;
    this.#buffer = [];
  }

  /**
   * Buffer a data row from the server. Rows arriving before the welcome
   * sequence is complete are silently discarded to prevent contamination.
   */
  buffer(params: Record<string, string>): void {
    if (!this.#welcomeComplete) return;
    if (this.#pending.size === 0) return;
    this.#buffer.push(params);
  }

  resolve(rc: number, err: Error | null): void {
    const resolve = this.#pending.get(rc);
    if (!resolve) {
      this.#buffer = [];
      return;
    }
    const data = this.#buffer;
    this.#buffer = [];
    this.#pending.delete(rc);
    resolve({ err, data });
  }

  discardBuffer(): void {
    this.#buffer = [];
  }

  reset(): void {
    this.#pending.clear();
    this.#buffer = [];
    this.#welcomeComplete = false;
    this.#nextRC = 0;
  }
}

/**
 * Parse and handle an `error` command from the server.
 * Returns the error (or null on success) and the resolved return_code.
 */
export function parseServerError(params: Record<string, string>): {
  err: Error | null;
  rc: number | null;
} {
  const id = params["id"] ?? "0";
  const msg = params["msg"] ?? "";
  const rcStr = params["return_code"];

  let err: Error | null = null;
  if (id !== "0") {
    err = new ServerError(id, msg);
  }

  let rc: number | null = null;
  if (rcStr !== undefined && rcStr !== "") {
    const parsed = parseInt(rcStr, 10);
    if (!isNaN(parsed)) rc = parsed;
  }

  return { err, rc };
}

/**
 * Append a return_code parameter to a command string if not already present.
 */
export function appendReturnCode(cmd: string, rc: number): string {
  if (cmd.includes("return_code=")) return cmd;
  return `${cmd} return_code=${rc}`;
}
