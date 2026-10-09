import { SocExporter } from '@vigil/soc-export';
import type { Alert } from '@vigil/core';
import type { AlertService } from '../alerts.js';
import type { Store } from '../db/store.js';
import { SLOW_RULE } from '../slow-rule.js';
import { TEST_RULE } from '../test-alert.js';
import { WORTH_A_LOOK_RULE } from '../worth-a-look.js';
import type { SocSettingsStore } from './settings.js';

export type SocForwarderDeps = {
  /** Injectable for tests; the platform fetch otherwise. */
  fetch?: typeof fetch;
  /** Injectable batch id, for tests. */
  batchId?: () => string;
};

/** The slice of VigilCore the forwarder needs — no helper, no renderer. */
export interface SocForwarderCore {
  alerts: Pick<AlertService, 'on' | 'off'>;
  store: Pick<Store, 'getRule'>;
}

/**
 * Alerts that are about Vigil itself, not the machine, and never leave it —
 * the same filter the AI explainer applies before explaining.
 */
const LOCAL_ONLY_RULES: ReadonlySet<string> = new Set([
  TEST_RULE.id,
  WORTH_A_LOOK_RULE.id,
  SLOW_RULE.id,
]);

/**
 * Path 1 of the demo: findings the moment they fire. Subscribes to the alert
 * service exactly like the AI explainer does — a main-process module with no
 * helper privileges — and hands every alert to the soc-export core, which
 * maps, redacts, batches and pushes it, and PATCHes resolutions through the
 * frozen /api/v1 update.
 *
 * The local-first rule: until the user opts in, the settings store reads as
 * disabled, the exporter has no transport, and nothing here can touch the
 * network. Turning the switch on (or off) in Settings rebuilds the exporter
 * in place; whatever the old one still held is flushed to the old endpoint.
 */
export class SocForwarder {
  private core: SocForwarderCore | undefined;
  private settingsStore: SocSettingsStore | undefined;
  private exporter: SocExporter | undefined;
  private readonly deps: SocForwarderDeps;

  constructor(deps: SocForwarderDeps = {}) {
    this.deps = deps;
  }

  start(core: SocForwarderCore, settings: SocSettingsStore): void {
    this.detach();
    this.core = core;
    this.settingsStore = settings;
    core.alerts.on('raised', this.onRaised);
    core.alerts.on('changed', this.onChanged);
    settings.on('changed', this.onSettingsChanged);
    this.rebuild();
  }

  /** Detach and flush what is left. A final delivery failure is logged, not lost silently. */
  async stop(): Promise<void> {
    this.detach();
    const exporter = this.exporter;
    this.exporter = undefined;
    try {
      await exporter?.stop();
    } catch (err) {
      console.error('[soc] flushing on stop failed:', err);
    }
  }

  /** Push and PATCH everything queued now; resolves when nothing is left. */
  async flushNow(): Promise<void> {
    await this.exporter?.flushNow();
  }

  /** Findings and resolutions waiting to send. */
  get pending(): number {
    return this.exporter?.pending ?? 0;
  }

  /** True when the current exporter really forwards — export is opted in. */
  get forwarding(): boolean {
    return this.exporter?.enabled ?? false;
  }

  private onRaised = (alert: Alert): void => {
    if (LOCAL_ONLY_RULES.has(alert.ruleId)) return;
    this.exporter?.exportAlert(alert);
  };

  private onChanged = (alert: Alert): void => {
    if (LOCAL_ONLY_RULES.has(alert.ruleId)) return;
    // resolveAlert ignores every state but 'resolved', so an unfiltered
    // subscription is right: repeats and decisions land here too.
    this.exporter?.resolveAlert(alert);
  };

  private onSettingsChanged = (): void => {
    this.rebuild();
  };

  private detach(): void {
    this.core?.alerts.off('raised', this.onRaised);
    this.core?.alerts.off('changed', this.onChanged);
    this.settingsStore?.off('changed', this.onSettingsChanged);
    this.core = undefined;
    this.settingsStore = undefined;
  }

  /** Build the exporter from the current settings, replacing whatever ran. */
  private rebuild(): void {
    const settings = this.settingsStore;
    const core = this.core;
    if (!settings || !core) return;
    const previous = this.exporter;
    this.exporter = undefined;
    // The old exporter keeps its own endpoint and queue: it flushes to where
    // its items were meant to go, then is done.
    void previous?.stop().catch((err: unknown) => {
      console.error('[soc] flushing the replaced exporter failed:', err);
    });
    try {
      this.exporter = SocExporter.create(settings.settings(), {
        ruleOf: (alert) => core.store.getRule(alert.ruleId),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(this.deps.batchId ? { batchId: this.deps.batchId } : {}),
        onDroppedFindings: (items, error) =>
          console.error(`[soc] dropped ${items.length} finding(s) that would not land:`, error),
        onDroppedResolutions: (items, error) =>
          console.error(`[soc] dropped ${items.length} resolution(s) that would not land:`, error),
      });
    } catch (err) {
      // The settings store refuses to save a switch-on that cannot run, so
      // this is defense in depth: log it and keep export off.
      console.error('[soc] the exporter could not start:', err);
    }
  }
}
