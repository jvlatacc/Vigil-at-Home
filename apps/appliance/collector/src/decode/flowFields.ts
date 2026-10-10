import type { DecodedFlow } from './types';
import { NetFlowDecodeError } from './types';

/** Fields of one v9/IPFIX data record as mapped from its template so far. */
export interface PartialFlow {
  firstSwitchedMs?: number;
  lastSwitchedMs?: number;
  packets?: number;
  bytes?: number;
  protocol?: number;
  srcAddress?: string;
  srcPort?: number;
  dstAddress?: string;
  dstPort?: number;
  tcpFlags?: number;
  tos?: number;
}

/**
 * Fills a normalized flow from the mapped fields of one data record.
 * Records without addresses, ports, or counters are not flows — the
 * containing datagram is treated as malformed.
 * `fallbackMs` covers exporters that omit flow timestamps: the export time
 * stands in for both ends of the flow.
 */
export function completeFlow(
  partial: PartialFlow,
  version: 9 | 10,
  engineId: string | null,
  fallbackMs: number,
): DecodedFlow {
  if (
    partial.srcAddress === undefined ||
    partial.dstAddress === undefined ||
    partial.srcPort === undefined ||
    partial.dstPort === undefined ||
    partial.bytes === undefined ||
    partial.packets === undefined
  ) {
    throw new NetFlowDecodeError('data record is missing a required flow field');
  }
  return {
    version,
    engineId,
    flow: {
      firstSwitchedMs: partial.firstSwitchedMs ?? fallbackMs,
      lastSwitchedMs: partial.lastSwitchedMs ?? fallbackMs,
      packets: partial.packets,
      bytes: partial.bytes,
      // Protocol 0 (IANA HOPOPT) stands in for exporters that omit it.
      protocol: partial.protocol ?? 0,
      srcAddress: partial.srcAddress,
      srcPort: partial.srcPort,
      dstAddress: partial.dstAddress,
      dstPort: partial.dstPort,
      tcpFlags: partial.tcpFlags ?? null,
      tos: partial.tos ?? null,
    },
  };
}
