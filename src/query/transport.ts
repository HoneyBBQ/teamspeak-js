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
}
