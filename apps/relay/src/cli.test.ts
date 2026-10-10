import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli, runAdmin, type CliIO } from './cli.js';
import { tokenHash } from './tokens.js';
import { RelayStore } from './store.js';

function fakeIo(): CliIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    now: () => 1_700_000_000_000,
    out,
    err,
  };
}

function newStore(): { store: RelayStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-relay-cli-'));
  return { store: new RelayStore(dir), dir };
}

/** The usage failure of a parse, or undefined when the command parsed. */
function usageOf(argv: string[]): string | undefined {
  const parsed = parseCli(argv);
  return 'usage' in parsed ? parsed.usage : undefined;
}

describe('parseCli', () => {
  it('parses serve and the admin commands', () => {
    expect(parseCli(['serve'])).toEqual({ command: 'serve' });
    expect(parseCli(['provision', '--device', 'laptop-1'])).toEqual({
      command: 'provision',
      kind: 'device',
      name: 'laptop-1',
    });
    expect(parseCli(['provision', '--soc', 'soc-1'])).toEqual({
      command: 'provision',
      kind: 'soc',
      name: 'soc-1',
    });
    expect(parseCli(['revoke', '--device', 'laptop-1'])).toEqual({
      command: 'revoke',
      kind: 'device',
      name: 'laptop-1',
    });
  });

  it('rejects usage that names nothing, both kinds, or an unknown command', () => {
    expect(usageOf([])).toBeDefined();
    expect(usageOf(['provision'])).toBeDefined();
    expect(usageOf(['provision', '--device', 'a', '--soc', 'b'])).toBeDefined();
    expect(usageOf(['fly', '--device', 'a'])).toBeDefined();
    // A missing name after the flag is the same as naming nothing.
    expect(usageOf(['revoke', '--device'])).toBeDefined();
  });
});

describe('runAdmin', () => {
  it('prints a device token once and stores only its hash', () => {
    const { store, dir } = newStore();
    try {
      const io = fakeIo();
      const code = runAdmin(['provision', '--device', 'laptop-1'], store, io);
      expect(code).toBe(0);
      // The secret goes to stdout exactly once; stderr explains, no secret.
      expect(io.out).toHaveLength(1);
      const token = (io.out[0] ?? '').trim();
      expect(token).toMatch(/^rvd1_/);
      expect(io.err.join('')).toContain('laptop-1');
      expect(io.err.join('')).not.toContain(token);
      // The stored record is the hash, not the token.
      expect(store.tokenByHash(tokenHash(token))?.kind).toBe('device');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints a SOC token once and revokes it', () => {
    const { store, dir } = newStore();
    try {
      const io = fakeIo();
      expect(runAdmin(['provision', '--soc', 'soc-1'], store, io)).toBe(0);
      const token = (io.out[0] ?? '').trim();
      expect(token).toMatch(/^rvs1_/);
      expect(io.err.join('')).not.toContain(token);

      const revokeIo = fakeIo();
      expect(runAdmin(['revoke', '--soc', 'soc-1'], store, revokeIo)).toBe(0);
      expect((revokeIo.out[0] ?? '').trim()).toContain('revoked 1 token(s) for soc soc-1');
      expect(store.tokenByHash(tokenHash(token))?.revokedAt).toBeDefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 2 with usage on bad input without touching the store', () => {
    const { store, dir } = newStore();
    try {
      const io = fakeIo();
      expect(runAdmin(['provision'], store, io)).toBe(2);
      expect(io.out).toEqual([]);
      expect(io.err.join('')).toContain('usage:');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
