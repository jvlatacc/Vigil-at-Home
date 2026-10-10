import type { Alert, Cursor, SensorEvent } from '@vigil/core';

/**
 * The thin read-only view of the app's own store the engine ships from. The
 * desktop app implements this against `vigil.db` (the same reader its local
 * tools use, keyset-ordered by (ts, id)); the engine owns no storage.
 *
 * All `*Since` reads return records strictly after `cursor`, ordered by
 * (ts, id), at most `limit` of them. `id` is unique per record kind, so a
 * replay after a crash is deduped by the relay and loses nothing.
 */
export interface ShipperStore {
  /** Stored events after the cursor; bodies are rehydrated `SensorEvent`s. */
  eventsSince(cursor: Cursor, limit: number): Promise<StoredEvent[]>;
  /** Raised alerts after the cursor, AI assessment and user decisions included. */
  alertsSince(cursor: Cursor, limit: number): Promise<StoredAlert[]>;
  /** Response actions the helper executed, after the cursor. */
  actionsSince(cursor: Cursor, limit: number): Promise<StoredAction[]>;
  /**
   * The device's current rules snapshot, or undefined when its version is not
   * newer than `shippedVersion` (which is undefined before the first send).
   */
  rulesIfChanged(shippedVersion: number | undefined): Promise<RuleSnapshot | undefined>;
  /**
   * The (ts, id) of the oldest event still held, or undefined when the store
   * holds none. Gap detection compares it with the cursor: if pruning has
   * moved it past the cursor, unsent records were dropped.
   */
  oldestEvent(): Promise<Cursor | undefined>;
}

/** An event read from the store. `body` may still carry `raw`; the engine strips it. */
export interface StoredEvent {
  id: string;
  ts: number;
  body: SensorEvent;
}

/** An alert read from the store, keyed by its creation time. */
export interface StoredAlert {
  id: string;
  ts: number;
  body: Alert;
}

/** A response action read from the store. The wire keeps action bodies untyped. */
export interface StoredAction {
  id: string;
  ts: number;
  body: unknown;
}

/** The device's rules snapshot. The wire keeps rule bodies untyped. */
export interface RuleSnapshot {
  id: string;
  version: number;
  body: unknown;
}
