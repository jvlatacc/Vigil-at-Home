import { z } from 'zod';
import {
  AgentToolRequestEvent,
  Alert,
  BrowserExtensionEvent,
  FileEvent,
  Id,
  NetworkConnectionEvent,
  NetworkListenEvent,
  PersistenceEvent,
  ProcessExecEvent,
  ProcessExitEvent,
  SantaDecisionEvent,
  SystemAlertEvent,
  Timestamp,
} from '@vigil/core';

/**
 * The shipper ↔ relay wire contract, version 1.
 *
 * Vendored from the wire-schemas PR, which will land these schemas in
 * `packages/core/src/relay.ts` per the spec's locked placement decision.
 * When that PR merges, delete this file and re-export the same names from
 * '@vigil/core' — the definitions follow the agreed spec, so the swap is a
 * rename and this file's tests move next to it.
 */

/** The laptop that ships telemetry, as provisioned by `relay provision --device`. */
export const DeviceId = z.string().min(8).max(64);
export type DeviceId = z.infer<typeof DeviceId>;

/** The shipper's last-acked position. The relay tracks its own; this is the shipper's view. */
export const IngestCursor = z.object({ ts: z.number(), id: z.string() });
export type IngestCursor = z.infer<typeof IngestCursor>;

/** Event bodies as stored by Vigil: everything but the sensor's raw record. */
export const EventBody = z.union([
  ProcessExecEvent.omit({ raw: true }),
  ProcessExitEvent.omit({ raw: true }),
  FileEvent.omit({ raw: true }),
  NetworkConnectionEvent.omit({ raw: true }),
  PersistenceEvent.omit({ raw: true }),
  SantaDecisionEvent.omit({ raw: true }),
  NetworkListenEvent.omit({ raw: true }),
  BrowserExtensionEvent.omit({ raw: true }),
  SystemAlertEvent.omit({ raw: true }),
  AgentToolRequestEvent.omit({ raw: true }),
]);
export type EventBody = z.infer<typeof EventBody>;

export const ShipRecord = z.discriminatedUnion('r', [
  z.object({ r: z.literal('event'), id: Id, ts: Timestamp, body: EventBody }),
  z.object({ r: z.literal('alert'), id: Id, ts: Timestamp, body: Alert }),
  z.object({ r: z.literal('action'), id: Id, ts: Timestamp, body: z.unknown() }),
  z.object({
    r: z.literal('rule'),
    id: Id,
    ts: Timestamp,
    version: z.number().int().nonnegative(),
    body: z.unknown(),
  }),
]);
export type ShipRecord = z.infer<typeof ShipRecord>;

export const IngestRequest = z.object({
  v: z.literal(1),
  deviceId: DeviceId,
  cursor: IngestCursor,
  records: z.array(ShipRecord).min(1).max(500),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

export const IngestAck = z.object({
  v: z.literal(1),
  accepted: z.number().int().nonnegative(),
  /** Records the relay already stored: replayed, counted, nothing stored twice. */
  duplicates: z.number().int().nonnegative(),
  ackedCursor: IngestCursor,
});
export type IngestAck = z.infer<typeof IngestAck>;
