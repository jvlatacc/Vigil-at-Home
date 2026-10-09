import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayStore } from './store.js';
import { Retainer } from './retention.js';
import {
  alertRecord,
  batchRequest,
  closeRelay,
  eventRecord,
  gzipped,
  parsedRecords,
  post,
  startTestRelay,
  testConfig,
} from './test-support.js';
import { INGEST_PATH } from './ingest.js';
import { startRelay } from './index.js';

const dirs: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStore(opts: ConstructorParameters<typeof RelayStore>[1] = {}): RelayStore {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-relay-retain-'));
  dirs.push(dir);
  return new RelayStore(dir, opts);
}

function outcome(store: RelayStore, records: unknown[], deviceId = 'laptop-1') {
  return store.applyBatch(deviceId, parsedRecords(batchRequest(records, deviceId)), Date.now());
}

function ruleRecord(id: string, ts: number): unknown {
  return { r: 'rule', id, ts, version: 3, body: { mode: 'alert' } };
}

/** A gzip body from the batch object itself (batchRequest returns a string). */
function gzippedBatch(records: unknown[], deviceId = 'laptop-1'): Buffer {
  return gzipped({ v: 1, deviceId, cursor: { ts: 0, id: '0' }, records });
}

describe('store eviction', () => {
  it('drops old telemetry at the time cap and keeps the rest', () => {
    const store = newStore();
    const now = Date.now();
    const old = now - 40 * DAY_MS;
    outcome(store, [eventRecord('e-old', old), eventRecord('e-new', now - 1000)]);
    outcome(store, [alertRecord('a-old', old), alertRecord('a-new', now - 1000)]);
    outcome(store, [
      { r: 'action', id: 'x-old', ts: old, body: { kind: 'kill' } },
      { r: 'action', id: 'x-new', ts: now - 1000, body: { kind: 'kill' } },
    ]);
    outcome(store, [ruleRecord('r1', old)]);

    const deleted = store.evictOlderThan(now - 30 * DAY_MS, 5_000);

    expect(deleted).toBe(3);
    const stats = store.stats();
    expect(stats).toMatchObject({ events: 1, alerts: 1, actions: 1, rules: 1 });
  });

  it('evicts oldest first under a disk cap; the newest stay deduped', () => {
    const store = newStore();
    const now = Date.now();
    // Enough rows that the data (~230 KB) dwarfs the empty-database floor
    // (~72 KB of schema pages), so a 60% cap evicts the old half only.
    for (let batch = 0; batch < 2; batch++) {
      const records: unknown[] = [];
      for (let i = 1; i <= 400; i++) {
        const n = batch * 400 + i;
        records.push(eventRecord(`e${String(n).padStart(4, '0')}`, now - (800 - n) * 1000));
      }
      outcome(store, records);
    }
    const before = store.stats().usageBytes;
    expect(before).toBeGreaterThan(0);

    const target = Math.floor(before * 0.6);
    const deleted = store.evictToBytes(target, 50, 1_000);

    expect(deleted).toBeGreaterThan(0);
    expect(store.stats().usageBytes).toBeLessThanOrEqual(target);
    // Replays prove who survived: the oldest record was evicted (so it is
    // accepted again), the newest is still stored (so it dedupes).
    const oldest = outcome(store, [eventRecord('e0001', now - 800 * 1000)]);
    expect(oldest).toMatchObject({ accepted: 1, duplicates: 0 });
    const newest = outcome(store, [eventRecord('e0800', now)]);
    expect(newest).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('respects the pass bound on the disk loop', () => {
    const store = newStore();
    const now = Date.now();
    outcome(store, [eventRecord('e1', now - 1000), eventRecord('e2', now - 500)]);
    const before = store.stats().usageBytes;
    expect(store.evictToBytes(0, 50, 0)).toBe(0);
    expect(store.stats().usageBytes).toBe(before);
  });
});

describe('Retainer', () => {
  it('reports zero for an empty store without erroring', () => {
    const store = newStore();
    const retainer = new Retainer(store, { retentionDays: 30, maxDiskBytes: 1024 ** 3 });
    expect(retainer.run()).toEqual({ byTime: 0, byDisk: 0 });
  });

  it('enforces both caps and counts what each deleted', () => {
    const store = newStore();
    const now = Date.now();
    outcome(store, [eventRecord('e-old', now - 40 * DAY_MS)]);
    // Enough rows that the data dwarfs the empty-database floor (~72 KB of
    // schema pages), so a cap at half the usage is actually reachable.
    for (let batch = 0; batch < 2; batch++) {
      const records: unknown[] = [];
      for (let i = 1; i <= 400; i++) {
        const n = batch * 400 + i;
        records.push(eventRecord(`e${String(n).padStart(4, '0')}`, now - n * 1000));
      }
      outcome(store, records);
    }
    const fatUsage = store.stats().usageBytes;
    const retainer = new Retainer(store, {
      retentionDays: 30,
      maxDiskBytes: Math.floor(fatUsage * 0.5),
    });

    const run = retainer.run();

    expect(run.byTime).toBe(1);
    expect(run.byDisk).toBeGreaterThan(0);
    expect(store.stats().usageBytes).toBeLessThanOrEqual(Math.floor(fatUsage * 0.5) * 0.95 + 1);
  });

  it('runs on start and then hourly until stopped', () => {
    vi.useFakeTimers();
    try {
      const store = newStore();
      const retainer = new Retainer(store, { retentionDays: 30, maxDiskBytes: 1024 ** 3 });
      const run = vi.spyOn(retainer, 'run');
      retainer.start();
      expect(run).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3 * 3_600_000);
      expect(run).toHaveBeenCalledTimes(4);
      retainer.stop();
      vi.advanceTimersByTime(3_600_000);
      expect(run).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires the store hook once per insert threshold crossing', () => {
    let fired = 0;
    const store = newStore({ insertCheckEvery: 10, onRetentionDue: () => (fired += 1) });
    const now = Date.now();
    for (let batch = 0; batch < 4; batch++) {
      outcome(
        store,
        [1, 2, 3, 4, 5].map((n) => eventRecord(`b${batch}-e${n}`, now - batch * 1000 - n)),
      );
    }
    // 20 inserts against a threshold of 10: fires at 10 and at 20.
    expect(fired).toBe(2);
  });
});

describe('retention over the live relay', () => {
  it('evicts telemetry that aged past the cap after ingest', async () => {
    const relay = await startTestRelay({ retentionDays: 1 });
    try {
      const { token } = relay.store.provisionDevice('laptop-1', Date.now());
      const now = Date.now();
      const reply = await post(
        relay.port,
        INGEST_PATH,
        gzippedBatch([eventRecord('e-old', now - 3 * DAY_MS), eventRecord('e-new', now - 1000)]),
        { authorization: `Bearer ${token}`, 'content-encoding': 'gzip' },
      );
      expect(reply.status).toBe(200);
      expect(relay.store.stats().events).toBe(2);

      const run = relay.retainer.run();

      expect(run.byTime).toBe(1);
      expect(relay.store.stats().events).toBe(1);
    } finally {
      await closeRelay(relay);
    }
  });

  it('leaves an injected store open when the relay closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vigil-relay-injected-'));
    dirs.push(dir);
    const store = new RelayStore(dir);
    const config = testConfig();
    const relay = await startRelay(config, store);
    await relay.close();
    // A closed database throws on prepare; this only answers if it is open.
    expect(store.journalMode()).toBe('wal');
    store.close();
    rmSync(config.dataDir, { recursive: true, force: true });
  });
});
