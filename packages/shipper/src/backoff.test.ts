import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.js';

describe('backoffDelay', () => {
  it('doubles from 5 s and caps at 5 minutes', () => {
    const noJitter = { jitter: () => 1 };
    expect(backoffDelay(0, noJitter)).toBe(5_000);
    expect(backoffDelay(1, noJitter)).toBe(10_000);
    expect(backoffDelay(2, noJitter)).toBe(20_000);
    expect(backoffDelay(4, noJitter)).toBe(80_000);
    expect(backoffDelay(9, noJitter)).toBe(300_000);
    expect(backoffDelay(20, noJitter)).toBe(300_000);
  });

  it('jitters inside [delay/2, delay) and never exceeds the cap', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const plain = Math.min(5_000 * 2 ** attempt, 300_000);
      for (let i = 0; i < 50; i += 1) {
        const d = backoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(plain / 2);
        expect(d).toBeLessThanOrEqual(plain);
        expect(d).toBeLessThanOrEqual(300_000);
      }
    }
  });

  it('honors custom base and cap', () => {
    expect(backoffDelay(0, { baseMs: 1_000, maxMs: 4_000, jitter: () => 1 })).toBe(1_000);
    expect(backoffDelay(3, { baseMs: 1_000, maxMs: 4_000, jitter: () => 1 })).toBe(4_000);
  });
});
