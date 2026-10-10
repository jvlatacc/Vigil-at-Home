import { describe, expect, it } from 'vitest';
import {
  buildIpfixDataPacket,
  buildIpfixOptionsTemplatePacket,
  buildIpfixTemplatePacket,
  IPFIX_FLOW_TEMPLATE,
  encodeFieldBE,
  encodeIpfixCanonicalRecord,
} from '../golden';
import { IpfixDecoder } from './ipfix';

const EXPORTER = '192.168.1.1';
const exportTimeSec = 1789000000;

const canonicalRecords = () => [
  encodeIpfixCanonicalRecord({
    src: '192.168.1.20',
    dst: '93.184.216.34',
    srcPort: 52000,
    dstPort: 443,
    bytes: 1500,
    packets: 10,
    protocol: 6,
    tos: 4,
    tcpFlags: 27,
    firstMs: 1788999991500,
    lastMs: 1788999995500,
  }),
  encodeIpfixCanonicalRecord({
    src: '10.0.0.2',
    dst: '10.0.0.3',
    srcPort: 5353,
    dstPort: 5353,
    bytes: 90,
    packets: 1,
    protocol: 17,
    tos: 0,
    tcpFlags: 0,
    firstMs: 1788999996500,
    lastMs: 1788999996600,
  }),
];

const templatePacket = () =>
  buildIpfixTemplatePacket({ exportTimeSec, domainId: 7, templates: [IPFIX_FLOW_TEMPLATE] });

const dataPacket = (padBytes = 0) =>
  buildIpfixDataPacket({
    exportTimeSec,
    domainId: 7,
    sets: [{ templateId: IPFIX_FLOW_TEMPLATE.id, records: canonicalRecords(), padBytes }],
  });

describe('IpfixDecoder', () => {
  it('decodes a template message followed by a data message', () => {
    const decoder = new IpfixDecoder();
    expect(decoder.decode(templatePacket(), EXPORTER)).toEqual([]);
    const flows = decoder.decode(dataPacket(), EXPORTER);
    expect(flows).toHaveLength(2);
    expect(flows[0]).toEqual({
      version: 10,
      engineId: '7',
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

  it('tolerates 4-byte alignment padding inside a data set', () => {
    const decoder = new IpfixDecoder();
    decoder.decode(templatePacket(), EXPORTER);
    // Two 47-byte records = 94 bytes; padded to 96 for 4-byte alignment.
    const flows = decoder.decode(dataPacket(2), EXPORTER);
    expect(flows).toHaveLength(2);
    expect(flows[0]!.flow.bytes).toBe(1500);
    expect(flows[1]!.flow.srcAddress).toBe('10.0.0.2');
  });

  it('accepts legacy v9 element numbers and seconds-precision timestamps', () => {
    const template = {
      id: 1025,
      fields: [
        [8, 4], // ipv4_src_addr (legacy number)
        [12, 4],
        [7, 2],
        [11, 2],
        [1, 4], // in_bytes (legacy)
        [2, 4], // in_pkts (legacy)
        [150, 4], // flow_start_seconds
        [151, 4], // flow_end_seconds
      ],
    } as const;
    const decoder = new IpfixDecoder();
    decoder.decode(
      buildIpfixTemplatePacket({ exportTimeSec, domainId: 7, templates: [template] }),
      EXPORTER,
    );
    const flows = decoder.decode(
      buildIpfixDataPacket({
        exportTimeSec,
        domainId: 7,
        sets: [
          {
            templateId: 1025,
            records: [
              Buffer.concat([
                encodeFieldBE(0x0a000009, 4),
                encodeFieldBE(0x0a00000a, 4),
                encodeFieldBE(1234, 2),
                encodeFieldBE(80, 2),
                encodeFieldBE(500, 4),
                encodeFieldBE(5, 4),
                encodeFieldBE(1788999990, 4),
                encodeFieldBE(1788999995, 4),
              ]),
            ],
          },
        ],
      }),
      EXPORTER,
    );
    expect(flows[0]!.flow.bytes).toBe(500);
    expect(flows[0]!.flow.packets).toBe(5);
    expect(flows[0]!.flow.firstSwitchedMs).toBe(1788999990000);
    expect(flows[0]!.flow.lastSwitchedMs).toBe(1788999995000);
  });

  it('parses options templates and skips their data sets', () => {
    const decoder = new IpfixDecoder();
    decoder.decode(
      buildIpfixOptionsTemplatePacket({
        exportTimeSec,
        domainId: 7,
        templates: [
          {
            id: 257,
            scopeFieldCount: 1,
            fields: [
              [1, 4],
              [50, 2],
            ],
          },
        ],
      }),
      EXPORTER,
    );
    const flows = decoder.decode(
      buildIpfixDataPacket({
        exportTimeSec,
        domainId: 7,
        sets: [{ templateId: 257, records: [Buffer.alloc(6)] }],
      }),
      EXPORTER,
    );
    expect(flows).toEqual([]);
  });

  it('removes a template on a zero-field-count withdrawal and rejects its data afterwards', () => {
    const decoder = new IpfixDecoder();
    decoder.decode(templatePacket(), EXPORTER);
    // Withdrawal set: setId 2, length 8, body = (templateId, fieldCount 0).
    const withdrawal = Buffer.alloc(16 + 8);
    withdrawal.writeUInt16BE(10, 0);
    withdrawal.writeUInt16BE(24, 2); // message length: 16-byte header + 8-byte set
    withdrawal.writeUInt32BE(exportTimeSec, 4);
    withdrawal.writeUInt32BE(7, 12);
    withdrawal.writeUInt16BE(2, 16); // template set
    withdrawal.writeUInt16BE(8, 18); // set length
    withdrawal.writeUInt16BE(IPFIX_FLOW_TEMPLATE.id, 20);
    withdrawal.writeUInt16BE(0, 22); // fieldCount 0 — withdrawal
    decoder.decode(withdrawal, EXPORTER);
    expect(() => decoder.decode(dataPacket(), EXPORTER)).toThrow(/unknown template/);
  });

  it('rejects a message length that exceeds the datagram', () => {
    const decoder = new IpfixDecoder();
    const packet = templatePacket();
    packet.writeUInt16BE(packet.length + 1, 2);
    expect(() => decoder.decode(packet, EXPORTER)).toThrow(/exceeds datagram/);
  });

  it('rejects a mutated fixture: impossible message length', () => {
    const decoder = new IpfixDecoder();
    const packet = templatePacket();
    packet.writeUInt16BE(8, 2);
    expect(() => decoder.decode(packet, EXPORTER)).toThrow(/impossible/);
  });

  it('rejects a mutated fixture: flipped version byte', () => {
    const decoder = new IpfixDecoder();
    const packet = templatePacket();
    packet.writeUInt16BE(9, 0);
    expect(() => decoder.decode(packet, EXPORTER)).toThrow(/not an IPFIX/);
  });
});
