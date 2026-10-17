import { request } from "node:http";
import { TeamspeakError } from "@honeybbq/teamspeak";
import { buildCommandOrdered, parseCommand, splitCommandRows } from "../core/internal.js";
import type { QueryTransport } from "./transport.js";

/**
 * A WebQuery request that failed with an HTTP status and no TeamSpeak error in
 * its answer: a wrong or missing api key, a server that is not a WebQuery. A
 * refusal from the server itself carries a TeamSpeak code and is a
 * `ServerError` instead.
 */
export class WebQueryHttpError extends TeamspeakError {
  /** {@inheritDoc @honeybbq/teamspeak!TeamspeakError.kind} */
  static override readonly kind: string = "WebQueryHttpError";
  static {
    Object.defineProperty(this.prototype, "name", {
      value: "WebQueryHttpError",
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  /** The HTTP status. */
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`WebQuery answered HTTP ${status}${statusText === "" ? "" : ` ${statusText}`}`);
    this.status = status;
  }
}

/**
 * Who a WebQuery request is made as: the owner of an api key, or a guest.
 *
 * TeamSpeak 6 beta13 and later run a request that carries no api key in the
 * `guest` scope, with the Guest Server Query group's permissions: `version`
 * and `whoami` answer, and a command outside the guest scope is refused with
 * 5120 ("command not allowed for guest access") over HTTP 401. A server
 * started with `--query-http-allow-guest=0` refuses a request without a key.
 *
 * A guest connection is a choice made out loud: a missing or empty `apiKey`
 * is an error and never becomes one.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export type WebCredentials =
  | {
      /** The api key, sent as `x-api-key`; it replaces `login`. */
      readonly apiKey: string;
      /** Left out: an api key is not a guest's. */
      readonly guest?: never;
    }
  | {
      /** Only `true` is a value: send no api key and run as the server's guest. */
      readonly guest: true;
      /** Left out: a guest sends no api key. */
      readonly apiKey?: never;
    };

/** How a WebQuery is reached. */
export type WebQueryOptions = WebCredentials & {
  /** The server's base URL, such as `http://127.0.0.1:10080`. */
  readonly url: string;
  /** The virtual server to address; `use` changes it. Unset addresses the instance. */
  readonly serverID?: number | bigint | undefined;
  /**
   * The `fetch` to use. By default a small one over `node:http`: the global
   * `fetch` refuses port 10080, WebQuery's own default, as a port the Fetch
   * standard blocks.
   */
  readonly fetch?: typeof fetch | undefined;
};

/** The answer WebQuery gives: rows, and the status of the command. */
interface WebAnswer {
  readonly body?: unknown;
  readonly status?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly extra_message?: unknown;
  };
}

/**
 * A {@link QueryTransport} over WebQuery, the HTTP interface of TeamSpeak 3
 * (3.12 and later) and TeamSpeak 6.
 *
 * Each command line becomes one request, `POST /<server>/<command>` with the
 * parameters as JSON, and the JSON answer is turned back into what a raw
 * connection would have sent: one line per row, then `error id=… msg=…`. The
 * client above sees one answer shape.
 *
 * WebQuery has no session, so two things differ. The api key replaces `login`,
 * which the server refuses; and `use` is answered here, by changing the server
 * the following requests address, since the server has no `use` either. It
 * also sends no notifications, so there is nothing to register for.
 */
export class WebQueryTransport implements QueryTransport {
  /** WebQuery has no session for the server to push a notification to. */
  readonly supportsNotifications = false;
  onLine: ((line: string) => void) | null = null;
  onClose: ((error: Error | undefined) => void) | null = null;

  #base: string;
  #apiKey: string | undefined;
  #prefix: string;
  #fetch: typeof fetch;
  #closed = false;

  constructor(options: WebQueryOptions) {
    this.#base = options.url.replace(/\/+$/, "");
    if (options.guest === true) {
      if (options.apiKey !== undefined) {
        throw new TypeError("apiKey and guest were given together; a guest sends no api key");
      }
    } else if (typeof options.apiKey !== "string" || options.apiKey === "") {
      throw new TypeError(
        "apiKey is a non-empty string; to connect without one, as a guest, set guest to true",
      );
    }
    this.#apiKey = options.apiKey;
    this.#prefix = options.serverID === undefined ? "" : `/${options.serverID}`;
    this.#fetch = options.fetch ?? httpFetch;
  }

  async send(line: string): Promise<void> {
    if (this.#closed) throw new Error("the query connection is closed");
    const rows = splitCommandRows(line)
      .map((row) => parseCommand(row))
      .filter((row) => row !== null);
    const name = rows[0]?.name ?? "";

    if (name === "use") {
      this.#use(rows[0]!.params);
      return;
    }

    const params = rows.map((row) => ({ ...row.params }));
    const response = await this.#fetch(`${this.#base}${this.#prefix}/${name}`, {
      method: "POST",
      headers: {
        ...(this.#apiKey === undefined ? {} : { "x-api-key": this.#apiKey }),
        "content-type": "application/json",
      },
      body: JSON.stringify(params.length === 1 ? params[0] : params),
    });

    let answer: WebAnswer | undefined;
    try {
      answer = (await response.json()) as WebAnswer;
    } catch {
      // Not JSON: nothing the server said about the command.
    }
    const code = answer?.status?.code;
    if (typeof code !== "number") throw new WebQueryHttpError(response.status, response.statusText);

    const body = answer?.body;
    for (const row of Array.isArray(body) ? body : []) {
      if (typeof row === "object" && row !== null) this.onLine?.(rowLine(row));
    }
    const message = answer?.status?.message;
    const extra = answer?.status?.extra_message;
    const tail = typeof extra === "string" && extra !== "" ? { extra_msg: extra } : {};
    this.onLine?.(
      buildCommandOrdered("error", [
        ["id", String(code)],
        ["msg", typeof message === "string" ? message : ""],
        ...Object.entries(tail),
      ]),
    );
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    this.onClose?.(undefined);
    return Promise.resolve();
  }

  /** `use sid=1`, or `use port=9987`, which WebQuery addresses as `/byport/9987`. */
  #use(params: Readonly<Record<string, string>>): void {
    const sid = params["sid"];
    const port = params["port"];
    if (sid !== undefined && /^\d+$/.test(sid)) this.#prefix = `/${sid}`;
    else if (port !== undefined && /^\d+$/.test(port)) this.#prefix = `/byport/${port}`;
    else {
      this.onLine?.(
        buildCommandOrdered("error", [
          ["id", "1538"],
          ["msg", "invalid parameter"],
        ]),
      );
      return;
    }
    this.onLine?.("error id=0 msg=ok");
  }
}

/** One answer row as a line of `key=value` fields; a field that is not text is written as text. */
function rowLine(row: object): string {
  const fields = Object.entries(row).map(
    ([key, value]) => [key, typeof value === "string" ? value : String(value)] as const,
  );
  // buildCommandOrdered writes a name first; a row has none.
  return buildCommandOrdered("", fields).slice(1);
}

/**
 * The part of `fetch` this transport uses, over `node:http`: a POST with a
 * string body, answered with a `Response`. Plain HTTP only, as WebQuery is.
 */
const httpFetch = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      { method: init.method, headers: init.headers as Record<string, string> },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body as string);
  })) as unknown as typeof fetch;
