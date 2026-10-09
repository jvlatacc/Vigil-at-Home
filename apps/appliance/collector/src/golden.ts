import { V5_HEADER_LENGTH, V5_RECORD_LENGTH } from './decode/v5';

/** Big-endian unsigned field value encoded in exactly `length` bytes. */
export function encodeFieldBE(value: number, length: number): Buffer {
  if (length <= 6) {
    const buf = Buffer.alloc(length);
    buf.writeUIntBE(value, 0, length);
    return buf;
  }
  if (length <= 8) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(value), 0);
    return buf.subarray(8 - length);
  }
  throw new Error(`field length ${length} exceeds 8 bytes`);
}

function ipv4ToInt(dotted: string): number {
  const octets = dotted.split('.').map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`invalid ipv4 address: ${dotted}`);
  }
  return octets.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
}

// ---------------------------------------------------------------------------
// NetFlow v5

export interface V5RecordSpec {
  src: string;
  dst: string;
  nexthop?: string;
  input?: number;
  output?: number;
  packets: number;
  bytes: number;
  first: number;
  last: number;
  srcPort: number;
  dstPort: number;
  tcpFlags: number;
  protocol: number;
  tos: number;
  srcAs?: number;
  dstAs?: number;
  srcMask?: number;
  dstMask?: number;
}

export interface V5PacketSpec {
  sysUptimeMs?: number;
  unixSecs: number;
  unixNsecs?: number;
  flowSequence?: number;
  engineType?: number;
  engineId?: number;
  records: readonly V5RecordSpec[];
}

/** Builds a NetFlow v5 packet by hand: 24-byte header + 48-byte records. */
export function buildNetFlowV5Packet(spec: V5PacketSpec): Buffer {
  const buf = Buffer.alloc(V5_HEADER_LENGTH + spec.records.length * V5_RECORD_LENGTH);
  buf.writeUInt16BE(5, 0);
  buf.writeUInt16BE(spec.records.length, 2);
  buf.writeUInt32BE(spec.sysUptimeMs ?? 0, 4);
  buf.writeUInt32BE(spec.unixSecs, 8);
  buf.writeUInt32BE(spec.unixNsecs ?? 0, 12);
  buf.writeUInt32BE(spec.flowSequence ?? 0, 16);
  buf.writeUInt8(spec.engineType ?? 0, 20);
  buf.writeUInt8(spec.engineId ?? 0, 21);
  buf.writeUInt16BE(0, 22); // sampling interval
  spec.records.forEach((record, i) => {
    const base = V5_HEADER_LENGTH + i * V5_RECORD_LENGTH;
    buf.writeUInt32BE(ipv4ToInt(record.src), base);
    buf.writeUInt32BE(ipv4ToInt(record.dst), base + 4);
    buf.writeUInt32BE(ipv4ToInt(record.nexthop ?? '0.0.0.0'), base + 8);
    buf.writeUInt16BE(record.input ?? 0, base + 12);
    buf.writeUInt16BE(record.output ?? 0, base + 14);
    buf.writeUInt32BE(record.packets, base + 16);
    buf.writeUInt32BE(record.bytes, base + 20);
    buf.writeUInt32BE(record.first, base + 24);
    buf.writeUInt32BE(record.last, base + 28);
    buf.writeUInt16BE(record.srcPort, base + 32);
    buf.writeUInt16BE(record.dstPort, base + 34);
    buf.writeUInt8(0, base + 36); // pad1
    buf.writeUInt8(record.tcpFlags, base + 37);
    buf.writeUInt8(record.protocol, base + 38);
    buf.writeUInt8(record.tos, base + 39);
    buf.writeUInt16BE(record.srcAs ?? 0, base + 40);
    buf.writeUInt16BE(record.dstAs ?? 0, base + 42);
    buf.writeUInt8(record.srcMask ?? 0, base + 44);
    buf.writeUInt8(record.dstMask ?? 0, base + 45);
    buf.writeUInt16BE(0, base + 46); // pad2
  });
  return buf;
}

// ---------------------------------------------------------------------------
// NetFlow v9 / IPFIX shared plumbing

export type FieldSpec = readonly [type: number, length: number];

export interface V9TemplateSpec {
  id: number;
  fields: readonly FieldSpec[];
}

interface ExporterHeaderSpec {
  sysUptimeMs?: number;
  unixSecs: number;
  unixNsecs?: number;
  flowSequence?: number;
}

function buildSet(setId: number, body: Buffer): Buffer {
  const set = Buffer.alloc(4 + body.length);
  set.writeUInt16BE(setId, 0);
  set.writeUInt16BE(set.length, 2);
  body.copy(set, 4);
  return set;
}

