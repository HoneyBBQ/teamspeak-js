import { resolveSrv } from "node:dns/promises";
import { createConnection } from "node:net";
import type { Logger } from "../types.js";
import type { ResolvedAddr } from "../types.js";
import { noopLogger } from "../types.js";

const TS_DNS_DEFAULT_PORT = 41144;
const NICKNAME_LOOKUP_URL = "https://named.myteamspeak.com/lookup";
const CACHE_TTL_MS = 10 * 60 * 1000;

export class Resolver {
  readonly #log: Logger;
  readonly #cache = new Map<string, ResolvedAddr[]>();

  constructor(log: Logger = noopLogger) {
    this.#log = log;
  }

  async resolve(inputAddr: string, signal?: AbortSignal): Promise<ResolvedAddr[]> {
    if (!inputAddr) throw new Error("empty address");

    const cached = this.#getValidCache(inputAddr);
    if (cached) return cached;

    const { host, port } = splitHostPort(inputAddr);

    if (isIpAddress(host)) {
      return [{ addr: joinHostPort(host, port), source: "Direct", expiry: new Date(0) }];
    }

    // Nickname resolution (no dots → not a domain)
    if (!host.includes(".") && host !== "localhost") {
      const nickAddr = await resolveNickname(host, signal);
      if (nickAddr) {
        return this.resolve(nickAddr, signal);
      }
    }

    // SRV _ts3._udp.<host>
    const srvResults = await this.#resolveSRV(host, signal);
    if (srvResults) return this.#setCache(inputAddr, srvResults);

    const domainList = getDomainList(host);

    // TSDNS via SRV _tsdns._tcp.<domain>
    const tsdnsSrv = await this.#resolveTSDNSSRV(domainList, host, signal);
    if (tsdnsSrv) {
      return this.#setCache(inputAddr, [
        { addr: tsdnsSrv, source: "TSDNS-SRV", expiry: new Date(0) },
      ]);
    }

    // TSDNS direct :41144
    const tsdnsDirect = await this.#resolveTSDNSDirect(domainList, host, signal);
    if (tsdnsDirect) {
      return this.#setCache(inputAddr, [
        { addr: tsdnsDirect, source: "TSDNS-Direct", expiry: new Date(0) },
      ]);
    }

    // Plain DNS fallback
    const fallback: ResolvedAddr[] = [
      { addr: joinHostPort(host, port), source: "Direct", expiry: new Date(0) },
    ];
    return this.#setCache(inputAddr, fallback);
  }

  #getValidCache(inputAddr: string): ResolvedAddr[] | null {
    const cached = this.#cache.get(inputAddr);
    if (!cached || cached.length === 0) return null;
    const first = cached[0]!;
    if (first.expiry.getTime() > 0 && Date.now() > first.expiry.getTime()) return null;
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
      const srvs = await withSignal(resolveSrv(`_ts3._udp.${host}`), signal);
      if (!srvs || srvs.length === 0) return null;
      return srvs.map((srv) => ({
        addr: joinHostPort(srv.name.replace(/\.$/, ""), String(srv.port)),
        source: "SRV",
        expiry: new Date(0),
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
        const srvs = await withSignal(resolveSrv(`_tsdns._tcp.${domain}`), signal);
        if (!srvs || srvs.length === 0) continue;
        for (const srv of srvs) {
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
    for (const domain of domains) {
      const tsdnsAddr = joinHostPort(domain, String(TS_DNS_DEFAULT_PORT));
      const result = await queryTSDNS(tsdnsAddr, queryHost, signal);
      if (result) return result;
    }
    return null;
  }
}

// ---- Helpers ----------------------------------------------------------------

async function resolveNickname(nickname: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const url = new URL(NICKNAME_LOOKUP_URL);
    url.searchParams.set("name", nickname);
    const init: RequestInit = signal ? { signal } : {};
    const resp = await fetch(url.toString(), init);
    if (!resp.ok) return null;
    const text = await resp.text();
    const line = text.split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

function queryTSDNS(
  tsdnsAddr: string,
  queryHost: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const [host, portStr] = splitHostPortParts(tsdnsAddr);
  const port = parseInt(portStr, 10);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 3_000);

    const socket = createConnection({ host, port, timeout: 2_000 }, () => {
      socket.write(`${queryHost}\n`);
    });

    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timeout);
        socket.destroy();
        const line = buf.slice(0, idx).trim();
        if (!line || line === "404" || line === "errors") resolve(null);
        else resolve(line);
      }
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          socket.destroy();
          resolve(null);
        },
        { once: true },
      );
    }
  });
}

function isIpAddress(host: string): boolean {
  // Simple IPv4 check; IPv6 would be inside brackets
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

function splitHostPort(addr: string): { host: string; port: string } {
  const lastColon = addr.lastIndexOf(":");
  if (lastColon < 0) return { host: addr, port: "9987" };
  const afterColon = addr.slice(lastColon + 1);
  if (/^\d+$/.test(afterColon)) {
    return { host: addr.slice(0, lastColon), port: afterColon };
  }
  return { host: addr, port: "9987" };
}

function splitHostPortParts(addr: string): [string, string] {
  const { host, port } = splitHostPort(addr);
  return [host, port];
}

function joinHostPort(host: string, port: string): string {
  if (host.includes(":")) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

function getDomainList(host: string): string[] {
  const parts = host.split(".");
  const list: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    list.push(parts.slice(i).join("."));
  }
  return list.slice(0, 3);
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    ),
  ]);
}
