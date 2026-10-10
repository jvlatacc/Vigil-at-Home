/**
 * A token-bucket limiter keyed by bearer-token hash — the agent socket's
 * discipline: a steady per-second rate with room for bursts, checked before
 * any request body is read.
 */
const MAX_KEYS = 65_536;
const PRUNE_EVERY_MS = 60_000;
/** A key idle this long is forgotten (prune keeps the map bounded). */
const IDLE_KEY_MS = 300_000;

interface Bucket {
  tokens: number;
  at: number;
}

export class KeyedBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private lastPrune = 0;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
  ) {}

  /** True when the key may proceed; refills continuously with elapsed time. */
  allow(key: string, now: number): boolean {
    if (this.buckets.size > MAX_KEYS && now - this.lastPrune > PRUNE_EVERY_MS) {
      this.prune(now);
    }
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsed / 1000) * this.perSecond);
    bucket.at = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > IDLE_KEY_MS) this.buckets.delete(key);
    }
    this.lastPrune = now;
  }
}
