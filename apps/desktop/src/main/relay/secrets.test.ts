import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayTokenStore } from './secrets.js';

/** XOR "encryption" so tests can see the file never holds the token in the clear. */
const testCipher = (available = true) => ({
  available: () => available,
  encrypt: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});

const TOKEN = 'rt_9f2c61b7d4e8a0531c7e';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const store = (available = true): { t: RelayTokenStore; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-relay-'));
  dirs.push(dir);
  const path = join(dir, 'relay-token.json');
  return { t: new RelayTokenStore(path, testCipher(available)), path };
};

describe('RelayTokenStore', () => {
  it('round-trips the token and shows only the last four characters', () => {
    const { t } = store();
    expect(t.saved()).toBe(false);
    t.set(TOKEN);
    expect(t.saved()).toBe(true);
    expect(t.get()).toBe(TOKEN);
    expect(t.last4()).toBe(TOKEN.slice(-4));
    expect(t.last4()).toHaveLength(4);
  });

  it('never writes the token in the clear', () => {
    const { t, path } = store();
    t.set(TOKEN);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(TOKEN);
    // Only the last four characters are kept alongside, for display.
    expect(raw).toContain(JSON.stringify(TOKEN.slice(-4)));
  });

  it('refuses to save when the keychain is unavailable', () => {
    const { t } = store(false);
    expect(t.canSave()).toBe(false);
    expect(() => t.set(TOKEN)).toThrow();
    expect(t.saved()).toBe(false);
  });

  it('replaces and clears', () => {
    const { t } = store();
    t.set(TOKEN);
    t.set('rt_replaced_token_0000');
    expect(t.get()).toBe('rt_replaced_token_0000');
    t.clear();
    expect(t.saved()).toBe(false);
    expect(t.get()).toBeUndefined();
  });

  it('treats a corrupt file as no token', () => {
    const { t, path } = store();
    t.set(TOKEN);
    writeFileSync(path, '{not json');
    expect(t.saved()).toBe(false);
    expect(t.get()).toBeUndefined();
  });
});
