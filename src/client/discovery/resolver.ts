import { resolveSrv } from "node:dns/promises";
import { createConnection } from "node:net";
import { ResolveSource } from "../types.js";
import type { AddrResolver, ResolvedAddr } from "../types.js";
import { isIpAddress, joinHostPort, splitHostPort } from "../address.js";
import { abortable } from "../abort.js";
import { TeamspeakError } from "@honeybbq/teamspeak";
import { InvalidAddressError } from "../errors.js";

const TS_DNS_DEFAULT_PORT = 41144;
/** What a TSDNS entry has for a port to say: the one the user gave. */
const PORT_PLACEHOLDER = ":$PORT";
const NICKNAME_LOOKUP_URL = "https://named.myteamspeak.com/lookup";
const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * How long resolution may take in all; past it, the address is used as given.
 * A Client holds any resolver, its own or a custom one, to the same budget.
 *
 * @internal
 */
export const RESOLVE_BUDGET_MS = 10_000;
/** How long one TSDNS server may take to answer. */
const TSDNS_TIMEOUT_MS = 3_000;

/**
 * The most a TSDNS server or the nickname service is read for. Either answers
 * with one short line; without a bound, one that kept sending would be held in
 * memory until the resolution budget ran out.
 */
export const MAX_DISCOVERY_RESPONSE: number = 8 * 1024;

/** An SRV record, as `resolveSrv` gives it. */
export interface SrvRecord {
  /** The target host; a trailing dot is allowed. */
  readonly name: string;
  /** The target's port. */
  readonly port: number;
  /** Lower is tried first. */
  readonly priority: number;
  /** Among records of one priority, the higher is tried first more often. */
  readonly weight: number;
}

/** How the default resolver resolves. */
export interface ResolverOptions {
  /** Look dot-less names up at named.myteamspeak.com; off by default. */
  readonly nicknameLookup?: boolean | undefined;
  /**
   * The nickname lookup endpoint, an http: or https: URL; the default is
   * `https://named.myteamspeak.com/lookup`. Used only with `nicknameLookup`:
   * setting it does not turn the lookup on. For a test double or a mirror of
   * the service. The name is sent as the `name` query parameter, and the first
   * line of the answer is the address. A URL that is not http: or https: throws
   * a TypeError.
   */
  readonly nicknameService?: string | URL | undefined;
  /**
   * Answers the SRV lookups, for DNS over HTTPS, another DNS server, or a
   * test; the default is the system's `resolveSrv`. It answers every SRV
   * lookup the resolver makes (`_ts3._udp.<host>` and `_tsdns._tcp.<domain>`),
   * called with the full name and the resolution's signal. A rejection or an
   * empty list means no record. One that ignores the signal cannot hold
   * resolution up. The host names in the answers, and the TSDNS servers'
   * names, are still looked up by the system.
   */
  readonly resolveSrv?:
    | ((name: string, options: { readonly signal: AbortSignal }) => Promise<readonly SrvRecord[]>)
    | undefined;
  /**
   * The `fetch` the nickname lookup uses, for a proxy or a test; the default
   * is the global `fetch`. Used only with `nicknameLookup`.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * The resolver a Client uses unless it is given another. It resolves as the
 * TeamSpeak application does, so on its own it shows where an address leads:
 * `await new Resolver().resolve("ts.example.com")`. Answers are kept for ten
 * minutes.
 */
export class Resolver implements AddrResolver {
  readonly #cache = new Map<string, ResolvedAddr[]>();
  readonly #nicknameLookup: boolean;
  readonly #nicknameService: URL;
  readonly #resolveSrv: NonNullable<ResolverOptions["resolveSrv"]>;
  readonly #fetch: ResolverOptions["fetch"];

