import { describe, expect, it } from 'vitest';
import {
  alertToIngestLine,
  alertsToIngestJsonl,
  ingestFindingFromAlert,
  INGEST_DATA_SOURCE,
} from '../jsonl.js';
import { alertToFinding } from '../mapping.js';
import {
  DEFAULT_ALERT_ID,
  FIXTURE_MACHINE_ID,
  makeAlert,
  makeContext,
  TEST_NAMES,
} from './fixtures.js';

const HOUR = 3_600_000;

describe('ingestFindingFromAlert', () => {
  it('re-projects the shared mapping onto the ingest router field names', () => {
    const alert = makeAlert();
    const ctx = makeContext();
    const row = ingestFindingFromAlert(alert, ctx);
    const pushed = alertToFinding(alert, ctx);

    expect(row).toEqual({
      finding_id: `vah-${DEFAULT_ALERT_ID}`,
      timestamp: new Date(1728460000000).toISOString(),
      anomaly_score: 0.8,
      severity: 'high',
      data_source: INGEST_DATA_SOURCE,
      title: 'Unsigned launch agent persisted',
      description: pushed.description,
      mitre_predictions: { 'T1059.001': 0.9, T1003: 0.9 },
      entity_context: pushed.entity_context_extra,
    });
  });

  it('keeps the entity_context the push path redacted', () => {
    const row = ingestFindingFromAlert(
      makeAlert({
        subject: { kind: 'process', label: 'installer', path: '/Users/alice-holland/installer' },
      }),
      makeContext(),
    );
    const context = JSON.stringify(row.entity_context);
    expect(context).not.toContain(TEST_NAMES.username ?? '');
    expect(context).not.toContain(TEST_NAMES.hostname ?? '');
    expect(row.entity_context?.['host']).toBe(FIXTURE_MACHINE_ID);
  });

  it('maps info to low with the documented anomaly score', () => {
    const row = ingestFindingFromAlert(makeAlert({ severity: 'info' }), makeContext());
    expect(row.severity).toBe('low');
    expect(row.anomaly_score).toBe(0.2);
  });

  it('marks a resolved alert resolved and leaves an open one to the SOC default', () => {
    const open = ingestFindingFromAlert(makeAlert({ status: 'open' }), makeContext());
    expect('status' in open).toBe(false);

    const resolved = ingestFindingFromAlert(makeAlert({ status: 'resolved' }), makeContext());
    expect(resolved.status).toBe('resolved');
  });

  it('redacts local names in the title, including hyphenated compounds', () => {
    const row = ingestFindingFromAlert(
      makeAlert({ title: 'agent-alice-holland.plist staged in host-alice-macbook.local context' }),
      makeContext(),
    );
    expect(row.title).not.toContain('alice-holland');
    expect(row.title).not.toContain('alice-macbook.local');
    expect(row.title).toMatch(/<user>/);
    expect(row.title).toMatch(/<host>/);
  });

  it('keeps stable ids across a repeat export', () => {
    const first = ingestFindingFromAlert(makeAlert(), makeContext()).finding_id;
    const second = ingestFindingFromAlert(makeAlert(), makeContext()).finding_id;
    expect(first).toBe(second);
  });
});

describe('alertToIngestLine', () => {
  it('serializes the row as one JSON line that parses back exactly', () => {
    const alert = makeAlert();
    const line = alertToIngestLine(alert, makeContext());
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual(ingestFindingFromAlert(alert, makeContext()));
  });
});

describe('alertsToIngestJsonl', () => {
  const ctx = makeContext();

  it('joins rows one per line with a trailing newline', () => {
    const jsonl = alertsToIngestJsonl(
      [
        makeAlert({ id: DEFAULT_ALERT_ID, createdAt: 1728460000000 }),
        makeAlert({
          id: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
          createdAt: 1728460000000 + HOUR,
          severity: 'info',
          fidelity: 'medium',
        }),
        makeAlert({
          id: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
          createdAt: 1728460000000 + 2 * HOUR,
          severity: 'medium',
          status: 'resolved',
          containment: 'released',
        }),
      ],
      ctx,
    );
    expect(jsonl.split('\n')).toHaveLength(4); // 3 rows + trailing newline
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl).toMatchSnapshot();
  });

  it('produces an empty string for an empty window', () => {
    expect(alertsToIngestJsonl([], ctx)).toBe('');
  });
});
