import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

/** How a WebQuery is reached. TS6 remains the default for backwards compatibility. */
export type WebQueryOptions =
  | (WebCredentials & {
      /** The server's base URL, such as `http://127.0.0.1:10080`. */
      readonly url: string;
      /** The virtual server to address; `use` changes it. TS3 QueryClient requires this selection. */
      readonly serverID?: number | bigint | undefined;
      /**
       * The `fetch` to use. By default a small one over `node:http` or `node:https`:
       * the global `fetch` refuses port 10080, WebQuery's own default, as a port
       * the Fetch standard blocks.
       */
      readonly fetch?: typeof fetch | undefined;
      readonly protocol?: "ts6";
    })
  | {
      /** The server's base URL, such as `http://127.0.0.1:10080`. */
      readonly url: string;
      /** The virtual server to address; `use` changes it. TS3 QueryClient requires this selection. */
      readonly serverID?: number | bigint | undefined;
      /**
       * The `fetch` to use. By default a small one over `node:http` or `node:https`:
       * the global `fetch` refuses port 10080, WebQuery's own default, as a port
       * the Fetch standard blocks.
       */
      readonly fetch?: typeof fetch | undefined;
      /** TeamSpeak 3's GET-based WebQuery. */
      readonly protocol: "ts3";
      /** TeamSpeak 3 WebQuery requires an api key and has no guest mode. */
      readonly apiKey: string;
      readonly guest?: never;
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
 * A {@link QueryTransport} over TeamSpeak 3 or TeamSpeak 6 WebQuery.
 *
 * TS6 commands become `POST /<server>/<command>` requests with JSON parameters.
 * TS3 commands become `GET /<server>/<command>?<parameters>` requests. Each
 * JSON answer is turned back into what a raw connection would have sent: one
 * line per row, then `error id=… msg=…`. The client above sees one answer shape.
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
  #protocol: "ts3" | "ts6";
  #prefix: string;
  #fetch: typeof fetch;
  #closed = false;

  constructor(options: WebQueryOptions) {
    this.#base = options.url.replace(/\/+$/, "");
    this.#protocol = options.protocol ?? "ts6";
    if (this.#protocol !== "ts3" && this.#protocol !== "ts6") {
      throw new TypeError('protocol is "ts3" or "ts6"');
    }
    if (this.#protocol === "ts3" && options.guest === true) {
      throw new TypeError("TeamSpeak 3 WebQuery does not support guest access");
    }
    if (this.#protocol === "ts3" && (typeof options.apiKey !== "string" || options.apiKey === "")) {
      throw new TypeError("TeamSpeak 3 WebQuery requires a non-empty apiKey");
    }
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
    const endpoint = `${this.#base}${this.#prefix}/${encodeURIComponent(name)}`;
    const request =
      this.#protocol === "ts3"
        ? {
            url: withQuery(endpoint, params),
            init: {
              method: "GET",
              headers: this.#headers(),
            } satisfies RequestInit,
          }
        : {
            url: endpoint,
            init: {
              method: "POST",
              headers: { ...this.#headers(), "content-type": "application/json" },
              body: JSON.stringify(params.length === 1 ? params[0] : params),
            } satisfies RequestInit,
          };
    const response = await this.#fetch(request.url, request.init);

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

  #headers(): Record<string, string> {
    return this.#apiKey === undefined ? {} : { "x-api-key": this.#apiKey };
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

/** TS3 WebQuery carries command parameters in the GET query string. */
function withQuery(
  endpoint: string,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): string {
  const entries = rows.flatMap((row) => Object.entries(row));
  if (entries.length === 0) return endpoint;

  const query = entries.map(([key, value]) => {
    const pair = new URLSearchParams([[key, value]]).toString();
    // The API documents flags without an equals sign, e.g. `?-topic&-icon`.
    return key.startsWith("-") && value === "" ? pair.slice(0, -1) : pair;
  });
  return `${endpoint}?${query.join("&")}`;
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
 * The part of `fetch` this transport uses, over `node:http` or `node:https`,
 * answered with a `Response`.
 */
const httpFetch = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const parsed = new URL(url);
    const request =
      parsed.protocol === "https:"
        ? httpsRequest
        : parsed.protocol === "http:"
          ? httpRequest
          : undefined;
    if (request === undefined) {
      reject(new TypeError("WebQuery URL protocol is http: or https:"));
      return;
    }
    const req = request(
      parsed,
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
    if (typeof init.body === "string") req.end(init.body);
    else req.end();
  })) as unknown as typeof fetch;
