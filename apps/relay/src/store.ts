import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DeviceId, type ShipRecord } from './wire.js';
import { newToken, tokenHash, type TokenKind } from './tokens.js';

/**
 * SQLite schema, applied in order and tracked with `PRAGMA user_version`,
 * like the app's store. Each stream row keeps the zod-validated record body
 * as JSON plus the columns we filter, sort or dedupe on. There are no
 * foreign keys on purpose: revoking a device keeps its telemetry until
 * retention evicts it, so the SOC can still read what happened before.
 * Append new migrations; never edit a shipped one.
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
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    last_ts INTEGER,
    last_id TEXT
  );

  CREATE TABLE tokens (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- 'device' | 'soc'
    name TEXT NOT NULL,
    device_id TEXT,                -- device tokens only
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX tokens_device ON tokens (device_id);
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

/** A token row as the store sees it: hash at rest, secret never stored. */
export interface StoredToken {
  hash: string;
  kind: TokenKind;
  name: string;
  deviceId?: string | undefined;
  revokedAt?: number | undefined;
}

export interface RelayStats {
  devices: number;
  events: number;
  alerts: number;
  actions: number;
  rules: number;
  usageBytes: number;
}

type TokenRow = {
  hash: string;
  kind: string;
  name: string;
  device_id: string | null;
  created_at: number;
  revoked_at: number | null;
};

/**
 * The relay's store-and-forward state: enrolled devices, hashed tokens, and
 * per-device streams of events, alerts, actions and rules snapshots, in WAL
 * mode like every Vigil database. Writes are batch-atomic; replayed records
 * are absorbed by the (device_id, id) primary keys.
 */
export class RelayStore {
  private readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly findToken: StatementSync;
  private readonly insertDevice: StatementSync;
  private readonly insertToken: StatementSync;
  private readonly revokeSocTokensByName: StatementSync;
  private readonly revokeDeviceTokens: StatementSync;
  private readonly deleteDevice: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly insertAlert: StatementSync;
  private readonly insertAction: StatementSync;
  private readonly upsertRule: StatementSync;
  private readonly devicePosition: StatementSync;
  private readonly touchDevice: StatementSync;

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
    this.findToken = this.db.prepare('SELECT * FROM tokens WHERE hash = ?');
    this.insertDevice = this.db.prepare(
      'INSERT OR IGNORE INTO devices (id, name, created_at) VALUES (?, ?, ?)',
    );
    this.insertToken = this.db.prepare(
      'INSERT INTO tokens (hash, kind, name, device_id, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.revokeSocTokensByName = this.db.prepare(
      "UPDATE tokens SET revoked_at = ? WHERE kind = 'soc' AND name = ? AND revoked_at IS NULL",
    );
    this.revokeDeviceTokens = this.db.prepare(
      'UPDATE tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
    );
    this.deleteDevice = this.db.prepare('DELETE FROM devices WHERE id = ?');
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
    this.devicePosition = this.db.prepare('SELECT last_ts, last_id FROM devices WHERE id = ?');
    this.touchDevice = this.db.prepare(
      'UPDATE devices SET last_seen_at = ?, last_ts = ?, last_id = ? WHERE id = ?',
    );
  }

  /**
   * Enrolls a device and prints-once token. Reprovisioning rotates: the
   * device's previous tokens stop working at once.
   */
  provisionDevice(name: string, now: number): { deviceId: string; token: string } {
    DeviceId.parse(name);
    const token = newToken('device');
    this.db.exec('BEGIN');
    try {
      this.insertDevice.run(name, name, now);
      this.revokeDeviceTokens.run(now, name);
      this.insertToken.run(tokenHash(token), 'device', name, name, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { deviceId: name, token };
  }

  /** Issues a SOC token for the MCP face. SOC tokens never answer ingest. */
  provisionSoc(name: string, now: number): { token: string } {
    const token = newToken('soc');
    this.revokeSocTokensByName.run(now, name);
    this.insertToken.run(tokenHash(token), 'soc', name, null, now);
    return { token };
  }

  /** Revocation is deleting the device: tokens stop working, telemetry stays until retention. */
  revokeDevice(name: string, now: number): { revokedTokens: number } {
    this.db.exec('BEGIN');
    try {
      const result = this.revokeDeviceTokens.run(now, name);
      this.deleteDevice.run(name);
      this.db.exec('COMMIT');
      return { revokedTokens: Number(result.changes) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  revokeSoc(name: string, now: number): { revokedTokens: number } {
    const result = this.revokeSocTokensByName.run(now, name);
    return { revokedTokens: Number(result.changes) };
  }

  tokenByHash(hash: string): StoredToken | undefined {
    const row = this.findToken.get(hash) as TokenRow | undefined;
    if (row === undefined) return undefined;
    return {
      hash: row.hash,
      kind: row.kind as TokenKind,
      name: row.name,
      deviceId: row.device_id ?? undefined,
      revokedAt: row.revoked_at ?? undefined,
    };
  }

  /**
   * Applies a validated batch atomically: either every record lands (fresh
   * or counted as an already-stored duplicate) or nothing does. The cursor
   * only moves to the newest record the relay actually has, so a shipper
   * that replays after a crash loses nothing and stores nothing twice.
   */
  applyBatch(deviceId: string, records: readonly ShipRecord[], now: number): BatchOutcome {
    let accepted = 0;
    let duplicates = 0;
    this.db.exec('BEGIN');
    try {
      // The device row exists before anything lands on it: ingest normally
      // enrolls through provisioning, and a store used directly (tests,
      // imports) still gets a row so positions and last-seen track.
      this.insertDevice.run(deviceId, deviceId, now);
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
      const cursor = devicePositionCursor(
        records,
        this.devicePosition.get(deviceId) as { last_ts: number | null; last_id: string | null },
      );
      this.touchDevice.run(now, cursor.ts, cursor.id, deviceId);
      this.db.exec('COMMIT');
      return { accepted, duplicates, cursor };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): RelayStats {
    return {
      devices: this.count('devices'),
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
 * The position to ack: the newest of the batch and the device's stored
 * position. Taking the max of the two covers the replay-continuation case —
 * a shipper resending older records after a crash must not drag the cursor
 * backwards, or the next push would replay even more.
 */
function devicePositionCursor(
  records: readonly ShipRecord[],
  stored: { last_ts: number | null; last_id: string | null } | undefined,
): DevicePosition {
  let cursor: DevicePosition = { ts: 0, id: '' };
  const candidates: readonly DevicePosition[] = [
    ...records.map((r) => ({ ts: r.ts, id: r.id })),
    ...(stored?.last_ts !== null &&
    stored?.last_ts !== undefined &&
    stored?.last_id !== null &&
    stored?.last_id !== undefined
      ? [{ ts: stored.last_ts, id: stored.last_id }]
      : []),
  ];
  for (const candidate of candidates) {
    if (candidate.ts > cursor.ts || (candidate.ts === cursor.ts && candidate.id > cursor.id)) {
      cursor = candidate;
    }
  }
  return cursor;
}