function buildV9Header(spec: ExporterHeaderSpec, sourceId: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt16BE(9, 0);
  header.writeUInt16BE(0, 2); // record count — not validated by this decoder
  header.writeUInt32BE(spec.sysUptimeMs ?? 0, 4);
  header.writeUInt32BE(spec.unixSecs, 8);
  header.writeUInt32BE(spec.unixNsecs ?? 0, 12);
  header.writeUInt32BE(spec.flowSequence ?? 0, 16);
  header.writeUInt32BE(sourceId, 20);
  return header;
}

function buildIpfixHeader(exportTimeSec: number, domainId: number): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt16BE(10, 0);
  header.writeUInt16BE(0, 2); // message length — fixed up after assembly
  header.writeUInt32BE(exportTimeSec, 4);
  header.writeUInt32BE(0, 8); // sequence
  header.writeUInt32BE(domainId, 12);
  return header;
}

// ---------------------------------------------------------------------------
// NetFlow v9 packets

export function buildNetFlowV9TemplatePacket(
  spec: ExporterHeaderSpec & { sourceId: number; templates: readonly V9TemplateSpec[] },
): Buffer {
  let body = Buffer.alloc(0);
  for (const template of spec.templates) {
    const entry = Buffer.alloc(4 + template.fields.length * 4);
    entry.writeUInt16BE(template.id, 0);
    entry.writeUInt16BE(template.fields.length, 2);
    template.fields.forEach(([type, length], i) => {
      entry.writeUInt16BE(type, 4 + i * 4);
      entry.writeUInt16BE(length, 6 + i * 4);
    });
    body = Buffer.concat([body, entry]);
  }
  return Buffer.concat([buildV9Header(spec, spec.sourceId), buildSet(0, body)]);
}

export function buildNetFlowV9OptionsTemplatePacket(
  spec: ExporterHeaderSpec & {
    sourceId: number;
    templates: ReadonlyArray<{
      id: number;
      scopeFields: readonly FieldSpec[];
      optionFields: readonly FieldSpec[];
    }>;
  },
): Buffer {
  let body = Buffer.alloc(0);
  for (const template of spec.templates) {
    const scopeSpecBytes = template.scopeFields.length * 4;
    const optionSpecBytes = template.optionFields.length * 4;
    const entry = Buffer.alloc(6 + scopeSpecBytes + optionSpecBytes);
    entry.writeUInt16BE(template.id, 0);
    entry.writeUInt16BE(scopeSpecBytes, 2);
    entry.writeUInt16BE(optionSpecBytes, 4);
    let offset = 6;
    for (const [type, length] of [...template.scopeFields, ...template.optionFields]) {
      entry.writeUInt16BE(type, offset);
      entry.writeUInt16BE(length, offset + 2);
      offset += 4;
    }
    body = Buffer.concat([body, entry]);
  }
  return Buffer.concat([buildV9Header(spec, spec.sourceId), buildSet(1, body)]);
}

export interface V9DataSetSpec {
  templateId: number;
  records: readonly Buffer[];
  /** Extra zero bytes appended inside the set (end-of-set padding). */
  padBytes?: number;
}

export function buildNetFlowV9DataPacket(
  spec: ExporterHeaderSpec & { sourceId: number; sets: readonly V9DataSetSpec[] },
): Buffer {
  const sets = spec.sets.map((set) => {
    const body = Buffer.concat([...set.records, Buffer.alloc(set.padBytes ?? 0)]);
    return buildSet(set.templateId, body);
  });
  return Buffer.concat([buildV9Header(spec, spec.sourceId), ...sets]);
}

// ---------------------------------------------------------------------------
// IPFIX messages

export function buildIpfixTemplatePacket(spec: {
  exportTimeSec: number;
  domainId: number;
  templates: readonly V9TemplateSpec[];
}): Buffer {
  let body = Buffer.alloc(0);
  for (const template of spec.templates) {
    const entry = Buffer.alloc(4 + template.fields.length * 4);
    entry.writeUInt16BE(template.id, 0);
    entry.writeUInt16BE(template.fields.length, 2);
    template.fields.forEach(([type, length], i) => {
      entry.writeUInt16BE(type, 4 + i * 4);
      entry.writeUInt16BE(length, 6 + i * 4);
    });
    body = Buffer.concat([body, entry]);
  }
  const packet = Buffer.concat([
    buildIpfixHeader(spec.exportTimeSec, spec.domainId),
    buildSet(2, body),
  ]);
  packet.writeUInt16BE(packet.length, 2);
  return packet;
}

