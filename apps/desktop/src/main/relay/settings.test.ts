import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../db/store.js';
import {
  DEFAULT_RELAY_CONFIG,
  KEY_RELAY,
  RelayConfig,
  RelayCursor,
  RelayDeviceId,
  loadRelayConfig,
  readyToShip,
} from './settings.js';

const GOOD = 'https://relay.example.com';
const ID = 'macbook-of-john';

describe('relay settings', () => {
  it('defaults to off with no endpoint and round-trips a saved config', () => {
    const store = new Store(new DatabaseSync(':memory:'));
    expect(loadRelayConfig(store)).toEqual(DEFAULT_RELAY_CONFIG);
    const saved: RelayConfig = { enabled: true, endpointUrl: GOOD, deviceId: ID };
    store.setSetting(KEY_RELAY, saved);
    expect(loadRelayConfig(store)).toEqual(saved);
  });

  it('falls back to defaults on a malformed stored value', () => {
    const store = new Store(new DatabaseSync(':memory:'));
    store.setSetting(KEY_RELAY, { enabled: 'yes' });
    expect(loadRelayConfig(store)).toEqual(DEFAULT_RELAY_CONFIG);
  });

  it('reads and writes the cursor', () => {
    const store = new Store(new DatabaseSync(':memory:'));
    store.setSetting('telemetry.relay.cursor', { ts: 12, id: 'a' });
    expect(store.getSetting('telemetry.relay.cursor', RelayCursor, { ts: 0, id: '' })).toEqual({
      ts: 12,
      id: 'a',
    });
  });

  it('ships only when enabled with a safe URL, a valid device id and a token', () => {
    expect(readyToShip({ enabled: false, endpointUrl: GOOD, deviceId: ID }, true)).toBe(false);
    expect(readyToShip({ enabled: true, endpointUrl: '', deviceId: ID }, true)).toBe(false);
    expect(readyToShip({ enabled: true, endpointUrl: 'http://evil.example.com', deviceId: ID }, true)).toBe(false);
    expect(readyToShip({ enabled: true, endpointUrl: GOOD, deviceId: 'short' }, true)).toBe(false);
    expect(readyToShip({ enabled: true, endpointUrl: GOOD, deviceId: ID }, false)).toBe(false);
    expect(readyToShip({ enabled: true, endpointUrl: GOOD, deviceId: ID }, true)).toBe(true);
  });

  it('accepts a loopback http endpoint for a relay on this computer', () => {
    expect(readyToShip({ enabled: true, endpointUrl: 'http://127.0.0.1:8080', deviceId: ID }, true)).toBe(true);
  });

  it('validates the device id like the ingest contract', () => {
    expect(RelayDeviceId.safeParse('a'.repeat(8)).success).toBe(true);
    expect(RelayDeviceId.safeParse('a'.repeat(64)).success).toBe(true);
    expect(RelayDeviceId.safeParse('a'.repeat(7)).success).toBe(false);
    expect(RelayDeviceId.safeParse('a'.repeat(65)).success).toBe(false);
  });
});
