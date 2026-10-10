import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SensorHub } from '../hub.js';
import { SensorEvent } from '@vigil/core';
import type { EventKind } from '@vigil/core';

// The valid lines are the daemon index writer's own shapes (see parser.test.ts).
const EXEC_1 =
  '{"kind":"process.exec","source":"kernel-monitor","at":"2024-10-09T14:04:11.500Z","monoNs":1000,"tgid":4242,"ppid":400,"uid":1000,"euid":1000,"comm":"sh","exe":"/tmp/x"}';
const EXEC_2 =
  '{"kind":"process.exec","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":9000000000,"tgid":20531,"ppid":20510,"uid":1000,"euid":1000,"comm":"sh","exe":"/tmp/x"}';
const HEALTH =
  '{"kind":"monitor.health","source":"kernel-monitor","at":"2026-10-09T18:04:12.000Z","monoNs":9001000000,"tgid":1421,"uid":0,"comm":"vigil-kernel-mo","droppedTotal":0,"hooks":["tracepoint/sched/sched_process_exec"],"degraded":false}';
const UNKNOWN_KIND =
  '{"kind":"file","source":"kernel-monitor","at":"2026-10-09T18:04:11.203Z","monoNs":1,"tgid":1,"uid":0,"comm":"x"}';

/** The app's events table: INSERT with the id primary key; body keeps the record. */
class MockEventsStore {
  readonly rows = new Map<
    string,
    { id: string; ts: number; kind: EventKind; source: string; body: string }
  >();

  insert(e: SensorEvent): void {
    if (this.rows.has(e.id)) return; // PRIMARY KEY (id)
    this.rows.set(e.id, {
      id: e.id,
      ts: e.ts,
      kind: e.kind,
      source: e.source,
      body: JSON.stringify(e),
    });
  }

  get size(): number {
    return this.rows.size;
  }

  all(): { id: string; ts: number; kind: EventKind; source: string; body: string }[] {
    return [...this.rows.values()];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('kernel-monitor ingestion through the hub', () => {
  let dir: string;
  let hub: SensorHub | undefined;
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('ingests a multi-line index in order, drops the bad lines, and survives them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vigil-km-'));
    const index = join(dir, 'operations.jsonl');
    writeFileSync(index, [EXEC_1, 'corrupt', UNKNOWN_KIND, HEALTH, EXEC_2].join('\n') + '\n');
    const store = new MockEventsStore();
    hub = new SensorHub({
      sink: (e) => store.insert(e),
      santaLogPath: false,
      osqueryResultsPath: false,
      kernelMonitorPath: index,
      positions: { 'kernel-monitor': { ino: statSync(index).ino, offset: 0 } },
    });
    await hub.start();
    for (let i = 0; i < 50 && store.size < 3; i++) await sleep(100);

    // The three valid lines are stored, in file order — the line after the
    // corrupt ones arriving is what proves the hub survived them.
    expect(store.all().map((r) => r.kind)).toEqual([
      'process.exec',
      'monitor.health',
      'process.exec',
    ]);
    expect(store.all().map((r) => r.id)).toEqual([...new Set(store.all().map((r) => r.id))]);
    // The drop counter saw exactly the two bad lines, with the last reason.
    expect(hub.kernelMonitorDrops()).toEqual({ dropped: 2, lastReason: 'unknown kind: file' });

    // Every row carries the events-table contract, and its body round-trips.
    for (const row of store.all()) {
      expect(row.id.startsWith('kernel-monitor:')).toBe(true);
      expect(row.source).toBe('kernel-monitor');
      // The line's wall clock rides in raw.at (top-level at exists only on the
      // kernel-base kinds; process.exec is the shared app shape).
      expect(row.ts).toBe(Date.parse(JSON.parse(row.body).raw.at));
      expect(SensorEvent.parse(JSON.parse(row.body)).kind).toBe(row.kind);
    }
  });

  it('ingests lines appended after start', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vigil-km-'));
    const index = join(dir, 'operations.jsonl');
    // No saved positions: the tail starts at end-of-file, so the index must be
    // empty first — as it is when the daemon has just begun writing.
    writeFileSync(index, '');
    const store = new MockEventsStore();
    hub = new SensorHub({
      sink: (e) => store.insert(e),
      santaLogPath: false,
      osqueryResultsPath: false,
      kernelMonitorPath: index,
    });
    await hub.start();
    appendFileSync(index, EXEC_1 + '\n');
    for (let i = 0; i < 50 && store.size < 1; i++) await sleep(100);
    expect(store.size).toBe(1);
    appendFileSync(index, HEALTH + '\n');
    for (let i = 0; i < 50 && store.size < 2; i++) await sleep(100);
    expect(store.all().map((r) => r.kind)).toEqual(['process.exec', 'monitor.health']);
    expect(hub.kernelMonitorDrops().dropped).toBe(0);
  });
});