export function buildIpfixOptionsTemplatePacket(spec: {
  exportTimeSec: number;
  domainId: number;
  templates: ReadonlyArray<{ id: number; scopeFieldCount: number; fields: readonly FieldSpec[] }>;
}): Buffer {
  let body = Buffer.alloc(0);
  for (const template of spec.templates) {
    const entry = Buffer.alloc(6 + template.fields.length * 4);
    entry.writeUInt16BE(template.id, 0);
    entry.writeUInt16BE(template.fields.length, 2);
    entry.writeUInt16BE(template.scopeFieldCount, 4);
    template.fields.forEach(([type, length], i) => {
      entry.writeUInt16BE(type, 6 + i * 4);
      entry.writeUInt16BE(length, 8 + i * 4);
    });
    body = Buffer.concat([body, entry]);
  }
  const packet = Buffer.concat([
    buildIpfixHeader(spec.exportTimeSec, spec.domainId),
    buildSet(3, body),
  ]);
  packet.writeUInt16BE(packet.length, 2);
  return packet;
}

export interface IpfixDataSetSpec {
  templateId: number;
  records: readonly Buffer[];
  /** Zero padding appended inside the set (RFC 7011 3.4.3 alignment). */
  padBytes?: number;
}

export function buildIpfixDataPacket(spec: {
  exportTimeSec: number;
  domainId: number;
  sets: readonly IpfixDataSetSpec[];
}): Buffer {
  const sets = spec.sets.map((set) => {
    const body = Buffer.concat([...set.records, Buffer.alloc(set.padBytes ?? 0)]);
    return buildSet(set.templateId, body);
  });
  const packet = Buffer.concat([buildIpfixHeader(spec.exportTimeSec, spec.domainId), ...sets]);
  packet.writeUInt16BE(packet.length, 2);
  return packet;
}

/** Template for the canonical HTTP flow record shared by the v9/IPFIX tests. */
export const CANONICAL_FLOW_TEMPLATE: V9TemplateSpec = {
  id: 1024,
  fields: [
    [8, 4], // ipv4_src_addr
    [12, 4], // ipv4_dst_addr
    [7, 2], // l4_src_port
    [11, 2], // l4_dst_port
    [1, 4], // in_bytes
    [2, 4], // in_pkts
    [4, 1], // protocol
    [5, 1], // src_tos
    [6, 1], // tcp_flags
    [22, 4], // first_switched (uptime ms)
    [21, 4], // last_switched (uptime ms)
  ],
};

/**
 * RFC 7011 template for the same canonical flow, using delta counters and
 * absolute epoch-ms timestamps. Field sizes are deliberately mixed so the
 * 47-byte record exercises padding and 64-bit fields.
 */
export const IPFIX_FLOW_TEMPLATE: V9TemplateSpec = {
  id: 1024,
  fields: [
    [8, 4], // ipv4_src_addr
    [12, 4], // ipv4_dst_addr
    [7, 2], // l4_src_port
    [11, 2], // l4_dst_port
    [86, 8], // packet_delta (64-bit)
    [85, 8], // octet_delta (64-bit)
    [4, 1], // protocol
    [5, 1], // src_tos
    [6, 1], // tcp_flags
    [152, 8], // flow_start_ms (absolute)
    [153, 8], // flow_end_ms (absolute)
  ],
};

interface CanonicalFlowSpec {
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
  bytes: number;
  packets: number;
  protocol: number;
  tos: number;
  tcpFlags: number;
}

/** Encodes one CANONICAL_FLOW_TEMPLATE data record (uptime-relative times). */
export function encodeV9CanonicalRecord(
  spec: CanonicalFlowSpec & { firstUptimeMs: number; lastUptimeMs: number },
): Buffer {
  return Buffer.concat([
    encodeFieldBE(ipv4ToInt(spec.src), 4),
    encodeFieldBE(ipv4ToInt(spec.dst), 4),
    encodeFieldBE(spec.srcPort, 2),
    encodeFieldBE(spec.dstPort, 2),
    encodeFieldBE(spec.bytes, 4),
    encodeFieldBE(spec.packets, 4),
    encodeFieldBE(spec.protocol, 1),
    encodeFieldBE(spec.tos, 1),
    encodeFieldBE(spec.tcpFlags, 1),
    encodeFieldBE(spec.firstUptimeMs, 4),
    encodeFieldBE(spec.lastUptimeMs, 4),
  ]);
}

/** Encodes one IPFIX_FLOW_TEMPLATE data record (absolute epoch-ms times). */
export function encodeIpfixCanonicalRecord(
  spec: CanonicalFlowSpec & { firstMs: number; lastMs: number },
): Buffer {
  return Buffer.concat([
    encodeFieldBE(ipv4ToInt(spec.src), 4),
    encodeFieldBE(ipv4ToInt(spec.dst), 4),
    encodeFieldBE(spec.srcPort, 2),
    encodeFieldBE(spec.dstPort, 2),
    encodeFieldBE(spec.packets, 8),
    encodeFieldBE(spec.bytes, 8),
    encodeFieldBE(spec.protocol, 1),
    encodeFieldBE(spec.tos, 1),
    encodeFieldBE(spec.tcpFlags, 1),
    encodeFieldBE(spec.firstMs, 8),
    encodeFieldBE(spec.lastMs, 8),
  ]);
}
