import { resolveSrv } from "node:dns/promises";
import { createConnection } from "node:net";
import { ResolveSource } from "../types.js";
import type { ResolvedAddr } from "../types.js";
import { isIpAddress, joinHostPort, splitHostPort } from "../address.js";
import { abortable } from "../abort.js";
import { InvalidAddressError } from "../errors.js";

const TS_DNS_DEFAULT_PORT = 41144;
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

/** How the default resolver resolves. */
export interface ResolverOptions {
  /** Look dot-less names up at named.myteamspeak.com; off by default. */
  readonly nicknameLookup?: boolean | undefined;
}

export class Resolver {
  readonly #cache = new Map<string, ResolvedAddr[]>();
  readonly #nicknameLookup: boolean;

  constructor(options: ResolverOptions = {}) {
    this.#nicknameLookup = options.nicknameLookup ?? false;
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
      const nickAddr = await resolveNickname(host, signal);
      signal.throwIfAborted();
      if (nickAddr) return this.#resolve(nickAddr, signal, false);
    }

    // SRV _ts3._udp.<host>
    const srvResults = await this.#resolveSRV(host, signal);
    if (srvResults) return this.#setCache(inputAddr, srvResults);

    const domainList = getDomainList(host);

    // TSDNS via SRV _tsdns._tcp.<domain>
    const tsdnsSrv = await this.#resolveTSDNSSRV(domainList, host, signal);
    if (tsdnsSrv) {
      return this.#setCache(inputAddr, [{ addr: tsdnsSrv, source: ResolveSource.TSDNSSRV }]);
    }

    // TSDNS direct :41144
    const tsdnsDirect = await this.#resolveTSDNSDirect(domainList, host, signal);
    if (tsdnsDirect) {
      return this.#setCache(inputAddr, [{ addr: tsdnsDirect, source: ResolveSource.TSDNSDirect }]);
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

  async #resolveSRV(host: string, signal?: AbortSignal): Promise<ResolvedAddr[] | null> {
    try {
      const srvs = await abortable(resolveSrv(`_ts3._udp.${host}`), signal);
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
    signal?: AbortSignal,
  ): Promise<string | null> {
    for (const domain of domains) {
      try {
        const srvs = await abortable(resolveSrv(`_tsdns._tcp.${domain}`), signal);
        if (!srvs || srvs.length === 0) continue;
        for (const srv of orderSrvRecords(srvs)) {
          const tsdnsAddr = joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port));
          const result = await queryTSDNS(tsdnsAddr, queryHost, signal);
          if (result) return result;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async #resolveTSDNSDirect(
    domains: string[],
    queryHost: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Asked at once rather than in turn, so the probes cost one timeout in
    // all; the most specific domain's answer wins.
    const answers = await Promise.all(
      domains.map((domain) =>
        queryTSDNS(joinHostPort(domain, String(TS_DNS_DEFAULT_PORT)), queryHost, signal),
      ),
    );
    return answers.find((answer) => answer !== null) ?? null;
  }
}

// ---- Helpers ----------------------------------------------------------------

/** The part of an SRV record that decides the order they are tried in. */
interface SrvRecord {
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
export function orderSrvRecords<T extends SrvRecord>(
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

/** @internal Ask the nickname service for `nickname`'s address. */
export async function resolveNickname(
  nickname: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const url = new URL(NICKNAME_LOOKUP_URL);
    url.searchParams.set("name", nickname);
    const init: RequestInit = signal ? { signal } : {};
    const resp = await fetch(url.toString(), init);
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

/** @internal Ask the TSDNS server at `tsdnsAddr` for `queryHost`'s address. */
export function queryTSDNS(
  tsdnsAddr: string,
  queryHost: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const [host, portStr] = splitHostPortParts(tsdnsAddr);
  const port = parseInt(portStr, 10);

  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const finish = (answer: string | null): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(answer);
    };
    const onAbort = (): void => finish(null);
    const timeout = setTimeout(() => finish(null), TSDNS_TIMEOUT_MS);

    const socket = createConnection({ host, port, timeout: 2_000 }, () => {
      socket.write(`${queryHost}\n`);
    });

    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\n");
      if (idx >= 0 && idx < MAX_DISCOVERY_RESPONSE) {
        const line = Buffer.from(buf.slice(0, idx), "latin1").toString("utf8").trim();
        finish(!line || line === "404" || line === "errors" ? null : line);
      } else if (buf.length >= MAX_DISCOVERY_RESPONSE) {
        // No answer is that long.
        finish(null);
      }
    });

    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function splitHostPortParts(addr: string): [string, string] {
  const { host, port } = splitHostPort(addr);
  return [host, port];
}

function getDomainList(host: string): string[] {
  const parts = host.split(".");
  const list: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list.slice(0, 3);
}
