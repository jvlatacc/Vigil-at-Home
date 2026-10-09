import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPrivateDatabase } from './private-db.js';

// getuid exists only where file modes mean something, so the tests do too.
const itPosix = process.getuid?.() === undefined ? it.skip : it;

describe('openPrivateDatabase', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `vigil-private-db-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  itPosix('creates the data dir 0700 and the database 0600', () => {
    const db = openPrivateDatabase(dir);
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'vigil.db')).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  itPosix('tightens a folder left at default modes by an earlier run', () => {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const db = openPrivateDatabase(dir);
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'vigil.db')).mode & 0o777).toBe(0o600);
    } finally {
      db.close();
    }
  });

  itPosix('tightens journal, WAL and shm siblings when present', () => {
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'vigil.db');
    for (const suffix of ['-journal', '-wal', '-shm']) writeFileSync(dbPath + suffix, '');
    const db = openPrivateDatabase(dir);
    try {
      for (const suffix of ['-journal', '-wal', '-shm']) {
        expect(statSync(dbPath + suffix).mode & 0o777).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });
});