  constructor(options: ResolverOptions = {}) {
    if (options.resolveSrv !== undefined && typeof options.resolveSrv !== "function") {
      throw new TypeError("resolveSrv is a function");
    }
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TypeError("fetch is a function");
    }
    this.#resolveSrv = options.resolveSrv ?? ((name) => resolveSrv(name));
    this.#fetch = options.fetch;
    this.#nicknameLookup = options.nicknameLookup ?? false;
    this.#nicknameService = parseNicknameService(options.nicknameService ?? NICKNAME_LOOKUP_URL);
  }

  /**
   * Resolve as the TeamSpeak application does: a server nickname (only with
   * `nicknameLookup`), then SRV, then TSDNS, then the address as given. The
   * whole resolution is bounded: past the budget, or when a step fails, the
   * address as given is the answer.
   */
  async resolve(
    inputAddr: string,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<ResolvedAddr[]> {
    if (!inputAddr) throw new InvalidAddressError(inputAddr, "empty address");
    const budget = AbortSignal.timeout(RESOLVE_BUDGET_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
    try {
      return await this.#resolve(inputAddr, signal, true);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!budget.aborted) throw error;
      const { host, port } = splitHostPort(inputAddr);
      return [{ addr: joinHostPort(host, port), source: ResolveSource.Direct }];
    }
  }

  async #resolve(
    inputAddr: string,
    signal: AbortSignal,
    nicknames: boolean,
  ): Promise<ResolvedAddr[]> {
    const cached = this.#getValidCache(inputAddr);
    if (cached) return cached;

    const { host, port } = splitHostPort(inputAddr);

    if (isIpAddress(host)) {
      return [{ addr: joinHostPort(host, port), source: ResolveSource.Direct }];
    }

    // A dot-less name may be a server nickname, which only the TeamSpeak
    // service can answer: asking it sends the name to a third party, so it is
    // opt-in. Otherwise the name is resolved like any host.
    if (nicknames && this.#nicknameLookup && !host.includes(".") && host !== "localhost") {
      const nickAddr = await resolveNickname(host, this.#nicknameService, signal, this.#fetch);
      signal.throwIfAborted();
      if (nickAddr) return this.#resolve(nickAddr, signal, false);
    }

    // SRV _ts3._udp.<host>
    const srvResults = await this.#resolveSRV(host, signal);
    if (srvResults) return this.#setCache(inputAddr, srvResults);

    const domainList = getDomainList(host);

    // TSDNS via SRV _tsdns._tcp.<domain>
    const tsdnsSrv = await this.#resolveTSDNSSRV(domainList, host, port, signal);
    if (tsdnsSrv.length > 0) {
      return this.#setCache(
        inputAddr,
        tsdnsSrv.map((addr) => ({ addr, source: ResolveSource.TSDNSSRV })),
      );
    }

    // TSDNS direct :41144
    const tsdnsDirect = await this.#resolveTSDNSDirect(domainList, host, port, signal);
    if (tsdnsDirect.length > 0) {
      return this.#setCache(
        inputAddr,
        tsdnsDirect.map((addr) => ({ addr, source: ResolveSource.TSDNSDirect })),
      );
    }

    signal.throwIfAborted();
    // Plain DNS fallback
    const fallback: ResolvedAddr[] = [
      { addr: joinHostPort(host, port), source: ResolveSource.Direct },
    ];
    return this.#setCache(inputAddr, fallback);
  }

