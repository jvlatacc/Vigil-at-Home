import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import {
  RuleMode,
  Severity,
  type ActionRecord,
  type Alert,
  type EventBody,
  type EventKind,
  type ShipRecord,
} from '@vigil/core';
import { newToken, tokenHash, type TokenKind } from './tokens.js';
// Type-only: the MCP face's row shapes, which these read methods fill. No
// runtime edge — the module graph stays store → core, never store → mcp.
import type {
  RelayActionRow,
  RelayAlertRow,
  RelayDeviceFacts,
  RelayEventRow,
  RelayRuleRow,
  RelayStatusFacts,
} from './mcp.js';

/** The laptop that ships telemetry, as provisioned by `relay provision --device`. */
export const DeviceId = z.string().min(8).max(64);
export type DeviceId = z.infer<typeof DeviceId>;

/**
 * The streams retention evicts, oldest first. Rule snapshots are missing on
 * purpose: they are current state, not history. The relay_ prefix keeps
 * these tables distinct from the app's own events/alerts/actions tables —
 * repo-wide scans (like the desktop store test) must not mistake a write
 * to the relay's copy for one to the app's store.
 */
const STREAM_TABLES = ['relay_events', 'relay_alerts', 'relay_actions'] as const;
type StreamTable = (typeof STREAM_TABLES)[number];

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
  CREATE TABLE relay_events (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX relay_events_ts ON relay_events (ts);

  CREATE TABLE relay_alerts (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX relay_alerts_ts ON relay_alerts (ts);

  CREATE TABLE relay_actions (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  CREATE INDEX relay_actions_ts ON relay_actions (ts);

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
  /** The stream position this batch confirms, or undefined when nothing does. */
  cursor: DevicePosition | undefined;
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

export interface RelayStoreOptions {
  /** Called when total inserts cross each `insertCheckEvery` multiple. */
  onRetentionDue?: () => void;
  /** Inserts between retention callbacks; the house number is 10,000. */
  insertCheckEvery?: number;
}

type TokenRow = {
  hash: string;
  kind: string;
  name: string;
  device_id: string | null;
  created_at: number;
  revoked_at: number | null;
};

type StreamRow = {
  device_id: string;
  id: string;
  ts: number;
  body: string;
};

type DeviceRow = {
  id: string;
  last_seen_at: number | null;
  last_ts: number | null;
  last_id: string | null;
};

type RuleRow = {
  id: string;
  version: number;
  body: string;
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
  private readonly onRetentionDue: (() => void) | undefined;
  private readonly insertCheckEvery: number;
  private totalInserts = 0;
  private lastRetentionCheck = 0;
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
  private readonly touchDeviceSeen: StatementSync;

  constructor(dataDir: string, opts: RelayStoreOptions = {}) {
    this.onRetentionDue = opts.onRetentionDue;
    this.insertCheckEvery = opts.insertCheckEvery ?? 10_000;
    // House pattern for private state (the agent socket's privateDir):
    // create it 0700 and make sure it stays that way.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.dataDir = dataDir;
    this.db = new DatabaseSync(join(dataDir, 'relay.db'));
    // auto_vacuum must be set before the database file becomes non-empty:
    // after journal_mode = WAL writes the header, SQLite silently discards
    // the setting (reads back NONE) and vacuum never returns pages.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 3000');
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
      'INSERT OR IGNORE INTO relay_events (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
    );
    this.insertAlert = this.db.prepare(
      'INSERT OR IGNORE INTO relay_alerts (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
    );
    this.insertAction = this.db.prepare(
      'INSERT OR IGNORE INTO relay_actions (device_id, id, ts, body) VALUES (?, ?, ?, ?)',
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
    this.touchDeviceSeen = this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?');
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
                : this.upsertRule.run(deviceId, record.id, record.version, now, body);
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
      // A rule-only first batch confirms no stream position: the device was
      // heard from, but its position stands.
      if (cursor === undefined) this.touchDeviceSeen.run(now, deviceId);
      else this.touchDevice.run(now, cursor.ts, cursor.id, deviceId);
      this.db.exec('COMMIT');
      // Retention re-checks at insert thresholds as well as hourly, so a
      // busy relay cannot outgrow its disk cap between clock ticks.
      this.totalInserts += accepted;
      if (
        this.onRetentionDue !== undefined &&
        this.totalInserts - this.lastRetentionCheck >= this.insertCheckEvery
      ) {
        this.lastRetentionCheck = this.totalInserts;
        this.onRetentionDue();
      }
      return { accepted, duplicates, cursor };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): RelayStats {
    return {
      devices: this.count('devices'),
      events: this.count('relay_events'),
      alerts: this.count('relay_alerts'),
      actions: this.count('relay_actions'),
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

  /**
   * Deletes stream rows at or before `cutoffMs`, oldest first, until the
   * streams hold nothing that old. Rule snapshots are current state, not
   * history — they stay.
   */
  evictOlderThan(cutoffMs: number, maxRowsPerPass: number): number {
    let deleted = 0;
    for (;;) {
      const pass = STREAM_TABLES.reduce(
        (n, table) => n + this.deleteBatchFrom(table, cutoffMs, maxRowsPerPass),
        0,
      );
      deleted += pass;
      if (pass === 0) break;
    }
    this.db.exec('PRAGMA incremental_vacuum(2048)');
    return deleted;
  }

  /**
   * Deletes oldest-first across all streams until usage is at or under
   * `maxBytes`, bounded by `maxPasses` so a pathological row can't loop
   * forever. Returns the rows deleted.
   */
  evictToBytes(maxBytes: number, maxRowsPerPass: number, maxPasses: number): number {
    let deleted = 0;
    for (let pass = 0; pass < maxPasses; pass++) {
      // Freed pages only leave page_count after a vacuum, so vacuum between
      // passes — otherwise the loop cannot see its own progress and evicts
      // everything before stopping.
      if (this.diskUsageBytes() <= maxBytes) break;
      const n = this.deleteOldestAcrossStreams(maxRowsPerPass);
      if (n === 0) break;
      deleted += n;
      this.db.exec('PRAGMA incremental_vacuum(2048)');
    }
    this.db.exec('PRAGMA incremental_vacuum(2048)');
    return deleted;
  }

  close(): void {
    this.db.close();
  }

  // ----------------------------------------------------------- read model
  //
  // The SOC's MCP face reads through these: read-only queries over the same
  // tables ingest fills. Streams page by the (ts, id) keyset they are
  // written in, newest first, and nothing here writes a row. Statements are
  // prepared per call, like count() below: the filter sets vary and a small
  // statement prepares in microseconds.

  /** Relay-wide facts for relay_status: every device's last-seen and queue. */
  status(): RelayStatusFacts {
    return {
      devices: this.deviceFacts().map((d) => ({
        id: d.id,
        ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
        backlog: d.backlog,
        lagRecords: d.lagRecords,
      })),
    };
  }

  /** Every enrolled device, oldest enrollment first. */
  devices(): RelayDeviceFacts[] {
    return this.deviceFacts();
  }

  /** True when the device is enrolled, whether or not data has arrived. */
  hasDevice(deviceId: string): boolean {
    return this.db.prepare('SELECT 1 AS ok FROM devices WHERE id = ?').get(deviceId) !== undefined;
  }

  /** The relay's clock, for the tools' timestamps. */
  now(): number {
    return Date.now();
  }

  /**
   * Searches one device's events or every device's, newest first. `since`
   * and `limit` arrive pre-capped from the tool layer. `before` is the page
   * key: the id of the last event on the previous page, resolved to its
   * position here. An id nothing stored carries is a dead page key and is
   * refused, so a mistyped one cannot walk an agent into an unbounded scan.
   * The text filter matches raw substrings of the stored JSON — values and
   * key names alike, the honest cheap read of "text anywhere in the event".
   */
  searchEvents(q: {
    device?: string | undefined;
    kinds?: readonly EventKind[] | undefined;
    text?: string | undefined;
    since: number;
    before?: string | undefined;
    limit: number;
  }): { events: RelayEventRow[]; partial: boolean } {
    const where: string[] = ['ts >= ?'];
    const params: (string | number)[] = [q.since];
    if (q.device !== undefined) {
      where.push('device_id = ?');
      params.push(q.device);
    }
    if (q.before !== undefined) {
      const at = this.positionOf(q.before, q.device);
      if (at === undefined) {
        throw new Error(
          `No stored event has the id ${q.before}${q.device === undefined ? '' : ` on ${q.device}`}. Page from the start, or from a newer id.`,
        );
      }
      where.push('(ts < ? OR (ts = ? AND id < ?))');
      params.push(at.ts, at.ts, at.id);
    }
    if (q.kinds !== undefined && q.kinds.length > 0) {
      where.push(`json_extract(body, '$.kind') IN (${q.kinds.map(() => '?').join(', ')})`);
      params.push(...q.kinds);
    }
    if (q.text !== undefined) {
      where.push('instr(body, ?) > 0');
      params.push(q.text);
    }
    const rows = this.db
      .prepare(
        `SELECT device_id, id, ts, body FROM relay_events WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(...params, q.limit + 1) as StreamRow[];
    return {
      events: rows.slice(0, q.limit).map((r) => this.eventRowOf(r)),
      partial: rows.length > q.limit,
    };
  }

  /** One device's alerts, or every device's, newest first, at most `limit`. */
  alerts(q: {
    device?: string | undefined;
    since?: number | undefined;
    status?: 'open' | 'resolved' | undefined;
    limit: number;
  }): RelayAlertRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.device !== undefined) {
      where.push('device_id = ?');
      params.push(q.device);
    }
    if (q.since !== undefined) {
      where.push('ts >= ?');
      params.push(q.since);
    }
    if (q.status !== undefined) {
      where.push(`json_extract(body, '$.status') = ?`);
      params.push(q.status);
    }
    const rows = this.streamRows('relay_alerts', where, params, q.limit);
    return rows.map((r) => this.alertRowOf(r));
  }

  alert(device: string, id: string): RelayAlertRow | undefined {
    const row = this.db
      .prepare('SELECT device_id, id, ts, body FROM relay_alerts WHERE device_id = ? AND id = ?')
      .get(device, id) as StreamRow | undefined;
    return row === undefined ? undefined : this.alertRowOf(row);
  }

  /** One device's response actions, newest first, at most `limit`. */
  actions(q: {
    device?: string | undefined;
    since?: number | undefined;
    limit: number;
  }): RelayActionRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.device !== undefined) {
      where.push('device_id = ?');
      params.push(q.device);
    }
    if (q.since !== undefined) {
      where.push('ts >= ?');
      params.push(q.since);
    }
    const rows = this.streamRows('relay_actions', where, params, q.limit);
    return rows.map((r) => this.actionRowOf(r));
  }

  /** The device's latest rules snapshot, projected to what the tools show. */
  rules(device: string): RelayRuleRow[] {
    const rows = this.db
      .prepare('SELECT id, version, body FROM rule_snapshots WHERE device_id = ? ORDER BY id')
      .all(device) as RuleRow[];
    return rows.map((r) => ({ device, id: r.id, version: r.version, ...ruleSummary(r.body) }));
  }

  rule(device: string, id: string): RelayRuleRow | undefined {
    const row = this.db
      .prepare('SELECT id, version, body FROM rule_snapshots WHERE device_id = ? AND id = ?')
      .get(device, id) as RuleRow | undefined;
    return row === undefined
      ? undefined
      : { device, id: row.id, version: row.version, ...ruleSummary(row.body) };
  }

  /**
   * A shared tail for the stream lists: newest first, at most `limit` rows.
   * Callers pass the filters they have; an empty set matches everything.
   */
  private streamRows(
    table: StreamTable,
    where: string[],
    params: (string | number)[],
    limit: number,
  ): StreamRow[] {
    const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    return this.db
      .prepare(
        `SELECT device_id, id, ts, body FROM ${table} ${clause} ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as StreamRow[];
  }

  private deviceFacts(): RelayDeviceFacts[] {
    const rows = this.db
      .prepare('SELECT id, last_seen_at, last_ts, last_id FROM devices ORDER BY created_at, id')
      .all() as DeviceRow[];
    return rows.map((r) => {
      const backlog = this.backlogAfter(r.id, r.last_ts, r.last_id);
      const facts: RelayDeviceFacts = {
        id: r.id,
        // Revocation deletes the device row, so a listed device is enrolled.
        // quiet: enrolled, nothing stored yet; active: at least one batch landed.
        state: r.last_seen_at === null ? 'quiet' : 'active',
        backlog,
        // The relay cannot see past its own queue: the unacked backlog is
        // the only lag it can measure in records.
        lagRecords: backlog,
      };
      if (r.last_seen_at !== null) facts.lastSeenAt = r.last_seen_at;
      if (r.last_ts !== null && r.last_id !== null) facts.cursor = { ts: r.last_ts, id: r.last_id };
      return facts;
    });
  }

  /** Records the events stream holds beyond the device's acked cursor. */
  private backlogAfter(deviceId: string, lastTs: number | null, lastId: string | null): number {
    const row =
      lastTs === null || lastId === null
        ? this.db
            .prepare('SELECT COUNT(*) AS n FROM relay_events WHERE device_id = ?')
            .get(deviceId)
        : this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM relay_events WHERE device_id = ? AND (ts > ? OR (ts = ? AND id > ?))',
            )
            .get(deviceId, lastTs, lastTs, lastId);
    return Number((row as { n: number }).n);
  }

  /** The (ts, id) position of a page key, if anything stored carries it. */
  private positionOf(
    id: string,
    device: string | undefined,
  ): { ts: number; id: string } | undefined {
    const row =
      device === undefined
        ? this.db
            .prepare(
              'SELECT ts, id FROM relay_events WHERE id = ? ORDER BY ts DESC, id DESC LIMIT 1',
            )
            .get(id)
        : this.db
            .prepare('SELECT ts, id FROM relay_events WHERE device_id = ? AND id = ?')
            .get(device, id);
    const r = row as { ts: number; id: string } | undefined;
    return r === undefined ? undefined : { ts: r.ts, id: r.id };
  }

  /** The shipped event body, as the wire validated it at ingest. */
  private eventRowOf(r: StreamRow): RelayEventRow {
    return { device: r.device_id, id: r.id, ts: r.ts, body: JSON.parse(r.body) as EventBody };
  }

  private alertRowOf(r: StreamRow): RelayAlertRow {
    return { device: r.device_id, alert: JSON.parse(r.body) as Alert };
  }

  private actionRowOf(r: StreamRow): RelayActionRow {
    // The wire carries action bodies opaquely: the shipper stored the app's
    // action row as it was, and the SOC reads it as stored.
    return { device: r.device_id, action: JSON.parse(r.body) as ActionRecord };
  }

  private count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  }

  /**
   * Deletes at most `maxRows` rows of one stream — the oldest first, and
   * only those at or before `cutoffMs` when given. `table` comes from the
   * module's own constant, never from input.
   */
  private deleteBatchFrom(
    table: StreamTable,
    cutoffMs: number | undefined,
    maxRows: number,
  ): number {
    const sql =
      cutoffMs === undefined
        ? `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ts, id LIMIT ?)`
        : `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ts <= ? ORDER BY ts, id LIMIT ?)`;
    const result =
      cutoffMs === undefined
        ? this.db.prepare(sql).run(maxRows)
        : this.db.prepare(sql).run(cutoffMs, maxRows);
    return Number(result.changes);
  }

  /** One batch from whichever stream holds the globally oldest row. */
  private deleteOldestAcrossStreams(maxRows: number): number {
    let oldest: { table: StreamTable; ts: number; id: string } | undefined;
    for (const table of STREAM_TABLES) {
      const row = this.db.prepare(`SELECT ts, id FROM ${table} ORDER BY ts, id LIMIT 1`).get() as
        { ts: number; id: string } | undefined;
      if (row === undefined) continue;
      if (
        oldest === undefined ||
        row.ts < oldest.ts ||
        (row.ts === oldest.ts && row.id < oldest.id)
      ) {
        oldest = { table, ts: row.ts, id: row.id };
      }
    }
    if (oldest === undefined) return 0;
    return this.deleteBatchFrom(oldest.table, undefined, maxRows);
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

const RULE_MODES: readonly string[] = RuleMode.options;
const SEVERITIES: readonly string[] = Severity.options;

/**
 * The fields of a rule the SOC's tools show, read out of the opaque body the
 * wire carried. The shipper validates rules against core's Rule before it
 * ships, so the fallbacks are defense, not expectation.
 */
function ruleSummary(body: unknown): {
  name: string;
  description: string;
  mode: RuleMode;
  severity: Severity;
  exclusions: number;
} {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return {
    name: typeof b['name'] === 'string' ? b['name'] : '',
    description: typeof b['description'] === 'string' ? b['description'] : '',
    mode:
      typeof b['mode'] === 'string' && RULE_MODES.includes(b['mode'])
        ? (b['mode'] as RuleMode)
        : 'disabled',
    severity:
      typeof b['severity'] === 'string' && SEVERITIES.includes(b['severity'])
        ? (b['severity'] as Severity)
        : 'medium',
    exclusions: Array.isArray(b['exclusions']) ? b['exclusions'].length : 0,
  };
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
): DevicePosition | undefined {
  // Rule records are state, not stream entries: the wire carries no ts for
  // them, so they never move a device's stream position.
  let cursor: DevicePosition | undefined;
  const consider = (ts: number, id: string): void => {
    if (cursor === undefined || ts > cursor.ts || (ts === cursor.ts && id > cursor.id)) {
      cursor = { ts, id };
    }
  };
  for (const record of records) if (record.r !== 'rule') consider(record.ts, record.id);
  if (
    stored?.last_ts !== null &&
    stored?.last_ts !== undefined &&
    stored?.last_id !== null &&
    stored?.last_id !== undefined
  ) {
    consider(stored.last_ts, stored.last_id);
  }
  return cursor;
}
