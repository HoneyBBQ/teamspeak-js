/**
 * Reconnection policy.
 *
 * A dropped connection is normal on a UDP voice session, so a bot that cannot
 * recover is not usable unattended. Reconnecting is opt-in rather than
 * automatic: a silent reconnect makes a dropped session look like a healthy
 * one, and a caller that wanted to know about the drop never finds out.
 *
 * Backoff is not a nicety here. TeamSpeak bans an IP that opens several
 * connections in quick succession — measured at roughly three, after which the
 * server answers `error id=3329` and refuses everything. A reconnect loop
 * without a delay therefore bans itself, and the ban outlasts the outage it was
 * recovering from.
 */

/** How long to wait before each attempt. */
export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds; above 0. */
  readonly initialDelayMs: number;
  /** Ceiling for the delay; it never grows past this. Above 0, and not below `initialDelayMs`. */
  readonly maxDelayMs: number;
  /** Multiplier applied after each failed attempt; 1 or more. */
  readonly factor: number;
  /**
   * Fraction of the delay to randomise, up to 1; 0 or below turns it off.
   *
   * A fleet of bots that drop together would otherwise retry in lockstep and
   * hit the server in a burst. Jitter spreads them out.
   */
  readonly jitter: number;
  /** Give up after this many consecutive failures. 0 means never give up; a whole number. */
  readonly maxAttempts: number;
}

/** One second, doubling, capped at a minute, with 20% jitter, never giving up. */
export const defaultBackoffPolicy: Readonly<BackoffPolicy> = Object.freeze({
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: 0,
});

/**
 * How a client reconnects after its connection drops. Supplying it, even as
 * `{}`, turns reconnecting on; a deliberate `disconnect()` never reconnects.
 */
export interface ReconnectOptions {
  /** Tuning for the retry delays; unset fields keep {@link defaultBackoffPolicy}'s. */
  readonly backoff?:
    | { readonly [K in keyof BackoffPolicy]?: BackoffPolicy[K] | undefined }
    | undefined;
  /**
   * Decide whether a given failure is worth retrying. Returning false stops the
   * loop. Each client provides its own default; the voice client's is
   * `defaultShouldRetry` in `@honeybbq/teamspeak/client`.
   */
  readonly shouldRetry?: ((error: Error | undefined, attempt: number) => boolean) | undefined;
}

/**
 * Compute the delay before an attempt.
 *
 * `attempt` is 1-based: the delay before the first retry is `initialDelayMs`,
 * give or take the jitter, and the delay never grows past `maxDelayMs`.
 */
export function backoffDelay(policy: Readonly<BackoffPolicy>, attempt: number): number {
  return jitteredDelay(policy, attempt, Math.random);
}

/** @internal The delay, with `random` supplying the jitter. */
export function jitteredDelay(
  policy: Readonly<BackoffPolicy>,
  attempt: number,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = policy.initialDelayMs * policy.factor ** exponent;
  const capped = Math.min(raw, policy.maxDelayMs);

  if (policy.jitter <= 0) return Math.round(capped);

  // Full jitter would ignore the computed delay; this keeps the trend while
  // spreading peers, so a whole fleet does not retry on the same millisecond.
  // Kept under the ceiling, which a caller reasonably reads as a promise.
  const spread = capped * Math.min(policy.jitter, 1);
  const delay = capped + (random() * 2 - 1) * spread;
  return Math.round(Math.max(0, Math.min(delay, policy.maxDelayMs)));
}

/**
 * The policy `options` asks for, with the defaults filled in. A value the
 * caller gave that cannot work is a RangeError, thrown when the client is made
 * rather than when the loop first runs: a delay of 0 or a NaN factor would
 * retry in a tight loop, and the flood ban that follows outlasts the outage.
 *
 * Accepted: delays above 0 (an unset `maxDelayMs` is raised to `initialDelayMs`
 * when that is larger than the default; one given below `initialDelayMs` is
 * refused), a factor of at least 1, a jitter of at most 1 (0 or below turns it
 * off), and a whole `maxAttempts` of 0 or more.
 */
export function resolveBackoffPolicy(options: ReconnectOptions): BackoffPolicy {
  const policy: Record<string, number> = { ...defaultBackoffPolicy };
  // An explicit undefined keeps the default, as an unset field does.
  const given = Object.entries(options.backoff ?? {}).filter(([, value]) => value !== undefined);
  for (const [key, value] of given) policy[key] = value as number;
  const resolved = policy as unknown as BackoffPolicy;
  const set = (key: keyof BackoffPolicy): boolean => given.some(([k]) => k === key);

  requireNumber(
    "initialDelayMs",
    resolved.initialDelayMs,
    "a number of milliseconds above 0",
    (v) => v > 0,
  );
  requireNumber(
    "maxDelayMs",
    resolved.maxDelayMs,
    "a number of milliseconds above 0",
    (v) => v > 0,
  );
  requireNumber("factor", resolved.factor, "a number from 1 up", (v) => v >= 1);
  requireNumber("jitter", resolved.jitter, "a number up to 1", (v) => v <= 1);
  requireNumber(
    "maxAttempts",
    resolved.maxAttempts,
    "a whole number, 0 or more",
    (v) => Number.isInteger(v) && v >= 0,
  );
  if (resolved.maxDelayMs < resolved.initialDelayMs) {
    if (set("maxDelayMs")) {
      throw new RangeError(
        `maxDelayMs (${resolved.maxDelayMs}) is below initialDelayMs (${resolved.initialDelayMs})`,
      );
    }
    return { ...resolved, maxDelayMs: resolved.initialDelayMs };
  }
  return resolved;
}

function requireNumber(
  name: string,
  value: unknown,
  expected: string,
  ok: (value: number) => boolean,
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !ok(value)) {
    throw new RangeError(`the backoff's ${name} is ${expected}, not ${String(value)}`);
  }
}