  #getValidCache(inputAddr: string): ResolvedAddr[] | null {
    const cached = this.#cache.get(inputAddr);
    if (!cached || cached.length === 0) return null;
    const first = cached[0]!;
    if (first.expiry !== undefined && Date.now() > first.expiry.getTime()) return null;
    return cached;
  }

  #setCache(key: string, results: ResolvedAddr[]): ResolvedAddr[] {
    const expiry = new Date(Date.now() + CACHE_TTL_MS);
    const withExpiry = results.map((r) => ({ ...r, expiry }));
    this.#cache.set(key, withExpiry);
    return withExpiry;
  }

  /** One SRV lookup, however it is answered, ended by the signal. */
  async #srv(name: string, signal: AbortSignal): Promise<readonly SrvRecord[]> {
    return abortable(
      Promise.resolve().then(() => this.#resolveSrv(name, { signal })),
      signal,
    );
  }

  async #resolveSRV(host: string, signal: AbortSignal): Promise<ResolvedAddr[] | null> {
    try {
      const srvs = await this.#srv(`_ts3._udp.${host}`, signal);
      if (!srvs || srvs.length === 0) return null;
      return orderSrvRecords(srvs).map((srv) => ({
        addr: joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port)),
        source: ResolveSource.SRV,
      }));
    } catch {
      return null;
    }
  }

  async #resolveTSDNSSRV(
    domains: string[],
    queryHost: string,
    port: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    for (const domain of domains) {
      try {
        const srvs = await this.#srv(`_tsdns._tcp.${domain}`, signal);
        if (!srvs || srvs.length === 0) continue;
        for (const srv of orderSrvRecords(srvs)) {
          const tsdnsAddr = joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port));
          const result = await askTSDNS(tsdnsAddr, queryHost, port, signal);
          if (result.length > 0) return result;
        }
      } catch {
        continue;
      }
    }
    return [];
  }

  async #resolveTSDNSDirect(
    domains: string[],
    queryHost: string,
    port: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    // Asked at once rather than in turn, so the probes cost one timeout in
    // all; the most specific domain's answer wins.
    const answers = await Promise.all(
      domains.map((domain) =>
        askTSDNS(joinHostPort(domain, String(TS_DNS_DEFAULT_PORT)), queryHost, port, signal),
      ),
    );
    return answers.find((answer) => answer.length > 0) ?? [];
  }
}

/**
 * Ask one TSDNS server; a server that fails to answer is one with no answer,
 * so it never fails the resolution.
 */
async function askTSDNS(
  server: string,
  host: string,
  port: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    return normalizeTSDNSEntries(await lookupTSDNS(server, host, { signal }), port);
  } catch {
    return [];
  }
}

/**
 * Make each entry of a TSDNS answer a `host:port`, as TeamSpeak reads it: an
 * entry without a port means 9987, and the port `$PORT` means `port`, the one
 * the address being resolved had.
 *
 * @internal
 */
export function normalizeTSDNSEntries(entries: readonly string[], port: string): string[] {
  return entries.map((entry) => {
    if (entry.endsWith(PORT_PLACEHOLDER)) {
      const host = splitHostPort(entry.slice(0, -PORT_PLACEHOLDER.length)).host;
      return joinHostPort(host, port);
    }
    const target = splitHostPort(entry, "9987");
    return joinHostPort(target.host, target.port);
  });
}

// ---- Helpers ----------------------------------------------------------------

/** The part of an SRV record that decides the order they are tried in. */
interface SrvOrder {
  readonly priority: number;
  readonly weight: number;
}

/**
 * Put SRV records in the order RFC 2782 has a client try them: by priority,
 * lowest first, and within a priority by weighted random selection, so a
 * record of weight 2 is first twice as often as one of weight 1. Records of
 * weight 0 follow the others of their priority, in the order given. Node's
 * `resolveSrv` returns the records unsorted.
 *
 * @param random Returns a number in [0, 1); injected to make the order testable.
 * @internal
 */
export function orderSrvRecords<T extends SrvOrder>(
  records: readonly T[],
  random: () => number = Math.random,
): T[] {
  const byPriority = new Map<number, T[]>();
  for (const record of records) {
    const group = byPriority.get(record.priority);
    if (group) group.push(record);
    else byPriority.set(record.priority, [record]);
  }
  const ordered: T[] = [];
  for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
    const group = byPriority.get(priority)!;
    const weighted = group.filter((r) => r.weight > 0);
    const unweighted = group.filter((r) => r.weight <= 0);
    let sum = weighted.reduce((total, r) => total + r.weight, 0);
    while (weighted.length > 0) {
      const target = random() * sum;
      let running = 0;
      let pick = weighted.length - 1;
      for (let i = 0; i < weighted.length; i++) {
        running += weighted[i]!.weight;
        if (running > target) {
          pick = i;
          break;
        }
      }
      const [chosen] = weighted.splice(pick, 1);
      ordered.push(chosen!);
      sum -= chosen!.weight;
    }
    ordered.push(...unweighted);
  }
  return ordered;
}

