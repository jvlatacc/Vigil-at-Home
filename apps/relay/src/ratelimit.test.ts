import { describe, expect, it } from 'vitest';
import { KeyedBuckets } from './ratelimit.js';

describe('KeyedBuckets', () => {
  it('allows a burst, then refuses until refill', () => {
    const buckets = new KeyedBuckets(1, 3);
    const t0 = 1_000_000;
    expect(buckets.allow('k', t0)).toBe(true);
    expect(buckets.allow('k', t0)).toBe(true);
    expect(buckets.allow('k', t0)).toBe(true);
    expect(buckets.allow('k', t0)).toBe(false);
  });

  it('refills at the per-second rate', () => {
    const buckets = new KeyedBuckets(2, 1);
    const t0 = 1_000_000;
    expect(buckets.allow('k', t0)).toBe(true);
    expect(buckets.allow('k', t0 + 100)).toBe(false); // 0.2 tokens after 100 ms
    expect(buckets.allow('k', t0 + 600)).toBe(true); // 1.2 tokens after 600 ms
  });

  it('never exceeds the burst size on idle refill', () => {
    const buckets = new KeyedBuckets(1, 2);
    const t0 = 1_000_000;
    expect(buckets.allow('k', t0)).toBe(true);
    expect(buckets.allow('k', t0 + 60_000)).toBe(true);
    expect(buckets.allow('k', t0 + 60_000)).toBe(true);
    // A minute of idle refilled at most 2 (the burst), not 60.
    expect(buckets.allow('k', t0 + 60_000)).toBe(false);
  });

  it('limits keys independently', () => {
    const buckets = new KeyedBuckets(1, 1);
    expect(buckets.allow('a', 0)).toBe(true);
    expect(buckets.allow('b', 0)).toBe(true);
    expect(buckets.allow('a', 0)).toBe(false);
    expect(buckets.allow('b', 0)).toBe(false);
  });
});
