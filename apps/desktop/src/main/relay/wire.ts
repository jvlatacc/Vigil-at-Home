import { z } from 'zod';

/**
 * STAND-IN wire contract — delete on rebase. The same schemas ship in
 * `@vigil/core` (packages/core/src/relay.ts) with the wire-schemas PR; until
 * that lands on the release branch, the desktop wiring needs them to build
 * batches and read acks. Shapes follow the spec (art_LARpVYcu §2) and the
 * structural contract the e2e suite already reads against.
 */

/** The shipper's position: every record at or before (ts, id) is shipped or skipped. */
export const Cursor = z.object({ ts: z.number(), id: z.string() });
export type Cursor = z.infer<typeof Cursor>;

/** One record on the wire. Event and alert bodies are the stored, slimmed forms (no raw). */
export const ShipRecord = z.discriminatedUnion('r', [
  z.object({ r: z.literal('event'), id: z.string(), ts: z.number(), body: z.unknown() }),
  z.object({ r: z.literal('alert'), id: z.string(), ts: z.number(), body: z.unknown() }),
  z.object({ r: z.literal('action'), id: z.string(), ts: z.number(), body: z.unknown() }),
  z.object({
    r: z.literal('rule'),
    id: z.string(),
    ts: z.number(),
    version: z.number(),
    body: z.unknown(),
  }),
]);
export type ShipRecord = z.infer<typeof ShipRecord>;

export const MAX_RECORDS_PER_BATCH = 500;

export const IngestRequest = z.object({
  v: z.literal(1),
  deviceId: z.string(),
  /** The position this batch continues from; the ack moves it. */
  cursor: Cursor,
  records: z.array(ShipRecord).min(1).max(MAX_RECORDS_PER_BATCH),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const IngestAck = z.object({
  v: z.literal(1),
  accepted: z.number(),
  /** Replayed ids the relay already stored. */
  duplicates: z.number(),
  ackedCursor: Cursor,
});
export type IngestAck = z.infer<typeof IngestAck>;
