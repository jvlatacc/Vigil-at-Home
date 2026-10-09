import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Rule } from '@vigil/core';
import { FIXTURE_RULE_ID, FIXTURE_RULE_TAGS, makeAlert } from './fixtures.js';

// node:sqlite ships in Node 22.13+ unflagged; where the runtime lacks it the
// module import fails and these tests skip — CI (per .nvmrc) runs them for real.
const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

const HOUR = 3_600_000;
const T0 = 1728460000000;

function makeRule(overrides: Partial<Rule> = {}): Rule {
  const base: Rule = {
    id: FIXTURE_RULE_ID,
    version: 3,
    name: 'Unsigned launch agent persisted',
    description: 'A process wrote a launch agent, and no signature covers it.',
    origin: 'builtin',
    mode: 'block',
    severity: 'high',
    fidelity: 'high',
    eventKinds: ['persistence'],
    condition: { field: 'persistence.mechanism', op: 'eq', value: 'launch_agent' },
    exclusions: [],
    reasons: [],
    response: [],
    tags: [...FIXTURE_RULE_TAGS],
    createdAt: T0,
    updatedAt: T0,
  };
  return { ...base, ...overrides };
}

describe.skipIf(!hasSqlite)('readAlertWindow', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(async () => {
    const { DatabaseSync } = await import('node:sqlite');
    dir = mkdtempSync(join(tmpdir(), 'soc-export-db-'));
    dbPath = join(dir, 'vigil.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        mode TEXT NOT NULL,
        origin TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `);
    const insertAlert = db.prepare(
      'INSERT INTO alerts (id, created_at, updated_at, status, severity, rule_id, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const alertRow = (
      id: string,
      createdAt: number,
      overrides: Parameters<typeof makeAlert>[0] = {},
    ) => {
      const alert = makeAlert({ id, createdAt, updatedAt: createdAt, ...overrides });
      insertAlert.run(
        alert.id,
        alert.createdAt,
        alert.updatedAt,
        alert.status,
        alert.severity,
        alert.ruleId,
        JSON.stringify(alert),
      );
    };
    alertRow('a1', T0);
    alertRow('a2', T0 + HOUR, { severity: 'info' });
    alertRow('a3', T0 + 2 * HOUR, { severity: 'medium', status: 'resolved' });
    // A row whose body no longer parses as an Alert: reported, never dropped silently.
    db.prepare(
      'INSERT INTO alerts (id, created_at, updated_at, status, severity, rule_id, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('bad1', T0 + 3 * HOUR, T0 + 3 * HOUR, 'open', 'high', FIXTURE_RULE_ID, '{"id":1}');
    const rule = makeRule();
    db.prepare(
      'INSERT INTO rules (id, version, mode, origin, updated_at, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(rule.id, rule.version, rule.mode, rule.origin, rule.updatedAt, JSON.stringify(rule));
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every parseable alert in createdAt order and counts unreadable rows', async () => {
    const { readAlertWindow } = await import('../db-source.js');
    const window = await readAlertWindow(dbPath);
    expect(window.alerts.map((alert) => alert.id)).toEqual(['a1', 'a2', 'a3']);
    expect(window.unreadable).toBe(1);
  });

  it('applies since (inclusive) and until (exclusive) bounds', async () => {
    const { readAlertWindow } = await import('../db-source.js');
    const window = await readAlertWindow(dbPath, {
      sinceMs: T0 + HOUR,
      untilMs: T0 + 2 * HOUR,
    });
    expect(window.alerts.map((alert) => alert.id)).toEqual(['a2']);
  });

  it('lifts rule tags for MITRE predictions like the live push does', async () => {
    const { readAlertWindow } = await import('../db-source.js');
    const window = await readAlertWindow(dbPath);
    expect(window.ruleTags(FIXTURE_RULE_ID)?.tags).toEqual(FIXTURE_RULE_TAGS);
    expect(window.ruleTags('other.rule')).toBeUndefined();
  });

  it('round-trips a real alert through the shared mapping unredacted-safely', async () => {
    const { readAlertWindow } = await import('../db-source.js');
    const window = await readAlertWindow(dbPath, { sinceMs: T0 });
    const alert = window.alerts[0];
    expect(alert?.severity).toBe('high');
    expect(alert?.eventIds).toEqual(['e1']);
  });

  it('rejects a missing database with a clear error', async () => {
    const { readAlertWindow } = await import('../db-source.js');
    await expect(readAlertWindow(join(dir, 'missing.db'))).rejects.toThrow(
      /vigil\.db|no such|unable to open/i,
    );
  });
});
