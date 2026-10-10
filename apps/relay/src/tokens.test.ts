import { describe, expect, it } from 'vitest';
import { newToken, tokenHash } from './tokens.js';

describe('relay tokens', () => {
  it('issues 256-bit secrets, url-safe, with a kind-and-version prefix', () => {
    const token = newToken('device');
    expect(token).toMatch(/^rvd1_[A-Za-z0-9_-]{43}$/);
  });

  it('prefixes the kind so an operator can tell token classes apart', () => {
    expect(newToken('device').startsWith('rvd1_')).toBe(true);
    expect(newToken('soc').startsWith('rvs1_')).toBe(true);
  });

  it('issues distinct secrets', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newToken('device')));
    expect(seen.size).toBe(100);
  });

  it('hashes to a stable 64-character hex digest', () => {
    expect(tokenHash('rvd1_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash('rvd1_abc')).toBe(tokenHash('rvd1_abc'));
    expect(tokenHash('rvd1_abc')).not.toBe(tokenHash('rvd1_abd'));
  });
});
