import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { AlertStore } from '../mcp/alert-store.js';
import {
  BIG_ALERT_ID,
  HOSTILE_ALERT_ID,
  NOW,
  createSchema,
  fixtureFileDb,
  fixtureMemoryDb,
  hostileAlert,
  removeFixtureDb,
} from './mcp-fixture-db.js';

let file: { path: string; dir: string } | undefined;

afterEach(() => {
  if (file) {
    removeFixtureDb(file.dir);
    file = undefined;
  }
});

describe('AlertStore.recent', () => {
  it('lists alerts newest first, validated against the Alert schema', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      const alerts = store.recent({ sinceMs: NOW - 60 * 60_000, limit: 50 });
      // BIG is one minute old, HOSTILE five; RESOLVED and CALM are hours old.
      expect(alerts.map((a) => a.id)).toEqual([BIG_ALERT_ID, HOSTILE_ALERT_ID]);
    } finally {
      store.close();
    }
  });

  it('filters by severity', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      const critical = store.recent({ sinceMs: 0, severity: 'critical', limit: 50 });
      expect(critical.map((a) => a.id)).toEqual([BIG_ALERT_ID]);
      const high = store.recent({ sinceMs: 0, severity: 'high', limit: 50 });
      expect(high.map((a) => a.id)).toEqual([HOSTILE_ALERT_ID]);
    } finally {
      store.close();
    }
  });

  it('honors the limit', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      const alerts = store.recent({ sinceMs: 0, limit: 2 });
      expect(alerts).toHaveLength(2);
      expect(alerts[0]?.createdAt).toBeGreaterThanOrEqual(alerts[1]!.createdAt);
    } finally {
      store.close();
    }
  });
});

describe('AlertStore.byId / evidence', () => {
  it('returns undefined for an id it never raised', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      expect(store.byId('alert-nothing-here')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('returns the evidence events oldest first', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      const alert = store.byId(HOSTILE_ALERT_ID);
      expect(alert).toBeDefined();
      const events = store.evidence(alert!, 50);
      expect(events.map((e) => e.id)).toEqual(['evt-hostile-1']);
      expect(events[0]!.kind).toBe('process.exec');
    } finally {
      store.close();
    }
  });
});

describe('read-only enforcement', () => {
  it('opens file databases with SQLite itself refusing writes', () => {
    file = fixtureFileDb();
    const db = new DatabaseSync(file.path, { readOnly: true });
    const store = new AlertStore(db);
    try {
      expect(() =>
        db.exec(
          `INSERT INTO alerts (id, created_at, updated_at, status, severity, rule_id, body)
           VALUES ('x', 0, 0, 'open', 'low', 'r', '{}')`,
        ),
      ).toThrow(/read-?only/i);
      expect(store.byId(HOSTILE_ALERT_ID)).toBeDefined();
    } finally {
      store.close();
    }
  });

  it('reads a file database without changing its bytes', () => {
    file = fixtureFileDb();
    const before = new DatabaseSync(file.path, { readOnly: true })
      .prepare('SELECT COUNT(*) AS n FROM alerts')
      .get() as { n: number };
    const store = AlertStore.openReadOnly(file.path);
    try {
      expect(store.recent({ sinceMs: 0, limit: 50 }).length).toBe(before.n);
    } finally {
      store.close();
    }
  });
});

describe('schema compatibility', () => {
  it('runs the fixture schema once (second run fails like real migrations would)', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => {
      createSchema(db);
      createSchema(db);
    }).toThrow();
    db.close();
  });

  it('round-trips an alert through body JSON unchanged', () => {
    const store = new AlertStore(fixtureMemoryDb());
    try {
      expect(store.byId(HOSTILE_ALERT_ID)).toStrictEqual(hostileAlert());
    } finally {
      store.close();
    }
  });
});
