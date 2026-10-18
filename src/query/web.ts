import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { TeamspeakError } from "@honeybbq/teamspeak";
import { buildCommandOrdered, parseCommand, splitCommandRows } from "../core/internal.js";
import type { QueryTransport, QueryTransportStats } from "./transport.js";

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
  /**
   * The server's base URL, such as `http://127.0.0.1:10080` or
   * `https://ts.example.com:10443`. The default `fetch` speaks `http:` and
   * `https:` and refuses any other scheme.
   */
  readonly url: string;
  /**
   * The virtual server to address; `use` changes it. Unset leaves the server out
   * of the path, which TeamSpeak 6 reads as the instance. TeamSpeak 3 runs every
   * command on a virtual server even then, so an instance command such as
   * `queryloginadd client_login_name=…` answers 1539 there.
   */
  readonly serverID?: number | bigint | undefined;
  /**
   * The `fetch` to use. By default a small one over `node:http` for an `http:`
   * URL and `node:https` for an `https:` one: the global `fetch` refuses port
   * 10080, WebQuery's own default, as a port the Fetch standard blocks.
   *
   * Over HTTPS the default verifies the server's certificate against the
   * trust store Node uses, and never skips that. A server whose certificate
   * comes from a private CA, or is self-signed, is trusted one of two ways:
   * start Node with `NODE_EXTRA_CA_CERTS=ca.pem`, or pass a `fetch` that
   * trusts the CA, such as one over `node:https` with an `https.Agent` whose
   * `ca` is that certificate.
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
  #openedAt = new Date();
  #bytesSent = 0;
  #bytesReceived = 0;

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
    if (options.fetch === undefined) {
      const { protocol } = new URL(options.url);
      if (protocol !== "http:" && protocol !== "https:") {
        throw new TypeError(
          `WebQuery is reached over http: or https:, not ${protocol}; pass a fetch to use another scheme`,
        );
      }
    }
    this.#fetch = options.fetch ?? nodeFetch;
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
    const body = JSON.stringify(params.length === 1 ? params[0] : params);
    const response = await this.#fetch(`${this.#base}${this.#prefix}/${name}`, {
      method: "POST",
      headers: {
        ...(this.#apiKey === undefined ? {} : { "x-api-key": this.#apiKey }),
        "content-type": "application/json",
      },
      body,
    });
    this.#bytesSent += Buffer.byteLength(body);

    let answer: WebAnswer | undefined;
    try {
      const text = await response.text();
      this.#bytesReceived += Buffer.byteLength(text);
      answer = JSON.parse(text) as WebAnswer;
    } catch {
      // Not JSON: nothing the server said about the command.
    }
    const code = answer?.status?.code;
    if (typeof code !== "number") throw new WebQueryHttpError(response.status, response.statusText);

    const rowsBody = answer?.body;
    for (const row of Array.isArray(rowsBody) ? rowsBody : []) {
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

  stats(): QueryTransportStats {
    // The base URL as given, without a user or password a caller put in it.
    const url = new URL(this.#base);
    url.username = "";
    url.password = "";
    return {
      connectedAt: this.#openedAt,
      transport: "web",
      address: url.toString().replace(/\/+$/, ""),
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
    };
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
 * The part of `fetch` this transport uses, over `node:http` or `node:https`
 * by the URL's scheme: a POST with a string body, answered with a `Response`.
 * An HTTPS certificate is verified the way Node does by default.
 */
const nodeFetch = ((url: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const request = new URL(url).protocol === "https:" ? httpsRequest : httpRequest;
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
