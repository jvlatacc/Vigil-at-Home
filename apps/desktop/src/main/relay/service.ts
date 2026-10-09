import { EventEmitter } from 'node:events';
import { newId, type SensorEvent } from '@vigil/core';
import { RELAY_GAP_RULE_ID, RELAY_REVOKED_RULE_ID } from '@vigil/detection';
import { localNames, redactValue } from '@vigil/ai/redact';
import { z } from 'zod';
import { RelayConfig, type RelayConfigPatch, type RelayView } from '../../shared/ipc.js';
import type { Store } from '../db/store.js';
import { coreRule, type Detector } from '../detection.js';
import type { AlertService } from '../alerts.js';
import { RelayShipper, type ShipperState, type ShipperStatus } from './engine.js';
import {
  KEY_RELAY,
  loadRelayConfig,
  loadRelayCursor,
  readyToShip,
  saveRelayCursor,
} from './settings.js';
import { createIngestTransport } from './transport.js';
import { DesktopRelaySource } from './store-adapter.js';
import type { RelayTokenStore } from './secrets.js';
import type { Cursor } from './wire.js';

/**
 * The telemetry relay's lifecycle: config and token in, an engine running or
 * not out. Opt-in and safe by default — with shipping off, nothing here runs
 * and nothing leaves the computer. The service owns the durable cursor (saved
 * through the settings store as acks arrive) and raises the relay rules'
 * alerts locally when shipping is revoked or gapped, the way the agent
 * service raises its socket-tamper rule.
 */

export const RELAY_WATCH_MS = 5_000;
/** The same once-an-hour limiter the socket-tamper alert uses. */
const RELAY_ALERT_EVERY_MS = 60 * 60_000;

/** What the service needs of a shipper engine, no more — the stand-in and the real package both fit. */
export interface RelayEngineLike {
  /** Resume from the persisted cursor. Only call before start(). */
  resume(cursor: Cursor | undefined): void;
  start(): void;
  stop(): void;
  status(): ShipperStatus;
}

export type RelayEngineFactory = (wiring: {
  config: { endpointUrl: string; deviceId: string };
  token: () => string | undefined;
}) => RelayEngineLike;

export interface RelayServiceDeps {
  store: Store;
  alerts: AlertService;
  /** Detection is optional at startup; the relay rules alert only when it is up. */
  getDetector: () => Detector | undefined;
  tokens: RelayTokenStore;
  log: (msg: string) => void;
  now?: () => number;
  watchMs?: number;
  /** Tests inject a fake engine here; the default builds the real one. */
  makeEngine?: RelayEngineFactory;
}

export class RelayService extends EventEmitter {
  private readonly store: Store;
  private readonly alerts: AlertService;
  private readonly getDetector: () => Detector | undefined;
  private readonly tokens: RelayTokenStore;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly watchMs: number;
  private readonly makeEngine: RelayEngineFactory;

  private engine: RelayEngineLike | undefined;
  private watcher: ReturnType<typeof setInterval> | undefined;
  private savedAck: Cursor | undefined;
  private lastState: ShipperState | 'off' | undefined;
  private revokedAlertAt = 0;
  private gapAlertAt = 0;

  constructor(deps: RelayServiceDeps) {
    super();
    this.store = deps.store;
    this.alerts = deps.alerts;
    this.getDetector = deps.getDetector;
    this.tokens = deps.tokens;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.watchMs = deps.watchMs ?? RELAY_WATCH_MS;
    this.makeEngine =
      deps.makeEngine ??
      ((wiring) =>
        new RelayShipper({
          store: new DesktopRelaySource(this.store),
          transport: createIngestTransport({
            endpointUrl: wiring.config.endpointUrl,
            token: wiring.token,
            deviceId: wiring.config.deviceId,
          }),
          // The same redaction pass Vigil's own AI gets.
          redact: (b) => redactValue(b, localNames()),
          deviceId: wiring.config.deviceId,
        }));
  }

  /** Wire the setting and the app lifecycle: called once at startup. */
  start(): void {
    this.apply();
    this.watcher = setInterval(() => this.watch(), this.watchMs);
  }

  /** Before quit: no more pushes, no timers. */
  stop(): void {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = undefined;
    this.engine?.stop();
  }

  config(): { enabled: boolean; endpointUrl: string; deviceId: string } {
    return loadRelayConfig(this.store);
  }

  /** Applies a patch; refuses to enable shipping until everything is in place. */
  setConfig(patch: RelayConfigPatch): RelayView {
    const current = this.config();
    const next = RelayConfig.parse({ ...current, ...patch });
    // Pastes often carry surrounding spaces or a trailing slash.
    next.endpointUrl = next.endpointUrl.trim().replace(/\/+$/, '');
    if (next.enabled && !readyToShip(next, this.tokens.saved())) {
      throw new Error(
        'To turn shipping on, save the relay address, the device id and the device token first.',
      );
    }
    this.store.setSetting(KEY_RELAY, next);
    this.apply();
    return this.view();
  }

