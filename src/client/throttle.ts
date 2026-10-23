interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/**
 * Token-bucket limiter for outbound TS3 commands.
 * Mirrors Go's commandThrottle.
 *
 * Waiters are released in the order they arrived: each used to poll for a
 * token on its own timer, so a command that came later could take the turn of
 * one that had waited longer, and the commands went out of order.
 */
export class CommandThrottle {
  static readonly TOKEN_RATE = 4.0; // tokens per second
  static readonly TOKEN_MAX = 8.0; // bucket capacity

  #tokens = 5.0;
  #lastUpdate = performance.now();
  /** Until when nothing is released: the server asked this client to wait. */
  #holdUntil = 0;
  readonly #waiters: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Wait for a token, behind every earlier waiter. Aborting `signal` rejects
   * with its reason and gives the place in line up; the abort listener is
   * removed however the wait ends.
   */
  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.#refill();
    if (this.#waiters.length === 0 && this.#tokens >= 1.0 && performance.now() >= this.#holdUntil) {
      this.#tokens -= 1.0;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          if (this.#waiters.length === 0) this.#stopTimer();
          reject(signal!.reason);
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#schedule();
    });
  }

  /**
   * Release nothing for `ms` milliseconds, then go on at the usual rate with no
   * burst saved up: the server refused a command as flooding and said when to
   * try again, and anything sent sooner is refused too and adds to the debt.
   */
  hold(ms: number): void {
    this.#refill();
    this.#holdUntil = Math.max(this.#holdUntil, performance.now() + ms);
    this.#tokens = 0;
    this.#stopTimer();
    this.#schedule();
  }

  /**
   * Reject every waiter still in line with `reason`, so none of them is ever
   * released to send. Commands that ask afterwards wait as before.
   */
  rejectAll(reason: unknown): void {
    this.#stopTimer();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(reason);
    }
  }

  #refill(): void {
    const now = performance.now();
    // Nothing accrues while held.
    const elapsed = Math.max(0, now - Math.max(this.#lastUpdate, this.#holdUntil)) / 1000;
    this.#tokens = Math.min(
      this.#tokens + elapsed * CommandThrottle.TOKEN_RATE,
      CommandThrottle.TOKEN_MAX,
    );
    this.#lastUpdate = now;
  }

  /** Arm the timer for when the next token is due, unless it already is. */
  #schedule(): void {
    if (this.#timer !== undefined || this.#waiters.length === 0) return;
    const forTokens =
      this.#tokens >= 1.0
        ? 0
        : Math.ceil(((1.0 - this.#tokens) / CommandThrottle.TOKEN_RATE) * 1000) + 10;
    const held = Math.ceil(this.#holdUntil - performance.now());
    // Tokens accrue only once the hold is over.
    const waitMs = Math.max(0, held) + forTokens;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#release();
    }, waitMs);
  }

  #stopTimer(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Hand the tokens there are to the waiters at the head of the line. */
  #release(): void {
    this.#refill();
    // Woken early, or the hold was extended meanwhile.
    if (performance.now() < this.#holdUntil) {
      this.#schedule();
      return;
    }
    while (this.#waiters.length > 0 && this.#tokens >= 1.0) {
      this.#tokens -= 1.0;
      const waiter = this.#waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
    this.#schedule();
  }
}
