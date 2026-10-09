import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ShipRecord } from './wire.js';

/**
 * SQLite schema, applied in order and tracked with `PRAGMA user_version`,
 * like the app's store. Each stream row keeps the zod-validated record body
 * as JSON plus the columns we filter, sort or dedupe on. Append new
 * migrations; never edit a shipped one.
 */
const migrations: string[] = [
  `
  CREATE TABLE events (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX events_ts ON events (ts);

  CREATE TABLE alerts (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX alerts_ts ON alerts (ts);

  CREATE TABLE actions (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX actions_ts ON actions (ts);

  -- One rules snapshot per device: the newest version wins, older ones are
  -- state, not a stream, so they don't take part in stream retention.
  CREATE TABLE rule_snapshots (
    device_id TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  `,
];

/** What one batch did, plus the relay's position after it. */
export interface BatchOutcome {
  accepted: number;
  duplicates: number;
  cursor: DevicePosition;
}

export interface DevicePosition {
  ts: number;
  id: string;
}

export interface RelayStats {
  events: number;
  alerts: number;
  actions: number;
  rules: number;
  usageBytes: number;
}

/**
 * The relay's store-and-forward state: per-device streams of events, alerts,
 * actions and rules snapshots, in WAL mode like every Vigil database.
 * Writes are batch-atomic; replayed records are absorbed by the
 * (device_id, id) primary keys, so a shipper that replays after a crash
 * loses nothing and stores nothing twice.
 */
export class RelayStore {
  private readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly insertEvent: StatementSync;
  private readonly insertAlert: StatementSync;
  private readonly insertAction: StatementSync;
  private readonly upsertRule: StatementSync;

  constructor(dataDir: string) {
    // House pattern for private state (the agent socket's privateDir):
    // create it 0700 and make sure it stays that way.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'relay.db'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
    // Lets eviction return pages to the disk after the cap evicts rows; a
    // no-op until the first VACUUM on databases that predate this pragma.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.migrate();
    this.insertEvent = this.db.prepare(
      'INSERT OR IGNORE INTO events (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
    );
    this.insertAlert = this.db.prepare(
      'INSERT OR IGNORE INTO alerts (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
    );
    this.insertAction = this.db.prepare(
      'INSERT OR IGNORE INTO actions (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
    );
    this.upsertRule = this.db.prepare(
      `INSERT INTO rule_snapshots (device_id, id, version, ts, body) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         id = excluded.id, version = excluded.version, ts = excluded.ts, body = excluded.body
       WHERE excluded.version > rule_snapshots.version`,
    );
  }

  /**
   * Applies a batch atomically: either every record lands (fresh or counted
   * as an already-stored duplicate) or nothing does.
   */
  applyBatch(deviceId: string, records: readonly ShipRecord[], _now: number): BatchOutcome {
    let accepted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN');
    try {
      for (const record of records) {
        const body = JSON.stringify(record.body);
        const applied =
          record.r === 'event'
            ? this.insertEvent.run(deviceId, record.id, record.ts, body)
            : record.r === 'alert'
              ? this.insertAlert.run(deviceId, record.id, record.ts, body)
              : record.r === 'action'
                ? this.insertAction.run(deviceId, record.id, record.ts, body)
                : this.upsertRule.run(deviceId, record.id, record.version, record.ts, body);
        if (Number(applied.changes) > 0) {
          accepted += 1;
        } else {
          duplicates += 1;
        }
      }
      const cursor = advanceCursor(records);
      this.db.exec('COMMIT');
      return { accepted, duplicates, cursor };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): RelayStats {
    return {
      events: this.count('events'),
      alerts: this.count('alerts'),
      actions: this.count('actions'),
      rules: this.count('rule_snapshots'),
      usageBytes: this.diskUsageBytes(),
    };
  }

  /** Bytes the database occupies (pages, including free pages pending vacuum). */
  diskUsageBytes(): number {
    const row = this.db.prepare('PRAGMA page_count').get() as { page_count: number };
    const size = this.db.prepare('PRAGMA page_size').get() as { page_size: number };
    return Number(row.page_count) * Number(size.page_size);
  }

  /** The journal mode, for status output and tests ('wal' in every real run). */
  journalMode(): string {
    const row = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return row.journal_mode;
  }

  close(): void {
    this.db.close();
  }

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (const [index, script] of migrations.entries()) {
      if (index < row.user_version) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(script);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }
}

/**
 * The position to ack: the newest record of the batch. The cursor advances
 * only on ack, and duplicates were stored before, so this covers replays.
 */
function advanceCursor(records: readonly ShipRecord[]): DevicePosition {
  let cursor: DevicePosition = { ts: 0, id: '' };
  for (const record of records) {
    if (record.ts > cursor.ts || (record.ts === cursor.ts && record.id > cursor.id)) {
      cursor = { ts: record.ts, id: record.id };
    }
  }
  return cursor;
}