  setToken(raw: string): RelayView {
    this.tokens.set(z.string().min(8).max(200).parse(raw).trim());
    this.apply();
    return this.view();
  }

  clearToken(): RelayView {
    this.tokens.clear();
    this.apply();
    return this.view();
  }

  view(): RelayView {
    const config = this.config();
    const token = this.tokens.saved();
    const status = this.engine?.status();
    const last4 = this.tokens.last4();
    return {
      config,
      token: {
        saved: token,
        ...(last4 !== undefined ? { last4 } : {}),
      },
      canSave: this.tokens.canSave(),
      ready: readyToShip(config, token),
      status: status
        ? {
            state: status.state,
            lagRecords: status.lagRecords,
            ...(status.lastAck ? { lastAck: status.lastAck } : {}),
          }
        : { state: 'off', lagRecords: 0 },
    };
  }

  /**
   * Match the engine to the setting: build and start one when everything the
   * shipper needs is in place (and a stale revoked engine is replaced), stop
   * and drop it otherwise. The cursor resumes from the settings store.
   */
  private apply(): void {
    const config = this.config();
    const shouldRun = readyToShip(config, this.tokens.saved());
    const stale = this.engine?.status().state === 'revoked';
    if (shouldRun && (!this.engine || stale)) {
      this.engine?.stop();
      const engine = this.makeEngine({
        config: { endpointUrl: config.endpointUrl, deviceId: config.deviceId },
        token: () => this.tokens.get() ?? undefined,
      });
      engine.resume(loadRelayCursor(this.store));
      engine.start();
      this.engine = engine;
      this.savedAck = undefined;
      this.log(`telemetry shipping to ${config.endpointUrl} as ${config.deviceId}`);
    } else if (!shouldRun && this.engine) {
      this.engine.stop();
      this.engine = undefined;
      this.log('telemetry shipping stopped');
    }
    this.watch();
  }

  /**
   * One poll step: persists acks, surfaces state changes, raises the relay
   * alerts. The interval body — public so tests can step the loop.
   */
  watch(): void {
    const status = this.engine?.status();
    const state: ShipperState | 'off' = status?.state ?? 'off';
    if (state !== this.lastState) {
      this.lastState = state;
      this.emit('changed');
    }
    if (!status) return;
    // The cursor is the only durable state: save each new ack so a crash
    // resumes where the relay left off.
    if (status.lastAck && status.lastAck !== this.savedAck) {
      this.savedAck = status.lastAck;
      saveRelayCursor(this.store, status.lastAck);
    }
    if (state === 'revoked') {
      this.raise('relay_revoked', status);
      this.log('the relay no longer accepts this device token; shipping stopped');
    } else if (state === 'gap') {
      this.raise('relay_gap', status);
    }
  }

  /**
   * Raises one of the relay rules through the same channel as every other
   * alert, in the mode the user set on the Rules page, at most once an hour.
   * The synthesized event gives the alert something to point at and ships
   * like any other event.
   */
  private raise(subtype: 'relay_revoked' | 'relay_gap', status: ShipperStatus): void {
    const at = this.now();
    const last = subtype === 'relay_revoked' ? this.revokedAlertAt : this.gapAlertAt;
    if (at - last < RELAY_ALERT_EVERY_MS) return;
    const detector = this.getDetector();
    const rule = detector?.engine.getRule(
      subtype === 'relay_revoked' ? RELAY_REVOKED_RULE_ID : RELAY_GAP_RULE_ID,
    );
    if (!detector || !rule) return;
    const mode = detector.engine.modeOf(rule);
    if (mode !== 'alert' && mode !== 'block') return;
    if (subtype === 'relay_revoked') this.revokedAlertAt = at;
    else this.gapAlertAt = at;
    const event: SensorEvent = {
      id: newId(at),
      ts: at,
      source: 'vigil',
      kind: 'system.alert',
      subtype,
      details: {
        device: this.config().deviceId,
        ...(subtype === 'relay_gap' && status.gapFromTs !== undefined
          ? { gapFromTs: String(status.gapFromTs) }
          : {}),
      },
    };
    void this.alerts
      .raise({
        rule: { ...coreRule(rule), mode },
        events: [event],
        actions: [],
        summary:
          subtype === 'relay_revoked'
            ? 'The relay no longer accepts this device token. Shipping stopped; save a new device token to resume.'
            : 'Some recorded events were pruned locally before they could ship, so the relay copy has a gap for that span.',
        subject: { kind: 'process', label: 'Vigil telemetry shipping' },
      })
      .catch((err: unknown) => this.log(`relay alert failed: ${(err as Error).message}`));
    this.emit('changed');
  }
}
