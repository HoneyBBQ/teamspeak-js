import { parseCommand } from "../core/internal.js";
import { ServerError } from "@honeybbq/teamspeak";
import { parseErrorCode } from "../core/internal.js";

import type { ResponseSpec } from "../core/internal.js";

export interface CommandResult {
  err: Error | null;
  data: Array<Record<string, string>>;
}

/** A row waiting for the `error` that says which command it answered. */
interface BufferedRow {
  /** The notification that carried it, or "" for a nameless data row. */
  readonly source: string;
  readonly params: Record<string, string>;
}

interface PendingCommand {
  readonly resolve: (result: CommandResult) => void;
  readonly spec: ResponseSpec | undefined;
  /** The request's value for `spec.correlated.key`, when there is one. */
  readonly correlation: string | undefined;
  /** The request's value for `spec.echoKey`, when there is one. */
  readonly echo: string | undefined;
  /** Correlated answers that arrived before the command's own `error`. */
  readonly correlated: Array<Record<string, string>>;
  /** The command's `error` result, held while its correlated answer is due. */
  settled?: CommandResult;
}

/**
 * Matches the server's answers to the commands that asked for them.
 *
 * The server handles one client's commands in order and closes each answer
 * with `error … return_code=N`, so every row seen since the previous `error`
 * belongs to command N. Rows are therefore held, tagged with where they came
 * from, until that `error` says whose they are — attributing them on arrival
 * would mean guessing which in-flight command the server is answering, and a
 * command can be registered here well before it is sent (it first waits on the
 * throttle and the middleware chain).
 *
 * A nameless row always belongs to the command. A notification row belongs to
 * it only if the command declared that notification as its answer (see
 * command/responses.ts): the same `notifyclientmoved` that answers nothing can
 * arrive between any two commands.
 *
 * The welcome sequence is the exception. The server pushes channellist,
 * channelgrouplist and the rest unprompted right after the handshake, before
 * `channellistfinished`; without the gate they would land in the first
 * command's answer as duplicate rows and a phantom cid=0.
 */
export class CommandTracker {
  readonly #pending = new Map<number, PendingCommand>();
  readonly #ownClientID: () => number;
  #nextRC = 0;
  #buffer: BufferedRow[] = [];
  #welcomeComplete = false;

  /** @param ownClientID the client's clid, for answers filtered by invoker. */
  constructor(ownClientID: () => number = () => 0) {
    this.#ownClientID = ownClientID;
  }

  register(
    spec?: ResponseSpec,
    correlation?: string,
    echo?: string,
  ): [rc: number, promise: Promise<CommandResult>] {
    this.#nextRC++;
    const rc = this.#nextRC;
    const promise = new Promise<CommandResult>((resolve) => {
      this.#pending.set(rc, { resolve, spec, correlation, echo, correlated: [] });
    });
    return [rc, promise];
  }

  unregister(rc: number): void {
    this.#pending.delete(rc);
  }

  /** Marks the end of the welcome sequence and drops what it left behind. */
  signalWelcomeComplete(): void {
    this.#welcomeComplete = true;
    this.#buffer = [];
  }

  /** Whether some in-flight command declared `name` as its answer. */
  expects(name: string): boolean {
    for (const p of this.#pending.values()) {
      if (p.spec?.notifications?.includes(name)) return true;
      if (p.spec?.correlated?.notifications.includes(name)) return true;
    }
    return false;
  }

  /** Hold a row until the next `error` says which command it answered. */
  buffer(params: Record<string, string>, source = ""): void {
    if (!this.#welcomeComplete) return;
    if (this.#pending.size === 0) return;
    this.#buffer.push({ source, params });
  }

  /**
   * Offer a notification to commands answered after their `error`.
   *
   * Matching is on the echoed request field, so it does not matter whether the
   * notification beats the `error` or follows it.
   */
  offerCorrelated(name: string, params: Record<string, string>): void {
    for (const [rc, p] of this.#pending) {
      const c = p.spec?.correlated;
      if (!c || p.correlation === undefined || !c.notifications.includes(name)) continue;
      if (params[c.key] !== p.correlation) continue;

      if (name === c.failure && (params["status"] ?? "0") !== "0") {
        const err = new ServerError(parseErrorCode(params["status"]), params["msg"] ?? "", {
          extraMessage: params["extra_msg"] || undefined,
        });
        this.#settle(rc, p, { err, data: [] });
        return;
      }
      p.correlated.push(params);
      if (p.settled) this.#settle(rc, p, { err: null, data: [...p.settled.data, ...p.correlated] });
      return;
    }
  }

  resolve(rc: number, err: Error | null): void {
    const rows = this.#buffer;
    this.#buffer = [];
    const p = this.#pending.get(rc);
    if (!p) return;

    const data = rows.filter((row) => this.#answers(p, row)).map((row) => row.params);
    if (err) {
      this.#settle(rc, p, { err, data });
      return;
    }
    // Answered after the error: hold the result until the answer arrives, or
    // the caller's timeout gives up on it.
    if (p.spec?.correlated && p.correlation !== undefined && p.correlated.length === 0) {
      p.settled = { err: null, data };
      return;
    }
    this.#settle(rc, p, { err: null, data: [...data, ...p.correlated] });
  }

  discardBuffer(): void {
    this.#buffer = [];
  }

  /**
   * Forget every command and fail it with `err`.
   *
   * Dropping them silently would leave each caller waiting out its full
   * timeout for an answer that can no longer come.
   */
  reset(err: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) p.resolve({ err, data: [] });
    this.#buffer = [];
    this.#welcomeComplete = false;
    this.#nextRC = 0;
  }

  #answers(p: PendingCommand, row: BufferedRow): boolean {
    if (row.source === "") return true;
    if (!p.spec?.notifications?.includes(row.source)) return false;
    if (p.spec.ownRowsOnly && row.params["invokerid"] !== String(this.#ownClientID())) return false;
    // A row that carries the key and names another value was meant for another
    // request; one that does not carry it is taken.
    const key = p.spec.echoKey;
    if (key === undefined || p.echo === undefined) return true;
    const value = row.params[key];
    return value === undefined || value === p.echo;
  }

  #settle(rc: number, p: PendingCommand, result: CommandResult): void {
    this.#pending.delete(rc);
    p.resolve(result);
  }
}

/**
 * Append the tracker's return_code to a command.
 *
 * The return_code belongs to the tracker: it is how an answer finds its
 * command, so a caller-supplied one would detach the command from its answer.
 * Checked as a parameter rather than as text, because a message body that
 * merely contains "return_code=" used to suppress the real one and time the
 * command out.
 */
export function appendReturnCode(cmd: string, rc: number): string {
  const params = parseCommand(cmd)?.params ?? {};
  if (Object.hasOwn(params, "return_code")) {
    throw new TypeError("commands must not carry their own return_code; the client assigns it");
  }
  return `${cmd} return_code=${rc}`;
}
