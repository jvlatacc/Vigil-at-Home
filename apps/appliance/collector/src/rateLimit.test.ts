import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit';

describe('RateLimiter', () => {
  it('admits up to the per-window maximum, then blocks', () => {
    const t = 0;
    const limiter = new RateLimiter(3, 60_000, () => t);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false);
    expect(limiter.admit()).toBe(false);
  });

  it('admits again once the window has passed', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 60_000, () => t);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false);
    t = 60_000;
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false);
  });

  it('does not reset the window before a full window has passed', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 60_000, () => t);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(true);
    expect(limiter.admit()).toBe(false); // quota spent, window not yet elapsed
    t = 59_999;
    expect(limiter.admit()).toBe(false); // still inside the first window
    t = 60_000;
    expect(limiter.admit()).toBe(true); // new window
  });
});
