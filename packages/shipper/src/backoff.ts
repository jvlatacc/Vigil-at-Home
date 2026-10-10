/**
 * The retry schedule for a failed push: 5 s doubling per consecutive failure,
 * capped at 5 minutes, jittered so a fleet of laptops does not retry in
 * unison after a relay outage. Pure; the engine injects the jitter source so
 * tests can pin it.
 */
export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs?: number;
  /** Longest delay any retry waits. */
  maxMs?: number;
  /** Source of randomness in [0, 1); defaults to Math.random. */
  jitter?: () => number;
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 5_000,
  maxMs: 5 * 60_000,
  jitter: Math.random,
};

/**
 * How long to wait before the `attempt`-th retry (`0` for the first).
 * Jittered in [delay / 2, delay): never zero, never longer than the plain
 * doubling, and always inside the cap.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const jitter = options.jitter ?? DEFAULT_BACKOFF.jitter;
  const plain = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
  const roll = Math.min(Math.max(jitter(), 0), 1);
  return Math.round(plain * (0.5 + 0.5 * roll));
}
