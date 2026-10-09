import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the app's database with file permissions that match what it stores.
 * The database records program paths and command lines, including secrets
 * users typed onto them, so it gets the same treatment as the agent socket
 * (agents/endpoint.ts privateDir): a 0700 folder and 0600 files. Journal and
 * WAL siblings are tightened when present — SQLite recreates them with the
 * database's own modes, so 0600 on the database is what keeps them private.
 *
 * Windows has no file modes; the endpoint code treats getuid's presence as
 * the POSIX test, and so does this.
 */
export function openPrivateDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, 'vigil.db');
  const db = new DatabaseSync(dbPath);
  if (process.getuid?.() === undefined) return db;
  // The mode in mkdirSync only applies to folders it creates: userData often
  // exists already (made by Electron or an earlier run), so chmod it too.
  chmodSync(dataDir, 0o700);
  chmodSync(dbPath, 0o600);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sibling = dbPath + suffix;
    if (existsSync(sibling)) chmodSync(sibling, 0o600);
  }
  return db;
}
