import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { StreamTransport } from "./stream.js";

/**
 * Opens the byte stream a raw ServerQuery connection runs over.
 *
 * Returns a `Duplex` rather than a `node:net` socket: naming a concrete
 * platform type here would bind the interface to Node's socket class for good,
 * and a caller supplying a TLS socket, a SOCKS proxy's socket or a test double
 * has no reason to hand back that particular class.
 */
export type TcpConnector = (host: string, port: number) => Duplex | Promise<Duplex>;

/** Where a raw ServerQuery listens. */
export interface TcpOptions {
  /** The server's host. */
  readonly host: string;
  /** The raw query port; 10011 by default. */
  readonly port?: number | undefined;
  /** Abandons the connection attempt. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Opens the connection. `net.createConnection` by default.
   *
   * The seam into the transport: supplying one lets an application route the
   * session through a TLS terminator or a SOCKS proxy, or drive it from
   * something that is not a socket at all. It is deliberately narrow, so that
   * a later release can widen what it hands back without breaking an
   * implementation written today.
   */
  readonly connect?: TcpConnector | undefined;
}

/**
 * Open a raw ServerQuery connection (`node:net`, 10011 by default).
 *
 * Resolves once the stream is connected; the server's banner is read and
 * dropped by the transport.
 */
export async function connectTcp(options: TcpOptions): Promise<StreamTransport> {
  const { host, port = 10011, signal, connect = defaultConnect } = options;
  signal?.throwIfAborted();
  const stream = await connect(host, port);
  await opened(stream, signal);
  return new StreamTransport(stream, undefined, { transport: "tcp", address: `${host}:${port}` });
}

/** A connected `node:net` socket, with whole lines sent as they are written. */
function defaultConnect(host: string, port: number): Duplex {
  const socket = createConnection({ host, port });
  // Whole lines are sent, and a query's answers are small: no waiting to
  // coalesce.
  socket.setNoDelay(true);
  return socket;
}

/**
 * Wait until the stream is connected, if it is not already.
 *
 * A `Duplex` a caller handed back may be open, still opening, or a test double
 * that is neither — `connecting` says which, and a stream without it counts as
 * open, since nothing else could report the moment it becomes usable.
 */
function opened(stream: Duplex, signal: AbortSignal | undefined): Promise<void> {
  const connecting = (stream as { readonly connecting?: boolean }).connecting;
  if (connecting !== true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => {
      stream.destroy();
      failed(signal!.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.once("error", failed);
    stream.once("connect", () => {
      stream.off("error", failed);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
