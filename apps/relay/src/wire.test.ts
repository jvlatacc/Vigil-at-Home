import { describe, expect, it } from 'vitest';
import { IngestAck, IngestRequest } from './wire.js';
import { alertRecord, batchRequest, eventRecord, execEventBody } from './test-support.js';

const request = (records: unknown[], deviceId = 'laptop-1'): unknown => ({
  v: 1,
  deviceId,
  cursor: { ts: 0, id: '' },
  records,
});

describe('IngestRequest', () => {
  it('round-trips a realistic batch of event and alert records', () => {
    const parsed = IngestRequest.safeParse(
      JSON.parse(
        batchRequest([eventRecord('e1', 1_700_000_000_000), alertRecord('a1', 1_700_000_000_001)]),
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.records).toHaveLength(2);
    expect(parsed.data.records[0]?.r).toBe('event');
    // Alert defaults are filled on parse, as the core schema defines them.
    expect(parsed.data.records[1]?.body).toMatchObject({ actionIds: [] });
  });

  it('strips the sensor raw record from event bodies', () => {
    const body = { ...execEventBody('e1', 1), raw: { santaLine: 'seeded secret' } };
    const parsed = IngestRequest.safeParse(request([{ r: 'event', id: 'e1', ts: 1, body }]));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const record = parsed.data.records[0];
    if (record?.r !== 'event') return;
    expect('raw' in record.body).toBe(false);
  });

  it('rejects a missing or wrong version', () => {
    const bad = {
      deviceId: 'laptop-1',
      cursor: { ts: 0, id: '' },
      records: [eventRecord('e1', 1)],
    };
    expect(IngestRequest.safeParse(bad).success).toBe(false);
    expect(IngestRequest.safeParse({ ...bad, v: 2 }).success).toBe(false);
  });

  it('rejects empty and oversized batches', () => {
    expect(IngestRequest.safeParse(request([])).success).toBe(false);
    const flood = Array.from({ length: 501 }, (_, i) => eventRecord(`e${i}`, i));
    expect(IngestRequest.safeParse(request(flood)).success).toBe(false);
  });

  it('rejects unknown record kinds', () => {
    expect(
      IngestRequest.safeParse(request([{ r: 'trace', id: 't1', ts: 1, body: {} }])).success,
    ).toBe(false);
  });

  it('rejects device ids outside 8-64 characters', () => {
    const records = [eventRecord('e1', 1)];
    expect(IngestRequest.safeParse(request(records, 'short')).success).toBe(false);
    expect(IngestRequest.safeParse(request(records, 'd'.repeat(65))).success).toBe(false);
  });

  it('rejects an event body that is not a known stored event', () => {
    const body = { id: 'e1', ts: 1, source: 'osquery', kind: 'process.exec', process: 17 };
    expect(IngestRequest.safeParse(request([{ r: 'event', id: 'e1', ts: 1, body }])).success).toBe(
      false,
    );
  });

  it('rejects a record without a body', () => {
    expect(IngestRequest.safeParse(request([{ r: 'action', id: 'x1', ts: 1 }])).success).toBe(
      false,
    );
  });
});

describe('IngestAck', () => {
  it('round-trips an ack', () => {
    const ack = { v: 1, accepted: 3, duplicates: 2, ackedCursor: { ts: 5, id: 'e5' } };
    expect(IngestAck.parse(ack)).toEqual(ack);
  });
});
