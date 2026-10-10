import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, parseInvocation, CliUsageError } from '../cli.js';
import { FIXTURE_RULE_ID, FIXTURE_RULE_TAGS, makeAlert } from './fixtures.js';
import { FakeFetch, jsonResponse } from './fake-fetch.js';
import { localNames } from '@vigil/ai/redact';

const hasSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

describe('parseInvocation', () => {
  it('collects flags and positionals', () => {
    const inv = parseInvocation([
      'upload',
      '--url',
      'http://127.0.0.1:6987',
      '--key-env',
      'K',
      'a.jsonl',
    ]);
    expect(inv.command).toBe('upload');
    expect(inv.flags).toEqual({ url: 'http://127.0.0.1:6987', 'key-env': 'K' });
    expect(inv.positional).toEqual(['a.jsonl']);
  });

  it('rejects a flag at the end with no value, and a missing command', () => {
    expect(() => parseInvocation(['export', '--db'])).toThrow(CliUsageError);
    expect(() => parseInvocation(['--flag', 'x'])).toThrow(CliUsageError);
    expect(() => parseInvocation(['export', '--out', '--db', 'x'])).toThrow(CliUsageError);
  });
});

const T0 = 1728460000000;
const HOUR = 3_600_000;

describe.skipIf(!hasSqlite)('main export', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(async () => {
    const { DatabaseSync } = await import('node:sqlite');
    dir = mkdtempSync(join(tmpdir(), 'soc-export-cli-'));
    dbPath = join(dir, 'vigil.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE alerts (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        status TEXT NOT NULL, severity TEXT NOT NULL, rule_id TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE TABLE rules (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, mode TEXT NOT NULL,
        origin TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL
      );
    `);
    const insertAlert = db.prepare(
      'INSERT INTO alerts (id, created_at, updated_at, status, severity, rule_id, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const alert of [
      makeAlert({ id: 'a1', createdAt: T0, updatedAt: T0 }),
      makeAlert({ id: 'a2', createdAt: T0 + HOUR, updatedAt: T0 + HOUR, severity: 'medium' }),
      // A body no longer parseable as the schema: counted, skipped, not fatal.
      makeAlert({ id: 'bad1', createdAt: T0 + 2 * HOUR, updatedAt: T0 + 2 * HOUR }),
    ]) {
      if (alert.id === 'bad1') {
        insertAlert.run(
          alert.id,
          alert.createdAt,
          alert.updatedAt,
          alert.status,
          alert.severity,
          alert.ruleId,
          '{"id":1}',
        );
      } else {
        insertAlert.run(
          alert.id,
          alert.createdAt,
          alert.updatedAt,
          alert.status,
          alert.severity,
          alert.ruleId,
          JSON.stringify(alert),
        );
      }
    }
    const rule = {
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
    db.prepare(
      'INSERT INTO rules (id, version, mode, origin, updated_at, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(rule.id, rule.version, rule.mode, rule.origin, rule.updatedAt, JSON.stringify(rule));
    db.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports the window to redacted JSONL and warns about unreadable rows', async () => {
    const outPath = join(dir, 'alerts.jsonl');
    const code = await main(['export', '--db', dbPath, '--out', outPath]);
    expect(code).toBe(0);

    const jsonl = readFileSync(outPath, 'utf8');
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(2); // the unreadable row is counted, not exported
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(first['finding_id']).toBe('vah-a1');
    expect(first['data_source']).toBe('vigil-at-home');

    const second = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
    expect(second['severity']).toBe('medium');
    expect(second['mitre_predictions']).toEqual({ 'T1059.001': 0.9, T1003: 0.9 });
  });

  it('applies since/until windows given as ISO dates', async () => {
    const outPath = join(dir, 'window.jsonl');
    const code = await main([
      'export',
      '--db',
      dbPath,
      '--out',
      outPath,
      '--since',
      new Date(T0 + HOUR).toISOString(),
      '--until',
      new Date(T0 + 2 * HOUR).toISOString(),
    ]);
    expect(code).toBe(0);
    expect(readFileSync(outPath, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('writes nothing and exits cleanly on an empty window', async () => {
    const outPath = join(dir, 'empty.jsonl');
    const code = await main([
      'export',
      '--db',
      dbPath,
      '--out',
      outPath,
      '--since',
      String(T0 + 999 * HOUR),
    ]);
    expect(code).toBe(0);
    expect(readFileSyncSafe(outPath)).toBeUndefined();
  });
});

function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

describe('main upload and case', () => {
  const base = ['--url', 'http://127.0.0.1:6987', '--key-env', 'VAH_TEST_KEY'];
  const JOB = {
    job_id: 'ing-abc123def456',
    filename: 'vigil-alerts.jsonl',
    format: 'jsonl',
    data_type: 'finding',
    status: 'succeeded',
    determinate: false,
    processed: 1,
    total: 1,
    created_at: '2026-10-09T12:00:00Z',
    finished_at: '2026-10-09T12:00:01Z',
    message: 'Imported 1 findings',
    error: null,
    stats: {
      findings_total: 1,
      findings_imported: 1,
      findings_skipped: 0,
      findings_errors: 0,
      cases_total: 0,
      cases_imported: 0,
      cases_skipped: 0,
      cases_errors: 0,
    },
  };

  it('uploads a JSONL file through the multipart contract and reports the stats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soc-export-upload-'));
    try {
      const filePath = join(dir, 'alerts.jsonl');
      writeFileSync(filePath, '{"finding_id":"vah-a1"}\n', 'utf8');
      const fake = new FakeFetch(
        () => jsonResponse(202, { ...JOB, status: 'running' }),
        () => jsonResponse(200, JOB),
      );
      process.env['VAH_TEST_KEY'] = 'test-key';
      try {
        const code = await main(['upload', ...base, filePath], { fetch: fake.fetch });
        expect(code).toBe(0);
      } finally {
        delete process.env['VAH_TEST_KEY'];
      }
      expect(fake.formField('data_type')).toBe('finding');
      expect(fake.formField('format')).toBe('jsonl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports a case document, redacting its free text before upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soc-export-case-'));
    try {
      // The CLI redacts this machine's real local names. This sandbox may
      // expose none worth hiding (generic usernames are skipped by the
      // redactor), so the fixture composes from whatever localNames() returns.
      const names = localNames();
      const who = names.username ?? 'local-user';
      const where = names.hostname ?? 'local-host';
      const filePath = join(dir, 'case.json');
      writeFileSync(
        filePath,
        JSON.stringify({
          case_id: 'case-2026-10-09-demo',
          title: `agent-${who}.plist cluster`,
          description: `Staged for ${who} on ${where}.`,
          finding_ids: ['vah-a1', 'vah-a2'],
          priority: 'high',
          tags: ['persistence'],
        }),
        'utf8',
      );
      const fake = new FakeFetch(
        () =>
          jsonResponse(202, {
            ...JOB,
            data_type: 'case',
            format: 'json',
            status: 'running',
            message: '',
            stats: {},
          }),
        () =>
          jsonResponse(200, {
            ...JOB,
            data_type: 'case',
            format: 'json',
            message: 'Imported 1 cases',
            stats: {
              findings_total: 0,
              findings_imported: 0,
              findings_skipped: 0,
              findings_errors: 0,
              cases_total: 1,
              cases_imported: 1,
              cases_skipped: 0,
              cases_errors: 0,
            },
          }),
      );
      process.env['VAH_TEST_KEY'] = 'test-key';
      try {
        const code = await main(['case', ...base, filePath], { fetch: fake.fetch });
        expect(code).toBe(0);
      } finally {
        delete process.env['VAH_TEST_KEY'];
      }
      expect(fake.formField('data_type')).toBe('case');
      expect(fake.formField('format')).toBe('json');
      const file = fake.formField('file');
      const uploaded = JSON.parse(await (file as File).text()) as Record<string, unknown>;
      // The router's JSON path routes a {findings, cases} document by key and
      // ignores data_type for JSON files — the case rides in a cases array.
      const cases = uploaded['cases'] as Array<Record<string, unknown>>;
      const doc = cases?.[0];
      expect(doc?.['case_id']).toBe('case-2026-10-09-demo');
      // Whatever names this machine exposes must not survive the upload;
      // concrete-name redaction itself is proven in case-import.test.ts.
      if (names.username) {
        expect(String(doc?.['title'])).not.toContain(names.username);
        expect(String(doc?.['description'])).not.toContain(names.username);
      }
      if (names.hostname) {
        expect(String(doc?.['description'])).not.toContain(names.hostname);
      }
      expect(doc?.['finding_ids']).toEqual(['vah-a1', 'vah-a2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with a usage error when the key environment variable is unset', async () => {
    delete process.env['VAH_TEST_MISSING_KEY'];
    const code = await main([
      'upload',
      '--url',
      'http://127.0.0.1:6987',
      '--key-env',
      'VAH_TEST_MISSING_KEY',
      'x.jsonl',
    ]);
    expect(code).toBe(2);
  });

  it('reports a transport failure as exit code 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soc-export-err-'));
    try {
      const filePath = join(dir, 'alerts.jsonl');
      writeFileSync(filePath, '{"finding_id":"vah-a1"}\n', 'utf8');
      const fake = new FakeFetch(() => jsonResponse(500, { detail: 'nope' }));
      process.env['VAH_TEST_KEY'] = 'test-key';
      try {
        const code = await main(['upload', ...base, filePath], { fetch: fake.fetch });
        expect(code).toBe(1);
      } finally {
        delete process.env['VAH_TEST_KEY'];
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
