import { describe, expect, it } from 'vitest';
import {
  buildNetFlowV9DataPacket,
  buildNetFlowV9OptionsTemplatePacket,
  buildNetFlowV9TemplatePacket,
  CANONICAL_FLOW_TEMPLATE,
  encodeFieldBE,
  encodeV9CanonicalRecord,
  type V9TemplateSpec,
} from '../golden';
import { NetFlowV9Decoder } from './v9';

const EXPORTER = '192.168.1.1';
const header = { sysUptimeMs: 10000, unixSecs: 1789000000, unixNsecs: 500_000_000 };

const canonicalRecords = () => [
  encodeV9CanonicalRecord({
    src: '192.168.1.20',
    dst: '93.184.216.34',
    srcPort: 52000,
    dstPort: 443,
    bytes: 1500,
    packets: 10,
    protocol: 6,
    tos: 4,
    tcpFlags: 27,
    firstUptimeMs: 1000,
    lastUptimeMs: 5000,
  }),
  encodeV9CanonicalRecord({
    src: '10.0.0.2',
    dst: '10.0.0.3',
    srcPort: 5353,
    dstPort: 5353,
    bytes: 90,
    packets: 1,
    protocol: 17,
    tos: 0,
    tcpFlags: 0,
    firstUptimeMs: 6000,
    lastUptimeMs: 6100,
  }),
];

const templatePacket = () =>
  buildNetFlowV9TemplatePacket({ ...header, sourceId: 42, templates: [CANONICAL_FLOW_TEMPLATE] });

