import { describe, expect, it } from 'vitest';
import { buildNetFlowV5Packet, type V5PacketSpec, type V5RecordSpec } from '../golden';
import { decodeNetFlowV5, decodeNetFlowV5Header } from './v5';

const record: V5RecordSpec = {
  src: '192.168.1.20',
  dst: '93.184.216.34',
  nexthop: '192.168.1.1',
  packets: 10,
  bytes: 1500,
  first: 1000,
  last: 5000,
  srcPort: 52000,
  dstPort: 443,
  tcpFlags: 27,
  protocol: 6,
  tos: 4,
  srcAs: 65001,
  dstAs: 15169,
  srcMask: 24,
  dstMask: 32,
};

const packetSpec: V5PacketSpec = {
  sysUptimeMs: 10000,
  unixSecs: 1789000000,
  unixNsecs: 500_000_000,
  flowSequence: 42,
  engineType: 1,
  engineId: 7,
  records: [
    record,
    {
      ...record,
      src: '10.0.0.2',
      dst: '10.0.0.3',
      srcPort: 5353,
      dstPort: 5353,
      protocol: 17,
      packets: 1,
      bytes: 90,
      first: 6000,
      last: 6100,
      tcpFlags: 0,
      tos: 0,
    },
  ],
};

describe('decodeNetFlowV5', () => {
  it('decodes header fields', () => {
    const header = decodeNetFlowV5Header(buildNetFlowV5Packet(packetSpec));
    expect(header.count).toBe(2);
    expect(header.sysUptimeMs).toBe(10000);
    expect(header.exportTimeMs).toBe(1789000000500);
    expect(header.engineId).toBe(7);
  });

  it('decodes every record with exact field values and absolutized times', () => {
    const flows = decodeNetFlowV5(buildNetFlowV5Packet(packetSpec));
    expect(flows).toHaveLength(2);
    expect(flows[0]).toEqual({
      version: 5,
      engineId: '7',
      flow: {
        packets: 10,
        bytes: 1500,
        // export time 1789000000500 minus uptime 10000 = boot at 1788999990500
        firstSwitchedMs: 1788999991500,
        lastSwitchedMs: 1788999995500,
        srcPort: 52000,
        dstPort: 443,
        tcpFlags: 27,
        protocol: 6,
        tos: 4,
        srcAddress: '192.168.1.20',
        dstAddress: '93.184.216.34',
      },
    });
    expect(flows[1]!.flow).toEqual({
      packets: 1,
      bytes: 90,
      firstSwitchedMs: 1788999996500,
      lastSwitchedMs: 1788999996600,
      srcPort: 5353,
      dstPort: 5353,
      tcpFlags: 0,
      protocol: 17,
      tos: 0,
      srcAddress: '10.0.0.2',
      dstAddress: '10.0.0.3',
    });
  });

  it('decodes counters at the uint32 bounds', () => {
    const flows = decodeNetFlowV5(
      buildNetFlowV5Packet({
        ...packetSpec,
        records: [{ ...record, packets: 0xffffffff, bytes: 0xffffff00 }],
      }),
    );
    expect(flows[0]!.flow.packets).toBe(0xffffffff);
    expect(flows[0]!.flow.bytes).toBe(0xffffff00);
  });

  it('throws on a truncated header', () => {
    expect(() => decodeNetFlowV5(Buffer.alloc(23))).toThrow(/truncated/);
  });

  it('throws when the count field declares more records than the packet holds', () => {
    const packet = buildNetFlowV5Packet({ ...packetSpec, records: [record] });
    packet.writeUInt16BE(2, 2);
    expect(() => decodeNetFlowV5(packet)).toThrow(/truncated/);
  });

  it('rejects a mutated fixture: flipped version byte', () => {
    const packet = buildNetFlowV5Packet(packetSpec);
    packet.writeUInt16BE(4, 0);
    expect(() => decodeNetFlowV5(packet)).toThrow(/not a v5/);
  });

  it('rejects a mutated fixture: impossible record count', () => {
    const packet = buildNetFlowV5Packet(packetSpec);
    packet.writeUInt16BE(0xffff, 2);
    expect(() => decodeNetFlowV5(packet)).toThrow();
  });
});
