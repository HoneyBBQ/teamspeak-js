import type { Unsubscribe } from "@honeybbq/teamspeak";

/** How many events are kept for a first listener, per event. */
export const MAX_KEPT = 256;

/**
 * A small event emitter whose events can wait for their first listener.
 *
 * The events named in `keep` are held while nobody listens to them, before
 * the first listener and again after the last has unsubscribed, up to 256 per
 * event, and delivered, in order, to the next listener. Past that the oldest is
 * dropped, and `onDrop` hears of it. That is what bridges the time between
 * being handed an object and attaching to it, in which the server does not
 * wait.
 */
export class Emitter<M extends object> {
  #listeners = new Map<keyof M, Array<(payload: never) => void>>();
  #kept = new Map<keyof M, unknown[]>();
  readonly #keep: ReadonlySet<keyof M>;

  readonly #onDrop: ((event: keyof M) => void) | undefined;

  constructor(keep: ReadonlyArray<keyof M> = [], onDrop?: (event: keyof M) => void) {
    this.#keep = new Set(keep);
    this.#onDrop = onDrop;
  }

  on<K extends keyof M>(event: K, listener: (payload: M[K]) => void): Unsubscribe {
    const stored = listener as (payload: never) => void;
    const before = this.#listeners.get(event) ?? [];
    this.#listeners.set(event, [...before, stored]);
    const unsubscribe = (): void => {
      const list = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        list.filter((l) => l !== stored),
      );
    };
    if (before.length === 0) {
      const kept = this.#kept.get(event) ?? [];
      this.#kept.delete(event);
      for (const payload of kept) call(listener, payload as M[K]);
    }
    return Object.assign(unsubscribe, { [Symbol.dispose]: unsubscribe });
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const list = this.#listeners.get(event);
    if (list === undefined || list.length === 0) {
      if (this.#keep.has(event)) {
        const kept = this.#kept.get(event) ?? [];
        kept.push(payload);
        if (kept.length > MAX_KEPT) {
          kept.shift();
          this.#onDrop?.(event);
        }
        this.#kept.set(event, kept);
      }
      return;
    }
    for (const listener of list) call(listener as (payload: M[K]) => void, payload);
  }
}

/** Run a listener so that one that throws neither stops the others nor the caller; it surfaces as an uncaught exception, as from an EventEmitter. */
function call<P>(listener: (payload: P) => void, payload: P): void {
  try {
    listener(payload);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
