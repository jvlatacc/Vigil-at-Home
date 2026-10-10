import { formatIpv4, readUint } from './reader';
import type { DecodedFlow } from './types';
import { NetFlowDecodeError } from './types';

export const V5_HEADER_LENGTH = 24;
export const V5_RECORD_LENGTH = 48;

export interface NetFlowV5Header {
  count: number;
  /** Milliseconds since the exporter booted (uptime at export time). */
  sysUptimeMs: number;
  /** Absolute export time, in milliseconds. */
  exportTimeMs: number;
  engineId: number;
}

export function decodeNetFlowV5Header(packet: Buffer): NetFlowV5Header {
  if (packet.length < V5_HEADER_LENGTH)
    throw new NetFlowDecodeError(`v5 header truncated (${packet.length} bytes)`);
  const version = packet.readUInt16BE(0);
  if (version !== 5) throw new NetFlowDecodeError(`not a v5 packet (version ${version})`);
  const unixSecs = readUint(packet, 8, 4);
  const unixNsecs = readUint(packet, 12, 4);
  return {
    count: packet.readUInt16BE(2),
    sysUptimeMs: readUint(packet, 4, 4),
    exportTimeMs: unixSecs * 1000 + Math.floor(unixNsecs / 1_000_000),
    engineId: packet.readUInt8(21),
  };
}

/**
 * Decodes all records of a NetFlow v5 packet — fixed 48-byte records,
 * everything big-endian. Record timestamps are uptime-relative; they are
 * absolutized with the header's export time minus the exporter's uptime.
 */
export function decodeNetFlowV5(packet: Buffer): DecodedFlow[] {
  const header = decodeNetFlowV5Header(packet);
  if (packet.length < V5_HEADER_LENGTH + header.count * V5_RECORD_LENGTH) {
    throw new NetFlowDecodeError(
      `v5 packet truncated: ${header.count} records declared, ${packet.length} bytes on the wire`,
    );
  }
  const bootMs = header.exportTimeMs - header.sysUptimeMs;
  const flows: DecodedFlow[] = [];
  for (let i = 0; i < header.count; i++) {
    const base = V5_HEADER_LENGTH + i * V5_RECORD_LENGTH;
    flows.push({
      version: 5,
      engineId: String(header.engineId),
      flow: {
        packets: readUint(packet, base + 16, 4),
        bytes: readUint(packet, base + 20, 4),
        firstSwitchedMs: bootMs + readUint(packet, base + 24, 4),
        lastSwitchedMs: bootMs + readUint(packet, base + 28, 4),
        srcPort: packet.readUInt16BE(base + 32),
        dstPort: packet.readUInt16BE(base + 34),
        tcpFlags: packet.readUInt8(base + 37),
        protocol: packet.readUInt8(base + 38),
        tos: packet.readUInt8(base + 39),
        srcAddress: formatIpv4(readUint(packet, base, 4)),
        dstAddress: formatIpv4(readUint(packet, base + 4, 4)),
      },
    });
  }
  return flows;
}
