import { CommandTimeoutError } from "@honeybbq/teamspeak";

/** A promise settled from outside. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Whoever awaits it sees the failure; one that settles before anyone does is not unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * `promise`, or a rejection when `timeoutMs` passes or `signal` aborts first;
 * a signal that has aborted already rejects at once. However it ends, the
 * timer and the listener on `signal` are gone.
 */
export function within<T>(
  promise: Promise<T>,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new CommandTimeoutError(command));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
