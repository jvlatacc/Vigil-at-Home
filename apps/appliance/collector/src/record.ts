import { z } from 'zod';

/**
 * Every line in every spool segment, from either ingestion path: a decoded
 * NetFlow flow (source: "netflow") or an accepted osquery results-log line
 * (source: "osquery"). This is the appliance's public data contract — the
 * persistence layer consumes records exactly as defined here.
 */
export const IngestRecord = z.object({
  schema: z.literal('vigil.flow.v1'),
  /** Which ingestion path produced the record. */
  source: z.enum(['netflow', 'osquery']),
  /** Appliance clock at reception — authoritative for bucket partitioning. */
  receivedAt: z.string().datetime(),
  exporter: z.object({
    /** UDP peer for NetFlow, ingest client address for the NDJSON endpoint. */
    address: z.string(),
    /** 5 = NetFlow v5, 9 = NetFlow v9, 10 = IPFIX; null for osquery records. */
    version: z.number().int().min(5).max(10).nullable(),
    /** v5 engine id / v9 source id / IPFIX observation domain id, as text. */
    engineId: z.string().nullable(),
  }),
  /** Decoded flow fields — netflow path only; null for non-network osquery rows. */
  flow: z
    .object({
      firstSwitchedMs: z.number(),
      lastSwitchedMs: z.number(),
      packets: z.number().nonnegative(),
      bytes: z.number().nonnegative(),
      /** IANA protocol number (6 = TCP, 17 = UDP). */
      protocol: z.number(),
      srcAddress: z.string(),
      srcPort: z.number(),
      dstAddress: z.string(),
      dstPort: z.number(),
      tcpFlags: z.number().nullable(),
      tos: z.number().nullable(),
    })
    .nullable(),
  /** osquery path: the original JSON line, preserved verbatim. */
  raw: z.unknown().optional(),
});

export type IngestRecord = z.infer<typeof IngestRecord>;
