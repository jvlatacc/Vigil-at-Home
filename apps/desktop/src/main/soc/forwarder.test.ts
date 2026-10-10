import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertService } from '../alerts.js';
import { DryRunExecutor } from '../executor.js';
import { makeExec, makeRule, memoryStore } from '../testing.js';
import { TEST_RULE } from '../test-alert.js';
import { SocForwarder } from './forwarder.js';
import { SocSettingsStore } from './settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../db/store.js';

/* ---------------------------------------------------------------- fixtures */

const fakeCipher = {
  available: () => true,
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => {
    const s = b.toString('utf8');
    if (!s.startsWith('enc:')) throw new Error('not ours');
    return s.slice(4);
  },
};

type Call = { url: string; method: string; body: Record<string, unknown> };

const SOC_URL = 'https://soc.example.com';

/** A fetch double that records every call and answers by method, so the
 * push receiver and the frozen PATCH endpoint both get well-formed replies. */
function fetchRig(opts: { failFirstPosts?: number } = {}) {
  const calls: Call[] = [];
  const impl: typeof globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      body = {}; // not JSON — recorded as empty
    }
    calls.push({ url: String(input), method, body });
    const posts = calls.filter((c) => c.method === 'POST').length;
    if (method === 'POST' && opts.failFirstPosts !== undefined && posts <= opts.failFirstPosts) {
      return new Response('soc unavailable', { status: 503 });
    }
    const payload =
      method === 'PATCH'
        ? { success: true, finding: {}, updated_fields: ['status'] }
        : {
            batch_id: 'batch-1',
            received: 1,
            created: 1,
            updated: 0,
            failed: 0,
            results: [],
            case_ids: ['case-1'],
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl, calls };
}

const dirs: string[] = [];
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'soc-forwarder-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeSettings(dir: string): SocSettingsStore {
  return new SocSettingsStore({
    store: memoryStore(),
    keyPath: join(dir, 'soc-keys.json'),
    cipher: fakeCipher,
  });
}

async function enabledSettings(dir: string): Promise<SocSettingsStore> {
  const settings = makeSettings(dir);
  await settings.set({ enabled: true, socBaseUrl: SOC_URL, socApiKey: 'k-1234' });
  return settings;
}

/** A real alert service over an in-memory store: the forwarder reacts to
 * exactly the events the app emits, folds and resolutions included. */
function rig(fetchImpl: typeof globalThis.fetch, settings: SocSettingsStore) {
  const store = memoryStore();
  const alerts = new AlertService(store, new DryRunExecutor());
  const forwarder = new SocForwarder({ fetch: fetchImpl, batchId: () => 'batch-1' });
  forwarder.start({ alerts, store }, settings);
  return { alerts, forwarder, store: store as Store };
}

const PUSH_URL = `${SOC_URL}/api/integrations/vstrike/findings`;

/* ------------------------------------------------------------------ tests */

describe('SocForwarder', () => {
  it('sends nothing while export is off, though alerts flow', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = makeSettings(tmpDir());
    const { alerts, forwarder } = rig(fetch, settings);

    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toEqual([]);
    expect(forwarder.pending).toBe(0);
    expect(forwarder.forwarding).toBe(false);
  });

  it('pushes a raised alert as one redacted finding when the batch window closes', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts, forwarder } = rig(fetch, settings);

    const alert = await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    expect(calls).toEqual([]); // nothing until the window closes
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(PUSH_URL);
    expect(calls[0]?.body).toMatchObject({
      source: 'vigil-at-home',
      auto_cluster_cases: true,
    });
    expect(forwarder.pending).toBe(0);
    const findings = calls[0]?.body['findings'] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ finding_id: `vah-${alert.id}`, severity: 'high' });
  });

  it('flushes as soon as the batch fills, without waiting for the window', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    for (let i = 0; i < 50; i++) {
      await alerts.raise({
        rule: makeRule(),
        events: [makeExec(`/tmp/evil-${i}`)],
        actions: [],
      });
    }
    expect(calls).toHaveLength(1); // maxItems reached on the 50th
    const findings = calls[0]?.body['findings'] as unknown[];
    expect(findings).toHaveLength(50);
  });

  it('backs off after a 5xx and delivers on the retry', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig({ failFirstPosts: 1 });
    const settings = await enabledSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await vi.advanceTimersByTimeAsync(5_000); // first flush fails
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000); // the backoff retry
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.method === 'POST' && c.url === PUSH_URL)).toBe(true);
  });

  it('closes the finding when the alert is resolved at home', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    const alert = await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await alerts.decide(alert.id, { verdict: 'benign', release: false });
    await vi.advanceTimersByTimeAsync(5_000);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(`${SOC_URL}/api/v1/findings/vah-${alert.id}`);
    expect(patch?.body).toMatchObject({ status: 'resolved' });
  });

  it('sends nothing for a change that is not a resolution', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    // A repeat folds into the open alert: 'changed' with status open.
    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.every((c) => c.method !== 'PATCH')).toBe(true);
  });

  it('never sends the test alert, which is about Vigil itself', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    await alerts.raise({ rule: TEST_RULE, events: [makeExec()], actions: [] });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toEqual([]);
  });

  it('starts forwarding the moment the switch turns on', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = makeSettings(tmpDir());
    const { alerts } = rig(fetch, settings);

    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);

    await settings.set({ enabled: true, socBaseUrl: SOC_URL, socApiKey: 'k-1234' });
    expect(settings.settings().enabled).toBe(true);

    await alerts.raise({ rule: makeRule(), events: [makeExec('/tmp/other')], actions: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });

  it('stops forwarding the moment the switch turns off, after flushing', async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fetchRig();
    const settings = await enabledSettings(tmpDir());
    const { alerts, forwarder } = rig(fetch, settings);

    await alerts.raise({ rule: makeRule(), events: [makeExec()], actions: [] });
    await settings.set({ enabled: false });
    await forwarder.flushNow(); // the old exporter still delivers its own items

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1); // delivered to the old exporter's endpoint
    await settings.set({ enabled: true, socBaseUrl: SOC_URL, socApiKey: 'k-1234' });
    await alerts.raise({ rule: makeRule(), events: [makeExec('/tmp/next')], actions: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
});
