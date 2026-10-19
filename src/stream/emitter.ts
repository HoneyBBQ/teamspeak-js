import type { Unsubscribe } from "@honeybbq/teamspeak";

/** How many events are kept for a first listener, per event. */
const MAX_KEPT = 256;

/**
 * A small event emitter whose events can wait for their first listener.
 *
 * The events named in `keep` are held while nobody has ever listened to them,
 * up to 256 per event (the oldest are dropped past that), and delivered, in
 * order, to the first listener. That is what bridges the time between being
 * handed an object and attaching to it, in which the server does not wait.
 */
export class Emitter<M extends object> {
  #listeners = new Map<keyof M, Array<(payload: never) => void>>();
  #kept = new Map<keyof M, unknown[]>();
  #attached = new Set<keyof M>();
  readonly #keep: ReadonlySet<keyof M>;

  constructor(keep: ReadonlyArray<keyof M> = []) {
    this.#keep = new Set(keep);
  }

  on<K extends keyof M>(event: K, listener: (payload: M[K]) => void): Unsubscribe {
    const stored = listener as (payload: never) => void;
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), stored]);
    const unsubscribe = (): void => {
      const list = this.#listeners.get(event) ?? [];
      this.#listeners.set(
        event,
        list.filter((l) => l !== stored),
      );
    };
    if (!this.#attached.has(event)) {
      this.#attached.add(event);
      const kept = this.#kept.get(event) ?? [];
      this.#kept.delete(event);
      for (const payload of kept) call(listener, payload as M[K]);
    }
    return Object.assign(unsubscribe, { [Symbol.dispose]: unsubscribe });
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const list = this.#listeners.get(event);
    if (list === undefined || list.length === 0) {
      if (this.#keep.has(event) && !this.#attached.has(event)) {
        const kept = this.#kept.get(event) ?? [];
        kept.push(payload);
        if (kept.length > MAX_KEPT) kept.shift();
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
