import { describe, expect, it } from 'vitest';
import { IngestRecord } from './record';

const validNetflowRecord = {
  schema: 'vigil.flow.v1',
  source: 'netflow',
  receivedAt: '2026-10-09T12:00:00.000Z',
  exporter: { address: '192.168.1.1', version: 5, engineId: '7' },
  flow: {
    firstSwitchedMs: 1788999991500,
    lastSwitchedMs: 1788999995500,
    packets: 10,
    bytes: 1500,
    protocol: 6,
    srcAddress: '192.168.1.20',
    srcPort: 52000,
    dstAddress: '93.184.216.34',
    dstPort: 443,
    tcpFlags: 27,
    tos: 4,
  },
};

const validOsqueryRecord = {
  schema: 'vigil.flow.v1',
  source: 'osquery',
  receivedAt: '2026-10-09T12:00:00.000Z',
  exporter: { address: '192.168.1.20', version: null, engineId: null },
  flow: null,
  raw: {
    name: 'packagename',
    hostIdentifier: 'host',
    calendarTime: 'Thu Oct  9 12:00:00 2026 UTC',
    unixTime: 1788999990,
    action: 'added',
    columns: { remote_address: '93.184.216.34', remote_port: '443', protocol: '6' },
  },
};

describe('IngestRecord', () => {
  it('accepts a valid netflow record', () => {
    const parsed = IngestRecord.parse(validNetflowRecord);
    expect(parsed.source).toBe('netflow');
    expect(parsed.flow?.dstPort).toBe(443);
  });

  it('accepts a valid osquery record with flow null and raw preserved', () => {
    const parsed = IngestRecord.parse(validOsqueryRecord);
    expect(parsed.exporter.version).toBeNull();
    expect(parsed.flow).toBeNull();
    expect(parsed.raw).toEqual(validOsqueryRecord.raw);
  });

  it('accepts a record without the optional raw field', () => {
    const { raw: _raw, ...withoutRaw } = validOsqueryRecord;
    expect(() => IngestRecord.parse(withoutRaw)).not.toThrow();
  });

  it('rejects a wrong schema literal', () => {
    expect(() => IngestRecord.parse({ ...validNetflowRecord, schema: 'vigil.flow.v2' })).toThrow();
  });

  it('rejects a non-ISO receivedAt', () => {
    expect(() =>
      IngestRecord.parse({ ...validNetflowRecord, receivedAt: '2026-10-09 12:00:00' }),
    ).toThrow();
  });

  it('rejects an unknown source', () => {
    expect(() => IngestRecord.parse({ ...validNetflowRecord, source: 'sflow' })).toThrow();
  });

  it('rejects exporter versions outside 5..10', () => {
    expect(() =>
      IngestRecord.parse({
        ...validNetflowRecord,
        exporter: { ...validNetflowRecord.exporter, version: 4 },
      }),
    ).toThrow();
    expect(() =>
      IngestRecord.parse({
        ...validNetflowRecord,
        exporter: { ...validNetflowRecord.exporter, version: 5.5 },
      }),
    ).toThrow();
  });

  it('accepts version 10 as IPFIX', () => {
    const parsed = IngestRecord.parse({
      ...validNetflowRecord,
      exporter: { ...validNetflowRecord.exporter, version: 10 },
    });
    expect(parsed.exporter.version).toBe(10);
  });

  it('rejects a flow with a negative counter', () => {
    expect(() =>
      IngestRecord.parse({
        ...validNetflowRecord,
        flow: { ...validNetflowRecord.flow, packets: -1 },
      }),
    ).toThrow();
  });
});