function parseNicknameService(service: string | URL): URL {
  let url: URL;
  try {
    url = new URL(service);
  } catch {
    throw new TypeError(`nicknameService is not a URL: ${String(service)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`nicknameService is an http: or https: URL, not ${url.protocol}`);
  }
  return url;
}

/** @internal Ask the nickname service for `nickname`'s address. */
export async function resolveNickname(
  nickname: string,
  service: URL,
  signal?: AbortSignal,
  fetchImpl?: typeof globalThis.fetch,
): Promise<string | null> {
  try {
    const url = new URL(service);
    url.searchParams.set("name", nickname);
    const init: RequestInit = signal ? { signal } : {};
    const resp = await (fetchImpl ?? globalThis.fetch)(url.toString(), init);
    if (!resp.ok) return null;
    const text = await readLimited(resp, MAX_DISCOVERY_RESPONSE);
    const line = text.split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

/** A response body's first `limit` bytes, as text; the rest is not read. */
async function readLimited(resp: Response, limit: number): Promise<string> {
  if (resp.body === null) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, limit - size);
      chunks.push(part);
      size += part.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ask a TSDNS server where `host` is. The answer is the server's targets in
 * its order and as it sent them: an entry may have no port, which TeamSpeak
 * takes as 9987, or the literal port `$PORT`, the port the user gave (9987 by
 * default). {@link Resolver} applies both. A name the server has no record for
 * gives an empty list.
 *
 * The answer ends at its first line break or when the server closes the
 * connection, whichever comes first. It rejects when the connection fails,
 * when no answer completes within three seconds or grows past 8 KiB, and with
 * the signal's reason when it aborts.
 *
 * @param server - The TSDNS server, `host` or `host:port`; the port defaults to 41144.
 * @param host - The name to look up; it is sent without a port.
 */
export function lookupTSDNS(
  server: string,
  host: string,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<string[]> {
  const { signal } = options;
  const target = splitHostPort(server, String(TS_DNS_DEFAULT_PORT));
  const port = parseInt(target.port, 10);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: unknown, answer?: string[]): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(answer ?? []);
    };
    const answerOf = (bytes: Buffer): string[] => {
      const line = bytes.toString("utf8").trim();
      return !line || line === "404" || line === "errors" ? [] : line.split(/\s+/);
    };
    const timedOut = (): void =>
      finish(new TeamspeakError(`the TSDNS server ${server} did not answer in time`));
    const onAbort = (): void => finish(signal?.reason);
    const timeout = setTimeout(timedOut, TSDNS_TIMEOUT_MS);

    const socket = createConnection({ host: target.host, port, timeout: 2_000 }, () => {
      socket.write(`${host}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      chunks.length = 0;
      chunks.push(all);
      const idx = all.indexOf(0x0a);
      if (idx >= 0 && idx < MAX_DISCOVERY_RESPONSE) {
        finish(undefined, answerOf(all.subarray(0, idx)));
      } else if (size >= MAX_DISCOVERY_RESPONSE) {
        // No answer is that long.
        finish(
          new TeamspeakError(
            `the TSDNS server ${server} sent ${MAX_DISCOVERY_RESPONSE} bytes without ending its answer`,
          ),
        );
      }
    });
    socket.on("end", () => finish(undefined, answerOf(Buffer.concat(chunks))));
    socket.on("error", (error) => finish(error));
    socket.on("timeout", timedOut);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getDomainList(host: string): string[] {
  const parts = host.split(".");
  const list: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list.slice(0, 3);
}
