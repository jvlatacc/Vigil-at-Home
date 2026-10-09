import {
  RelayConfig,
  RelayCursor,
  RelayDeviceId,
  type RelayConfigPatch,
} from '../../shared/ipc.js';
import { isSafeConnectorUrl } from '../../shared/pack.js';
import type { Store } from '../db/store.js';

/**
 * The telemetry relay's settings, in Vigil's settings store like every other
 * preference. Opt-in and off by default: with shipping off, nothing here runs
 * and nothing leaves the computer. The schemas live in shared/ipc.ts beside
 * the other persisted-pref schemas (AgentPrefs and friends).
 */

/** Where the shipper pushes, and what this device calls itself. */
export const KEY_RELAY = 'telemetry.relay';

/** The shipper's last-acked position, advanced only on a relay ack. */
export const KEY_RELAY_CURSOR = 'telemetry.relay.cursor';

export const DEFAULT_RELAY_CONFIG: RelayConfig = { enabled: false, endpointUrl: '', deviceId: '' };

export type RelayConfigPatchInput = RelayConfigPatch;

export function loadRelayConfig(store: Store): RelayConfig {
  return store.getSetting(KEY_RELAY, RelayConfig, DEFAULT_RELAY_CONFIG);
}

export function loadRelayCursor(store: Store): RelayCursor {
  return store.getSetting(KEY_RELAY_CURSOR, RelayCursor, { ts: 0, id: '' });
}

export function saveRelayCursor(store: Store, cursor: RelayCursor): void {
  store.setSetting(KEY_RELAY_CURSOR, cursor);
}

/** Everything the shipper needs before it may run: on, a safe URL, a device id, a token. */
export function readyToShip(config: RelayConfig, tokenSaved: boolean): boolean {
  return (
    config.enabled &&
    isSafeConnectorUrl(config.endpointUrl) &&
    RelayDeviceId.safeParse(config.deviceId).success &&
    tokenSaved
  );
}
