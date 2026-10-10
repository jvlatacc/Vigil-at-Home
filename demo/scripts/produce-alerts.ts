import { rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { ATTACKS, fakeHash } from '../../packages/bench/src/attacks.js';
import { START } from '../../packages/bench/src/detection.js';
import { Store } from '../../apps/desktop/src/main/db/store.js';
import { VigilCore } from '../../apps/desktop/src/main/service.js';
import { Detector } from '../../apps/desktop/src/main/detection.js';
import { DryRunExecutor } from '../../apps/desktop/src/main/executor.js';
import { SocForwarder } from '../../apps/desktop/src/main/soc/forwarder.js';
import { SocSettingsStore } from '../../apps/desktop/src/main/soc/settings.js';
import type { Cipher } from '../../apps/desktop/src/main/onboarding/keys.js';
import { deriveMachineId } from '../../packages/soc-export/src/index.js';
import type { Alert } from '../../packages/core/src/index.js';
import { SOC_API_KEY, SOC_URL, ensureStateDir, log, statePath, writeState } from './lib.js';

/**
 * Path 1 — live push. A headless Vigil core (the app's own pipeline minus the
 * Electron shell) raises alerts from the bench stand-in attacks, while the
 * shipped SocForwarder — the module the desktop app runs — maps, batches and
 * pushes them to the SOC's VStrike receiver with auto-cluster on, and PATCHes
 * one resolution through the frozen /api/v1 update.
 */

// The bench generates every scenario at this instant (a Monday morning, plus
// ten days so the "first seen" learning window is over).
const HOUR = 3_600_000;
const AT = START + 10 * 86_400_000 + HOUR;

/** Same trick as the tests: a Cipher without Electron, for a headless run.
 * The settings store base64-wraps the ciphertext itself (settings.ts), so the
 * cipher is a plain UTF-8 identity — same shape as safeStorage. */
const plainCipher: Cipher = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
};

async function main(): Promise<number> {
  const stateDir = ensureStateDir();
  const dbPath = statePath('vigil.db');
  try {
    statSync(dbPath);
    rmSync(dbPath, { force: true });
  } catch {
    // no database yet — the first run starts clean
  }
  // The wall clock stands in for the app's clock: alerts are stamped "now",
  // so the SOC and the MCP list tools see them as recent.
  const clock = { ms: Date.now() };

  const db = new DatabaseSync(dbPath);
  const store = new Store(db);
  // dryRun: block-mode containment is simulated, as the UI says when the
  // helper is not installed. Nothing here touches a real process.
  const core = new VigilCore(store, new DryRunExecutor(), true, () => clock.ms);
  const detector = new Detector(
    db,
    store,
    core.alerts,
    (event, outcome) => core.ingest(event, outcome),
    {
      installedAt: START - 30 * 86_400_000,
      selfPaths: ['/Applications/Vigil at Home.app'],
      now: () => clock.ms,
      // The stand-ins are macOS telemetry; load the same rule pack the bench scores.
      platform: 'darwin',
    },
  );
  core.detector = detector;

  // Threat lists, seeded like the bench's so list-driven rules can fire.
  const meta = { source: 'bench', updatedAt: AT };
  detector.stores.lists.replace(
    'known_bad_sha256',
    Array.from({ length: 1_400 }, (_, i) => fakeHash(`mb-${i}`)),
    meta,
  );
  detector.stores.lists.replace(
    'known_bad_domains',
    Array.from({ length: 400 }, (_, i) => `bad-${i}.example`),
    meta,
  );
  detector.stores.lists.replace(
    'known_bad_ips',
    Array.from({ length: 50 }, (_, i) => `192.0.2.${i + 1}`),
    meta,
  );
  for (const scenario of ATTACKS) {
    for (const entry of scenario.lists ?? []) {
      detector.stores.lists.add(entry.list, entry.value, meta);
    }
  }

  // Opt in, exactly as Settings does: address, key, switch on.
  const settings = new SocSettingsStore({
    store,
    keyPath: join(stateDir, 'soc-keys.json'),
    cipher: plainCipher,
  });
  const forwarder = new SocForwarder();
  forwarder.start(core, settings);
  const view = settings.set({ enabled: true, socBaseUrl: SOC_URL, socApiKey: SOC_API_KEY });
  if (!view.enabled) {
    log('produce', `SOC export did not enable: ${view.errors.join(' ')}`);
    return 1;
  }

  const raised: Alert[] = [];
  core.alerts.on('raised', (alert: Alert) => raised.push(alert));

  // Fire every canonical attack — the ones the repo's own ratchet promises
  // the rules catch — an hour apart so repeats never fold across scenarios.
  const fired: string[] = [];
  let eventCount = 0;
  for (const [index, scenario] of ATTACKS.entries()) {
    if (scenario.variant !== 'canonical') continue;
    const at = AT + index * HOUR;
    clock.ms = Date.now() + index * 1_000;
    for (const event of scenario.events(at)) {
      await core.handleEvent(event);
      eventCount++;
    }
    fired.push(scenario.id);
  }
  log('produce', `fired ${fired.length} canonical attacks (${eventCount} sensor events)`);
  log('produce', `alerts raised: ${raised.length}`);
  log(
    'produce',
    `forwarding: ${forwarder.forwarding ? 'on' : 'off'}, pending: ${forwarder.pending}`,
  );

  // One alert resolved at home: the changed event PATCHes its finding closed.
  let resolved = 0;
  const first = raised[0];
  if (first) {
    await core.decide(first.id, { verdict: 'benign', release: true, note: 'demo resolution' });
    resolved = 1;
    log('produce', `resolved alert ${first.id} — a PATCH closes its finding in the SOC`);
  }

  await forwarder.flushNow();
  log('produce', `flushed; resolutions: ${resolved} PATCHed`);
  writeState('produce.json', {
    socUrl: SOC_URL,
    machineId: deriveMachineId(),
    attacksFired: fired,
    eventsIngested: eventCount,
    alertsRaised: raised.length,
    alertIds: raised.map((alert) => alert.id),
    resolutions: resolved,
  });

  await forwarder.stop();
  core.stop();
  db.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[produce] failed:', error);
    process.exitCode = 1;
  });
