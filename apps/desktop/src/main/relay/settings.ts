import { z } from 'zod';
import { isSafeConnectorUrl } from '../../shared/pack.js';
import type { Store } from '../db/store.js';

/**
 * The telemetry relay's settings, in Vigil's settings store like every other
 * preference. Opt-in and off by default: with shipping off, nothing here runs
 * and nothing leaves the computer.
 */

/** Where the shipper pushes, and what this device calls itself. */
export const KEY_RELAY = 'telemetry.relay';

/** The shipper's last-acked position, advanced only on a relay ack. */
export const KEY_RELAY_CURSOR = 'telemetry.relay.cursor';

export const RelayConfig = z.object({
  enabled: z.boolean(),
  endpointUrl: z.string().max(2048),
  /** The name the relay knows this device by; the relay validates its shape. */
  deviceId: z.string().max(64),
});
export type RelayConfig = z.infer<typeof RelayConfig>;

export const RelayConfigPatch = RelayConfig.partial();
export type RelayConfigPatch = z.input<typeof RelayConfigPatch>;

export const RelayCursor = z.object({ ts: z.number(), id: z.string() });
export type RelayCursor = z.infer<typeof RelayCursor>;

export const DEFAULT_RELAY_CONFIG: RelayConfig = { enabled: false, endpointUrl: '', deviceId: '' };

/** The device id the relay accepts (the ingest contract: min 8, max 64 chars). */
export const RelayDeviceId = z.string().min(8).max(64);

export function loadRelayConfig(store: Store): RelayConfig {
  return store.getSetting(KEY_RELAY, RelayConfig, DEFAULT_RELAY_CONFIG);
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
