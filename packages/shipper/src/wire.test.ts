import { describe, expect, it } from 'vitest';
import { IngestAck, IngestRequest, ShipRecord, laterCursor } from './wire.js';

const eventBody = {
  id: '01J1EVENT',
  ts: 1_728_451_200_123,
  source: 'osquery' as const,
  kind: 'process.exec' as const,
  process: {
    path: '/usr/bin/curl',
    pid: 4242,
    args: ['curl', 'https://example.com'],
    signing: 'unsigned' as const,
  },
};

const alertBody = {
  id: 'alert-1',
  createdAt: 1_728_451_200_123,
  updatedAt: 1_728_451_200_456,
  ruleId: 'core.exec-script',
  ruleVersion: 3,
  title: 'Script through curl',
  summary: 'A script tried to fetch something.',
  severity: 'medium' as const,
  fidelity: 'high' as const,
  notify: 'badge' as const,
  status: 'open' as const,
  containment: 'none' as const,
  eventIds: ['01J1EVENT'],
  actionIds: [],
};

const batch = {
  v: 1,
  deviceId: 'laptop-a1b2c3',
  cursor: { ts: 1_728_451_200_100, id: '01J0PREV' },
  records: [
    { r: 'event', id: '01J1EVENT', ts: eventBody.ts, body: eventBody },
    { r: 'alert', id: 'alert-1', ts: alertBody.createdAt, body: alertBody },
    {
      r: 'action',
      id: 'action-1',
      ts: 1_728_451_200_200,
      body: { kind: 'process.kill', pid: 4242 },
    },
    { r: 'rule', id: 'rules-snapshot', version: 7, body: { note: 'snapshot' } },
  ],
};

describe('IngestRequest', () => {
  it('round-trips a realistic batch', () => {
    const parsed = IngestRequest.parse(batch);
    expect(parsed.records).toHaveLength(4);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(batch);
  });

  it('drops raw from event bodies (the sensor record never ships)', () => {
    const first = batch.records[0];
    const withRaw = {
      ...batch,
      records: [{ ...first, body: { ...eventBody, raw: { santa: 'line' } } }],
    };
    const parsed = IngestRequest.parse(withRaw);
    const event = parsed.records.find(
      (r): r is Extract<ShipRecord, { r: 'event' }> => r.r === 'event',
    );
    expect(event && 'raw' in event.body).toBe(false);
  });

  it('rejects a missing or wrong version', () => {
    expect(IngestRequest.safeParse({ ...batch, v: 2 }).success).toBe(false);
    const { v: _v, ...noVersion } = batch;
    expect(IngestRequest.safeParse(noVersion).success).toBe(false);
  });

  it('rejects a device id outside 8..64 characters', () => {
    expect(IngestRequest.safeParse({ ...batch, deviceId: 'short' }).success).toBe(false);
  });

  it('rejects an empty batch and one past 500 records', () => {
    expect(IngestRequest.safeParse({ ...batch, records: [] }).success).toBe(false);
    const records = Array.from({ length: 501 }, (_, i) => ({
      r: 'event',
      id: `e${i}`,
      ts: i,
      body: { ...eventBody, id: `e${i}`, ts: i },
    }));
    expect(IngestRequest.safeParse({ ...batch, records }).success).toBe(false);
  });

  it('rejects an unknown record kind', () => {
    const bad = { ...batch, records: [{ r: 'command', id: 'x', ts: 1, body: {} }] };
    expect(IngestRequest.safeParse(bad).success).toBe(false);
  });
});

describe('IngestAck', () => {
  it('round-trips and rejects a missing cursor', () => {
    const ack = { v: 1, accepted: 3, duplicates: 1, ackedCursor: { ts: 5, id: 'e5' } };
    expect(IngestAck.parse(ack)).toEqual(ack);
    expect(IngestAck.safeParse({ v: 1, accepted: 3, duplicates: 1 }).success).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(
      IngestAck.safeParse({
        v: 1,
        accepted: -1,
        duplicates: 0,
        ackedCursor: { ts: 5, id: 'e' },
      }).success,
    ).toBe(false);
  });
});

describe('laterCursor', () => {
  it('compares by ts, then id', () => {
    const a = { ts: 5, id: 'a' };
    expect(laterCursor(a, { ts: 4, id: 'z' })).toEqual(a);
    expect(laterCursor(a, { ts: 5, id: 'b' })).toEqual({ ts: 5, id: 'b' });
    expect(laterCursor(a, a)).toEqual(a);
  });
});

describe('ShipRecord', () => {
  it('keeps action and rule bodies untyped', () => {
    const parsed = ShipRecord.parse({ r: 'action', id: 'a', ts: 1, body: { whatever: ['goes'] } });
    expect(parsed.r).toBe('action');
  });
});
