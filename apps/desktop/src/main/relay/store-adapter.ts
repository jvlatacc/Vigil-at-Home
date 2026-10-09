import type { Store } from '../db/store.js';
import type { ShipperStore } from './engine.js';
import type { Cursor, ShipRecord } from './wire.js';

/**
 * Reads Vigil's own tables as shipper records — the adapter that plugs the
 * app's store into the engine's ShipperStore seam. Keyset-ordered by (ts, id),
 * so a replay after a crash re-reads exactly the unacked span.
 */
export class DesktopRelaySource implements ShipperStore {
  constructor(private readonly store: Store) {}

  eventsSince(cursor: Cursor | null, limit: number): ShipRecord[] {
    return this.store
      .relayEventsSince(cursor ?? { ts: 0, id: '' }, limit)
      .map((e) => ({ r: 'event' as const, id: e.id, ts: e.ts, body: e.body }));
  }

  alertsSince(cursor: Cursor | null, limit: number): ShipRecord[] {
    return this.store
      .relayAlertsSince(cursor ?? { ts: 0, id: '' }, limit)
      .map((a) => ({ r: 'alert' as const, id: a.id, ts: a.ts, body: a.body }));
  }

  actionsSince(cursor: Cursor | null, limit: number): ShipRecord[] {
    return this.store
      .relayActionsSince(cursor ?? { ts: 0, id: '' }, limit)
      .map((a) => ({ r: 'action' as const, id: a.id, ts: a.ts, body: a.body }));
  }

  rulesIfChanged(version: number | null): ShipRecord[] {
    const snapshot = this.store.relayRulesIfChanged(version);
    if (!snapshot) return [];
    const ts = snapshot.rules.reduce((m, r) => Math.max(m, r.updatedAt), 0);
    return snapshot.rules.map((rule) => ({
      r: 'rule' as const,
      id: rule.id,
      ts,
      version: snapshot.version,
      body: rule,
    }));
  }

  oldestEvent(): Cursor | null {
    return this.store.relayOldestEvent();
  }
}
