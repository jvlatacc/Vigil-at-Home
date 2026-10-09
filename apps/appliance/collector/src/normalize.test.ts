import { describe, expect, it } from 'vitest';
import type { DecodedFlow } from './decode/types';
import { flowToRecord } from './normalize';

const flow: DecodedFlow = {
  version: 9,
  engineId: '42',
  flow: {
    firstSwitchedMs: 1000,
    lastSwitchedMs: 2000,
    packets: 3,
    bytes: 300,
    protocol: 6,
    srcPort: 52000,
    dstPort: 443,
    tcpFlags: 27,
    tos: 4,
    srcAddress: '192.168.1.20',
    dstAddress: '93.184.216.34',
  },
};

describe('flowToRecord', () => {
  it('maps a decoded flow to a normalized netflow record', () => {
    const record = flowToRecord(flow, '192.168.1.1', '2026-10-09T12:00:00.000Z');
    expect(record).toEqual({
      schema: 'vigil.flow.v1',
      source: 'netflow',
      receivedAt: '2026-10-09T12:00:00.000Z',
      exporter: { address: '192.168.1.1', version: 9, engineId: '42' },
      flow: flow.flow,
    });
  });

  it('preserves a null engine id for version 5 exporters without one', () => {
    const record = flowToRecord(
      { ...flow, version: 5, engineId: null },
      '192.168.1.1',
      '2026-10-09T12:00:00.000Z',
    );
    expect(record.exporter.engineId).toBeNull();
    expect(record.exporter.version).toBe(5);
  });
});
