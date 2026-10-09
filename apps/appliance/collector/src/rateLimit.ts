/**
 * Fixed-window rate limiter for log spam control: a malformed-datagram flood
 * must not turn into a log flood. Pure time is injected for tests.
 */
export class RateLimiter {
  private windowStart = 0;
  private admitted = 0;

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when this event may be logged now; false when the window is spent. */
  admit(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.admitted = 0;
    }
    if (this.admitted >= this.maxPerWindow) return false;
    this.admitted += 1;
    return true;
  }
}
