import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore } from './store.js';
import { batchRequest, eventRecord, alertRecord, parsedRecords } from './test-support.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStore(subpath = ''): { store: RelayStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vigil-relay-store-')) + subpath;
  dirs.push(dir);
  return { store: new RelayStore(dir), dir };
}

function outcome(store: RelayStore, records: unknown[], deviceId = 'laptop-1') {
  return store.applyBatch(deviceId, parsedRecords(batchRequest(records, deviceId)), Date.now());
}

describe('RelayStore', () => {
  it('runs in WAL mode', () => {
    const { store } = newStore();
    expect(store.journalMode()).toBe('wal');
  });

  it('creates missing data directories private', () => {
    const { store, dir } = newStore('/nested/device-dir');
    store.applyBatch('laptop-1', parsedRecords(batchRequest([eventRecord('e1', 1)])), Date.now());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('stores a batch and counts what landed', () => {
    const { store } = newStore();
    const result = outcome(store, [eventRecord('e1', 1), alertRecord('a1', 2)]);
    expect(result).toMatchObject({ accepted: 2, duplicates: 0, cursor: { ts: 2, id: 'a1' } });
    expect(store.stats()).toMatchObject({ events: 1, alerts: 1, actions: 0, rules: 0 });
  });

  it('absorbs a replayed batch without storing twice', () => {
    const { store } = newStore();
    const records = [eventRecord('e1', 1), eventRecord('e2', 2)];
    outcome(store, records);
    const replay = outcome(store, records);
    expect(replay).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(store.stats().events).toBe(2);
  });

  it('counts duplicates that occur inside one batch', () => {
    const { store } = newStore();
    const result = outcome(store, [eventRecord('e1', 1), eventRecord('e1', 1)]);
    expect(result).toMatchObject({ accepted: 1, duplicates: 1 });
    expect(store.stats().events).toBe(1);
  });

  it('keeps devices isolated on the same record ids', () => {
    const { store } = newStore();
    outcome(store, [eventRecord('e1', 1)], 'laptop-1');
    outcome(store, [eventRecord('e1', 1)], 'laptop-2');
    expect(store.stats().events).toBe(2);
  });

  it('acks the newest record of the batch as the cursor', () => {
    const { store } = newStore();
    const result = outcome(store, [
      eventRecord('e9', 9),
      eventRecord('e5', 12),
      eventRecord('e1', 1),
    ]);
    expect(result.cursor).toEqual({ ts: 12, id: 'e5' });
  });

  it('keeps one rules snapshot per device and absorbs equal-version replays', () => {
    const { store } = newStore();
    const rule = (version: number) => ({
      r: 'rule',
      id: 'rules-1',
      ts: version,
      version,
      body: { rules: [{ id: 'core.exec-script', mode: 'alert' }] },
    });
    outcome(store, [rule(1)]);
    outcome(store, [rule(2)]);
    expect(store.stats().rules).toBe(1);
    const replay = outcome(store, [rule(2)]);
    expect(replay.duplicates).toBe(1);
    expect(store.stats().rules).toBe(1);
  });

  it('keeps dedupe state across a restart', () => {
    const { store, dir } = newStore();
    outcome(store, [eventRecord('e1', 1)]);
    store.close();
    const reopened = new RelayStore(dir);
    const replay = outcome(reopened, [eventRecord('e1', 1)]);
    expect(replay).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(reopened.stats().events).toBe(1);
    reopened.close();
  });

  it('reports nonzero disk usage', () => {
    const { store } = newStore();
    outcome(store, [eventRecord('e1', 1)]);
    expect(store.diskUsageBytes()).toBeGreaterThan(0);
  });
});