describe('NetFlowV9Decoder', () => {
  it('decodes template-then-data packets across separate datagrams', () => {
    const decoder = new NetFlowV9Decoder();
    expect(decoder.decode(templatePacket(), EXPORTER)).toEqual([]);
    const flows = decoder.decode(
      buildNetFlowV9DataPacket({
        ...header,
        sourceId: 42,
        sets: [{ templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords() }],
      }),
      EXPORTER,
    );
    expect(flows).toHaveLength(2);
    expect(flows[0]).toEqual({
      version: 9,
      engineId: '42',
      flow: {
        srcAddress: '192.168.1.20',
        dstAddress: '93.184.216.34',
        srcPort: 52000,
        dstPort: 443,
        packets: 10,
        bytes: 1500,
        protocol: 6,
        tos: 4,
        tcpFlags: 27,
        firstSwitchedMs: 1788999991500,
        lastSwitchedMs: 1788999995500,
      },
    });
    expect(flows[1]!.flow.srcPort).toBe(5353);
    expect(flows[1]!.flow.protocol).toBe(17);
  });

  it('decodes a multi-record packet that carries template and data sets together', () => {
    const decoder = new NetFlowV9Decoder();
    const dataPacket = buildNetFlowV9DataPacket({
      ...header,
      sourceId: 42,
      sets: [{ templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords() }],
    });
    // Merge: template packet followed by the data packet's sets (header stripped).
    const merged = Buffer.concat([templatePacket(), dataPacket.subarray(24)]);
    const flows = decoder.decode(merged, EXPORTER);
    expect(flows).toHaveLength(2);
  });

  it('throws when a data set references a template that was never announced', () => {
    const decoder = new NetFlowV9Decoder();
    expect(() =>
      decoder.decode(
        buildNetFlowV9DataPacket({
          ...header,
          sourceId: 42,
          sets: [{ templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords() }],
        }),
        EXPORTER,
      ),
    ).toThrow(/unknown template/);
  });

  it('scopes templates per exporter, so another source id sees no template', () => {
    const decoder = new NetFlowV9Decoder();
    decoder.decode(
      buildNetFlowV9TemplatePacket({
        ...header,
        sourceId: 1,
        templates: [CANONICAL_FLOW_TEMPLATE],
      }),
      EXPORTER,
    );
    expect(() =>
      decoder.decode(
        buildNetFlowV9DataPacket({
          ...header,
          sourceId: 2,
          sets: [{ templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords() }],
        }),
        EXPORTER,
      ),
    ).toThrow(/unknown template/);
  });

  it('parses options templates and skips their data sets', () => {
    const decoder = new NetFlowV9Decoder();
    decoder.decode(
      buildNetFlowV9OptionsTemplatePacket({
        ...header,
        sourceId: 42,
        templates: [
          {
            id: 257,
            scopeFields: [[1, 4]],
            optionFields: [
              [50, 2],
              [51, 2],
            ],
          },
        ],
      }),
      EXPORTER,
    );
    const flows = decoder.decode(
      buildNetFlowV9DataPacket({
        ...header,
        sourceId: 42,
        sets: [{ templateId: 257, records: [Buffer.alloc(8)] }],
      }),
      EXPORTER,
    );
    expect(flows).toEqual([]);
  });

  it('tolerates end-of-set padding below one record length', () => {
    const decoder = new NetFlowV9Decoder();
    decoder.decode(templatePacket(), EXPORTER);
    const flows = decoder.decode(
      buildNetFlowV9DataPacket({
        ...header,
        sourceId: 42,
        sets: [
          { templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords(), padBytes: 2 },
        ],
      }),
      EXPORTER,
    );
    expect(flows).toHaveLength(2);
  });

  it('stays aligned across enterprise (PEN) field specs', () => {
    const decoder = new NetFlowV9Decoder();
    // Hand-built template 1025: enterprise spec (type 40000|0x8000, len 4,
    // PEN 32473) followed by src/dst addresses, ports, and counters.
    const entry = Buffer.alloc(4 + 8 + 6 * 4);
    entry.writeUInt16BE(1025, 0);
    entry.writeUInt16BE(7, 2);
    entry.writeUInt16BE(40000 | 0x8000, 4);
    entry.writeUInt16BE(4, 6);
    entry.writeUInt32BE(32473, 8); // PEN — skipped by the parser
    entry.writeUInt16BE(8, 12); // ipv4_src_addr
    entry.writeUInt16BE(4, 14);
    entry.writeUInt16BE(12, 16); // ipv4_dst_addr
    entry.writeUInt16BE(4, 18);
    entry.writeUInt16BE(7, 20); // l4_src_port
    entry.writeUInt16BE(2, 22);
    entry.writeUInt16BE(11, 24); // l4_dst_port
    entry.writeUInt16BE(2, 26);
    entry.writeUInt16BE(1, 28); // in_bytes
    entry.writeUInt16BE(4, 30);
    entry.writeUInt16BE(2, 32); // in_pkts
    entry.writeUInt16BE(4, 34);
    const set = Buffer.alloc(4 + entry.length);
    set.writeUInt16BE(0, 0);
    set.writeUInt16BE(set.length, 2);
    entry.copy(set, 4);
    const v9header = Buffer.alloc(24);
    v9header.writeUInt16BE(9, 0);
    v9header.writeUInt32BE(7, 20);
    decoder.decode(Buffer.concat([v9header, set]), EXPORTER);
    const record = Buffer.concat([
      encodeFieldBE(42, 4), // the enterprise element's own bytes — parsed, never mapped
      encodeFieldBE(0x0a000009, 4), // 10.0.0.9
      encodeFieldBE(0x0a00000a, 4), // 10.0.0.10
      encodeFieldBE(1234, 2),
      encodeFieldBE(80, 2),
      encodeFieldBE(500, 4),
      encodeFieldBE(5, 4),
    ]);
    const flows = decoder.decode(
      buildNetFlowV9DataPacket({
        ...header,
        sourceId: 7,
        sets: [{ templateId: 1025, records: [record] }],
      }),
      EXPORTER,
    );
    expect(flows[0]!.flow.srcAddress).toBe('10.0.0.9');
    expect(flows[0]!.flow.dstAddress).toBe('10.0.0.10');
    expect(flows[0]!.flow.srcPort).toBe(1234);
    expect(flows[0]!.flow.bytes).toBe(500);
    expect(flows[0]!.flow.packets).toBe(5);
  });

  it('rejects a mutated fixture: set length overruns the packet', () => {
    const decoder = new NetFlowV9Decoder();
    decoder.decode(templatePacket(), EXPORTER);
    const dataPacket = buildNetFlowV9DataPacket({
      ...header,
      sourceId: 42,
      sets: [{ templateId: CANONICAL_FLOW_TEMPLATE.id, records: canonicalRecords() }],
    });
    dataPacket.writeUInt16BE(0xffff, 24 + 2);
    expect(() => decoder.decode(dataPacket, EXPORTER)).toThrow(/overruns/);
  });

  it('rejects a mutated fixture: flipped version byte', () => {
    const decoder = new NetFlowV9Decoder();
    const packet = templatePacket();
    packet.writeUInt16BE(8, 0);
    expect(() => decoder.decode(packet, EXPORTER)).toThrow(/not a v9/);
  });

  it('maps IPv6 addresses through the same canonical record shape', () => {
    const ipv6Template: V9TemplateSpec = {
      id: 1026,
      fields: [
        [27, 16], // ipv6_src_addr
        [28, 16], // ipv6_dst_addr
        [7, 2],
        [11, 2],
        [1, 4],
        [2, 4],
      ],
    };
    const decoder = new NetFlowV9Decoder();
    decoder.decode(
      buildNetFlowV9TemplatePacket({ ...header, sourceId: 42, templates: [ipv6Template] }),
      EXPORTER,
    );
    const record = Buffer.concat([
      ipv6ToBytes('2001:db8::1'),
      ipv6ToBytes('2001:db8::2'),
      encodeV9Ports(),
      encodeV9Counters(),
    ]);
    const flows = decoder.decode(
      buildNetFlowV9DataPacket({
        ...header,
        sourceId: 42,
        sets: [{ templateId: 1026, records: [record] }],
      }),
      EXPORTER,
    );
    expect(flows[0]!.flow.srcAddress).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(flows[0]!.flow.dstAddress).toBe('2001:0db8:0000:0000:0000:0000:0000:0002');
  });
});

function ipv6ToBytes(address: string): Buffer {
  const [headPart, tailPart] = address.split('::');
  const head = (headPart ?? '')
    .split(':')
    .filter(Boolean)
    .map((word) => parseInt(word, 16));
  const tail = (tailPart ?? '')
    .split(':')
    .filter(Boolean)
    .map((word) => parseInt(word, 16));
  const missing = 8 - head.length - tail.length;
  const hextets = [...head, ...new Array<number>(missing).fill(0), ...tail];
  const buf = Buffer.alloc(16);
  hextets.forEach((hextet, i) => buf.writeUInt16BE(hextet, i * 2));
  return buf;
}

function encodeV9Ports(): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(52000, 0);
  buf.writeUInt16BE(443, 2);
  return buf;
}

function encodeV9Counters(): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(1500, 0);
  buf.writeUInt32BE(10, 4);
  return buf;
}
