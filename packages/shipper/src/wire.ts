import { z } from 'zod';
import {
  AgentToolRequestEvent,
  Alert,
  BrowserExtensionEvent,
  FileEvent,
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
 * The shipper ↔ relay wire contract, as specified for the telemetry relay
 * (spec: "What we build"). This file mirrors the contract the wire-schemas
 * work item will land as `@vigil/core/relay`; when that merges to the release
 * branch, imports here move to `@vigil/core` and this file is deleted. Keep
 * the shapes byte-identical to that schema module.
 */

/** Contract version of the ingest request and its ack. */
export const WIRE_VERSION = 1;

/** The device identity the relay knows this laptop by. */
export const DeviceId = z.string().min(8).max(64);
export type DeviceId = z.infer<typeof DeviceId>;

/**
 * A stored event body: a `SensorEvent` without the sensor's raw record.
 * `raw` roughly doubles an event's size and no rule reads it; the store keeps
 * it only for events an alert refers to, and the shipper never sends it.
 */
export const EventBody = z.discriminatedUnion('kind', [
  ProcessExecEvent.omit({ raw: true }),
  ProcessExitEvent.omit({ raw: true }),
  FileEvent.omit({ raw: true }),
  NetworkConnectionEvent.omit({ raw: true }),
  NetworkListenEvent.omit({ raw: true }),
  PersistenceEvent.omit({ raw: true }),
  BrowserExtensionEvent.omit({ raw: true }),
  SystemAlertEvent.omit({ raw: true }),
  SantaDecisionEvent.omit({ raw: true }),
  AgentToolRequestEvent.omit({ raw: true }),
]);
export type EventBody = z.infer<typeof EventBody>;

/** A stored alert as the laptop holds it, AI assessment and user decision included. */
export const AlertBody = Alert;
export type AlertBody = Alert;

/** Where the stream stands: every record after this position is unsent. */
export const ShipCursor = z.object({ ts: Timestamp, id: z.string() });
export type ShipCursor = z.infer<typeof ShipCursor>;

/** One record pushed to the relay. Records are unique per device by `id`. */
export const ShipRecord = z.discriminatedUnion('r', [
  z.object({ r: z.literal('event'), id: z.string(), ts: Timestamp, body: EventBody }),
  z.object({ r: z.literal('alert'), id: z.string(), ts: Timestamp, body: AlertBody }),
  z.object({ r: z.literal('action'), id: z.string(), ts: Timestamp, body: z.unknown() }),
  z.object({
    r: z.literal('rule'),
    id: z.string(),
    version: z.number().int().positive(),
    body: z.unknown(),
  }),
]);
export type ShipRecord = z.infer<typeof ShipRecord>;

/** One ingest batch: at most 500 records, house batch discipline. */
export const IngestRequest = z.object({
  v: z.literal(WIRE_VERSION),
  deviceId: DeviceId,
  /** The shipper's last-acked position; a crash replays from here and the relay dedupes. */
  cursor: ShipCursor,
  records: z.array(ShipRecord).min(1).max(500),
});
export type IngestRequest = z.infer<typeof IngestRequest>;

/** The relay's answer to a batch: how many records landed and where the stream stands. */
export const IngestAck = z.object({
  v: z.literal(WIRE_VERSION),
  accepted: z.number().int().nonnegative(),
  /** Replayed ids the relay had already stored — the shipper counts them delivered. */
  duplicates: z.number().int().nonnegative(),
  ackedCursor: ShipCursor,
});
export type IngestAck = z.infer<typeof IngestAck>;

/**
 * The later of two cursor positions by (ts, id). The engine never lets its
 * cursor move backward, whatever the relay's ack says.
 */
export function laterCursor(a: ShipCursor, b: ShipCursor): ShipCursor {
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  if (a.id !== b.id) return a.id > b.id ? a : b;
  return a;
}
