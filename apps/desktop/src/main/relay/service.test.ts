import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_REVOKED_RULE_ID } from '@vigil/detection';
import { Store } from '../db/store.js';
import { Detector } from '../detection.js';
import { DryRunExecutor } from '../executor.js';
import { VigilCore } from '../service.js';
import { RelayTokenStore } from './secrets.js';
import { loadRelayCursor, saveRelayCursor } from './settings.js';
import { RelayService, type RelayEngineFactory, type RelayEngineLike } from './service.js';
import type { ShipperStatus } from './engine.js';
import type { Cursor } from './wire.js';

const TOKEN = 'dev-token-0123456789abcdef';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) c();
});

/** Let the queued alert work run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

type EngineWiring = Parameters<RelayEngineFactory>[0];

/** A controllable engine the factory hands out; the test drives its status. */
class FakeEngine implements RelayEngineLike {
  started = 0;
  stopped = 0;
  resumedWith: Cursor | undefined;
  wiring: EngineWiring;
  state: ShipperStatus = { state: 'running', lagRecords: 0 };
  constructor(wiring: EngineWiring) {
    this.wiring = wiring;
  }
  resume(cursor: Cursor | undefined): void {
    this.resumedWith = cursor;
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  status(): ShipperStatus {
    return this.state;
  }
}

function setup() {
  const clock = { t: Date.UTC(2026, 9, 1, 15) };
  const now = () => clock.t;
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const core = new VigilCore(store, new DryRunExecutor(), true, now);
  core.detector = new Detector(db, store, core.alerts, (e, oc) => core.ingest(e, oc), {
    installedAt: 1,
    selfPaths: [],
    now,
  });
  const folder = mkdtempSync(join(tmpdir(), 'relay-svc-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  // The fake cipher the house tests use: visible, invertible, and nothing like safeStorage.
  const tokens = new RelayTokenStore(join(folder, 'relay-token.json'), {
    available: () => true,
    encrypt: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decrypt: (data) => Buffer.from(data).toString('utf8').slice(4),
  });
  const engines: FakeEngine[] = [];
  const makeEngine: RelayEngineFactory = (wiring) => {
    const e = new FakeEngine(wiring);
    engines.push(e);
    return e;
  };
  const lines: string[] = [];
  const relay = new RelayService({
    store,
    alerts: core.alerts,
    getDetector: () => core.detector,
    tokens,
    log: (msg) => lines.push(msg),
    now,
    makeEngine,
  });
  cleanups.push(
    () => relay.stop(),
    () => core.stop(),
  );
  return { clock, store, core, tokens, engines, relay, lines };
}

const READY = { enabled: true, endpointUrl: 'https://relay.example.com', deviceId: 'device-1234' };

describe('relay service lifecycle', () => {
  it('runs nothing by default: shipping is off and no engine exists', () => {
    const { relay, engines } = setup();
    relay.start();
    expect(engines).toHaveLength(0);
    expect(relay.view()).toMatchObject({ config: { enabled: false }, ready: false });
    expect(relay.view().status.state).toBe('off');
  });

  it('the setting starts and stops the engine, with config and token wired', () => {
    const { relay, engines, tokens } = setup();
    relay.setToken(TOKEN);
    relay.setConfig(READY);
    expect(engines).toHaveLength(1);
    expect(engines[0]?.started).toBe(1);
    expect(engines[0]?.wiring.config).toEqual({
      endpointUrl: 'https://relay.example.com',
      deviceId: 'device-1234',
    });
    // The engine reads the token live through the getter, never a copy.
    expect(engines[0]?.wiring.token()).toBe(TOKEN);
    expect(tokens.canSave()).toBe(true);
    const view = relay.view();
    expect(view.config.enabled).toBe(true);
    expect(view.ready).toBe(true);
    expect(view.status.state).toBe('running');

    relay.setConfig({ enabled: false });
    expect(engines[0]?.stopped).toBe(1);
    expect(relay.view().status.state).toBe('off');
  });

  it('refuses to enable until the address, device id and token are all in place', () => {
    const { relay, engines } = setup();
    expect(() => relay.setConfig(READY)).toThrow(/token/i);
    relay.setToken(TOKEN);
    // Non-http(s) schemes are never safe relay addresses.
    expect(() => relay.setConfig({ ...READY, endpointUrl: 'ftp://relay.example.com' })).toThrow();
    relay.setConfig({ ...READY, endpointUrl: 'https://relay.example.com' });
    expect(engines).toHaveLength(1);
  });

  it('resumes the persisted cursor, and saves each new ack', () => {
    const { store, relay, engines } = setup();
    saveRelayCursor(store, { ts: 100, id: 'e1' });
    relay.setToken(TOKEN);
    relay.setConfig(READY);
    expect(engines[0]?.resumedWith).toEqual({ ts: 100, id: 'e1' });

    const eng = engines[0];
    if (!eng) throw new Error('engine missing');
    eng.state = { state: 'running', lagRecords: 0, lastAck: { ts: 200, id: 'e2' } };
    relay.watch();
    expect(loadRelayCursor(store)).toEqual({ ts: 200, id: 'e2' });
  });

  it('a revoked engine raises the local alert once, and a fresh token rebuilds it', async () => {
    const { store, relay, engines, lines, clock } = setup();
    relay.setToken(TOKEN);
    relay.setConfig(READY);
    const eng = engines[0];
    if (!eng) throw new Error('engine missing');
    eng.state = { state: 'revoked', lagRecords: 0 };
    relay.watch();
    await settle();
    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.ruleId).toBe(RELAY_REVOKED_RULE_ID);
    // The once-an-hour limiter: stepping again raises nothing new.
    clock.t += 1000;
    relay.watch();
    await settle();
    expect(store.listAlerts()).toHaveLength(1);
    // No secret ever reaches the log or the view.
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(relay.view())).not.toContain(TOKEN);

    // A fresh token rebuilds the engine; the stale one is stopped first.
    relay.setToken('dev-token-fedcba9876543210');
    expect(eng.stopped).toBe(1);
    expect(engines).toHaveLength(2);
    expect(engines[1]?.started).toBe(1);
  });

  it('a gap raises the gap alert, and turning the relay rule off silences it', async () => {
    const { core, store, relay, engines } = setup();
    relay.setToken(TOKEN);
    relay.setConfig(READY);
    const eng = engines[0];
    if (!eng) throw new Error('engine missing');
    eng.state = { state: 'gap', lagRecords: 0, gapFromTs: 5 };
    core.detector?.engine._setMode('relay-gap', 'disabled');
    relay.watch();
    await settle();
    expect(store.listAlerts()).toHaveLength(0);
    core.detector?.engine._setMode('relay-gap', 'alert');
    relay.watch();
    await settle();
    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.ruleId).toBe('relay-gap');
  });
});
