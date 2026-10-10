/** A flow decoded from a NetFlow v5/v9 or IPFIX packet, before normalization. */
export interface DecodedFlow {
  version: 5 | 9 | 10;
  /** v5 engine id / v9 source id / IPFIX observation domain id, as text. */
  engineId: string | null;
  flow: {
    firstSwitchedMs: number;
    lastSwitchedMs: number;
    packets: number;
    bytes: number;
    protocol: number;
    srcAddress: string;
    srcPort: number;
    dstAddress: string;
    dstPort: number;
    tcpFlags: number | null;
    tos: number | null;
  };
}

/** Thrown for any datagram that cannot be decoded; the listener drops it. */
export class NetFlowDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetFlowDecodeError';
  }
}
