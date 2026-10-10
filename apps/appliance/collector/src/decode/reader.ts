import { NetFlowDecodeError } from './types';

/**
 * Big-endian unsigned integer of `size` bytes (1..8) at `offset`.
 * Fields up to 6 bytes use Node's readUIntBE; 7- and 8-byte counters
 * accumulate byte-by-byte to avoid the 8-byte read overrunning the packet.
 */
export function readUint(buf: Buffer, offset: number, size: number): number {
  if (offset + size > buf.length)
    throw new NetFlowDecodeError(`field at ${offset} overruns packet`);
  if (size <= 6) return buf.readUIntBE(offset, size);
  let value = 0n;
  for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(buf.readUInt8(offset + i));
  return Number(value);
}

/** IPv4 dotted quad from a big-endian uint32. */
export function formatIpv4(u32: number): string {
  return [(u32 >>> 24) & 0xff, (u32 >>> 16) & 0xff, (u32 >>> 8) & 0xff, u32 & 0xff].join('.');
}

/** IPv6 in full hextet form (no compression — valid, if verbose). */
export function formatIpv6(buf: Buffer, offset: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2)
    parts.push(
      buf
        .readUInt16BE(offset + i)
        .toString(16)
        .padStart(4, '0'),
    );
  return parts.join(':');
}

/** Address string for an address information element by its byte length. */
export function formatAddress(buf: Buffer, offset: number, size: number): string {
  if (size === 4) return formatIpv4(buf.readUInt32BE(offset));
  if (size === 16) return formatIpv6(buf, offset);
  // Unknown address width — hex preserves the bytes without inventing structure.
  return buf.subarray(offset, offset + size).toString('hex');
}
