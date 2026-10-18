/**
 * What a connection reports about itself, enough for a metrics exporter to
 * publish without reaching into the client.
 *
 * @experimental Part of the `@honeybbq/teamspeak/query` entry, which may
 * change in a minor release.
 */
export interface QueryTransportStats {
  /** When the current connection was opened; undefined when there is none. */
  readonly connectedAt: Date | undefined;
  /** The kind of connection; undefined when there is none, or for a transport that does not say. */
  readonly transport: "tcp" | "ssh" | "web" | undefined;
  /**
   * Where it points: `host:port` for raw TCP, `user@host:port` for SSH, the
   * base URL for WebQuery. Never a password or an api key; "" when there is
   * no connection.
   */
  readonly address: string;
  /**
   * What the line protocol has written, line terminators included; for
   * WebQuery, the request bodies. It is what the transport sent, not what the
   * socket did: headers and retries are not counted.
   */
  readonly bytesSent: number;
  /**
   * What the server has sent, banner included: the bytes read from the stream
   * for raw TCP and SSH, the response bodies for WebQuery.
   */
  readonly bytesReceived: number;
}

/**
 * The connection a ServerQuery client talks over.
 *
 * ServerQuery is a line protocol on three transports: raw TCP (10011), SSH
 * (10022) and an HTTP WebQuery (10080) that frames each command as a request.
 * WebQuery and SSH are served by TeamSpeak 3 (3.12 and 3.3 or later) as well as
 * TeamSpeak 6. The client depends on this interface only, so each transport is
 * a separate piece, and a test or a proxy can supply its own.
 */
export interface QueryTransport {
  /**
   * Whether this connection can receive notifications at all.
   *
   * Raw TCP and SSH can: the server pushes `notify…` lines down the same
   * connection whenever it likes. WebQuery cannot — it has no session for the
   * server to push to, and refuses `servernotifyregister` with 5120 — so it
   * reports false.
   *
   * A custom transport declares its own truth here rather than leaving the
   * caller to guess: a client uses it to decide whether to register for
   * notifications at all, and whether a listener for a server event can ever
   * run.
   */
  readonly supportsNotifications: boolean;
  /** Send one command line; the transport adds the line terminator. */
  send(line: string): Promise<void>;
  /**
   * Called with each line the server sends, without its terminator, in the
   * order received.
   */
  onLine: ((line: string) => void) | null;
  /** Called once when the connection ends, with the cause unless it was `close()`. */
  onClose: ((error: Error | undefined) => void) | null;
  /** End the connection. */
  close(): Promise<void>;
  /**
   * What the connection reports about itself, for `QueryClient.stats`. A
   * transport that does not keep counts leaves it out.
   */
  stats?(): QueryTransportStats;
}
