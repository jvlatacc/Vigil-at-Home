import { z } from 'zod';
import { Alert } from './alert.js';
import { Id, Timestamp } from './common.js';
import {
  AgentToolRequestEvent,
  BrowserExtensionEvent,
  FileEvent,
  NetworkConnectionEvent,
  NetworkListenEvent,
  PersistenceEvent,
  ProcessExecEvent,
  ProcessExitEvent,
  SantaDecisionEvent,
  SystemAlertEvent,
} from './event.js';

/**
 * The wire contract between a laptop's shipper and the relay: what the
 * shipper pushes (IngestRequest) and what the relay answers (IngestAck).
 * Push is one-way HTTPS — the shipper only ever sends — and every record
 * carries its position in the device's stream on the envelope, so each type
 * has one identity for dedupe and cursor accounting even where its body is
 * opaque. The `v` literals let either end refuse a version it cannot read.
 */

/** House batch discipline: the app's event log flushes every second or 500 records. */
export const MAX_BATCH_RECORDS = 500;

/**
 * The event body as shipped: the sensor event without `raw`. The sensor's
 * original record never leaves the machine — stored events are the slimmed
 * form (docs/performance.md drops `raw` because no rule reads it) — and if a
 * caller includes it anyway, this boundary strips it.
 */
export const EventBody = z.discriminatedUnion('kind', [
  ProcessExecEvent.omit({ raw: true }),
  ProcessExitEvent.omit({ raw: true }),
  FileEvent.omit({ raw: true }),
  NetworkConnectionEvent.omit({ raw: true }),
  NetworkListenEvent.omit({ raw: true }),
  PersistenceEvent.omit({ raw: true }),
  SantaDecisionEvent.omit({ raw: true }),
  BrowserExtensionEvent.omit({ raw: true }),
  SystemAlertEvent.omit({ raw: true }),
  AgentToolRequestEvent.omit({ raw: true }),
]);
export type EventBody = z.infer<typeof EventBody>;

/**
 * The alert body as shipped: the stored alert as it is, AI assessment and
 * user decision included — the SOC sees what the laptop saw. Its own name
 * keeps the contract in one place even if the stored alert later grows
 * fields the relay must not hold.
 */
export const AlertBody = Alert;
export type AlertBody = z.infer<typeof AlertBody>;

/**
 * A position in a device's shipped stream, keyed by (ts, id) — the same
 * keyset the event log is ordered by: the record's time first, then its id.
 */
export const Cursor = z.object({ ts: Timestamp, id: Id });
export type Cursor = z.infer<typeof Cursor>;

/**
 * One record in a pushed batch. `r` discriminates; the envelope's (ts, id)
 * is the record's position, so action and rule bodies can stay opaque and
 * the ack can still advance the cursor. Rule bodies ship whole, exclusions
 * included: hiding them (count only) is the relay's MCP face, not this
 * wire's job.
 */
export const ShipRecord = z.discriminatedUnion('r', [
  z.object({ r: z.literal('event'), id: Id, ts: Timestamp, body: EventBody }),
  z.object({ r: z.literal('alert'), id: Id, ts: Timestamp, body: AlertBody }),
  // The action log row as stored; the relay holds and serves it without reading inside.
  z.object({ r: z.literal('action'), id: Id, ts: Timestamp, body: z.unknown() }),
  // The stored rule, with its version on the envelope.
  z.object({
    r: z.literal('rule'),
    id: Id,
    version: z.number().int().positive(),
    body: z.unknown(),
  }),
]);
export type ShipRecord = z.infer<typeof ShipRecord>;

/** What the shipper pushes: at least one record, at most {@link MAX_BATCH_RECORDS}. */
export const IngestRequest = z.object({
  v: z.literal(1),
  deviceId: z.string().min(8).max(64),
  /**
   * The shipper's last-acked position. Dedupe is id-based — record ids are
   * unique per device — so a batch replayed after a crash is counted in the
   * ack's duplicates and never stored twice.
   */
  cursor: Cursor,
  records: z.array(ShipRecord).min(1).max(MAX_BATCH_RECORDS),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

/**
 * The relay's answer to a batch: what it stored, what it already had, and
 * the position now acked — the shipper advances its cursor there, and the
 * cursor moves on an ack alone.
 */
export const IngestAck = z.object({
  v: z.literal(1),
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  ackedCursor: Cursor,
});
export type IngestAck = z.infer<typeof IngestAck>;
