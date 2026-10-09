import type { Cursor } from '@vigil/core';
import type {
  RuleSnapshot,
  ShipperStore,
  StoredAction,
  StoredAlert,
  StoredEvent,
} from '@vigil/shipper';
import type { Store } from '../db/store.js';

/**
 * Reads Vigil's own tables the way `@vigil/shipper`'s `ShipperStore` seam
 * expects. Keyset-ordered by (ts, id), so a replay after a crash re-reads
 * exactly the unacked span. The engine builds the wire records and redacts
 * the bodies; this adapter only hands over the stored forms.
 */
export class DesktopRelaySource implements ShipperStore {
  constructor(private readonly store: Store) {}

  eventsSince(cursor: Cursor, limit: number): Promise<StoredEvent[]> {
    return Promise.resolve(this.store.relayEventsSince(cursor, limit));
  }

  alertsSince(cursor: Cursor, limit: number): Promise<StoredAlert[]> {
    return Promise.resolve(this.store.relayAlertsSince(cursor, limit));
  }

  actionsSince(cursor: Cursor, limit: number): Promise<StoredAction[]> {
    return Promise.resolve(this.store.relayActionsSince(cursor, limit));
  }

  rulesIfChanged(shippedVersion: number | undefined): Promise<RuleSnapshot | undefined> {
    const snapshot = this.store.relayRulesIfChanged(shippedVersion ?? null);
    if (!snapshot) return Promise.resolve(undefined);
    // One snapshot per device: a stable id, the moving version on the envelope.
    return Promise.resolve({
      id: 'rules',
      version: snapshot.version,
      body: { rules: snapshot.rules },
    });
  }

  oldestEvent(): Promise<Cursor | undefined> {
    return Promise.resolve(this.store.relayOldestEvent() ?? undefined);
  }
}
