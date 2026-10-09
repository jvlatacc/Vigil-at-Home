import { describe, expect, it } from 'vitest';
import { BatchQueue, retryableTransportError } from '../batch-queue.js';
import { TransportError } from '../transport.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Deterministic timer stand-in: nothing fires until `fire` says so. */
function manualScheduler() {
  const pending: Array<{ fn: () => void; delay: number }> = [];
  const scheduled: number[] = [];
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, delay: ms };
    pending.push(entry);
    scheduled.push(ms);
    return () => {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  const fire = () => {
    pending.shift()?.fn();
  };
  return { schedule, fire, scheduled, pendingCount: () => pending.length };
}

function recorder() {
  const batches: number[][] = [];
  const dropped: Array<{ items: number[]; error: unknown }> = [];
  return {
    batches,
    dropped,
    flush: async (items: number[]) => {
      batches.push(items);
    },
    failWith:
      (error: unknown) =>
      async (items: number[]): Promise<never> => {
        batches.push(items);
        throw error;
      },
  };
}

function makeQueue(options: {
  flush: (items: number[]) => Promise<void>;
  schedule: (fn: () => void, ms: number) => () => void;
  onDropped: (items: number[], error: unknown) => void;
  maxItems?: number;
  maxQueueItems?: number;
}) {
  return new BatchQueue<number>({
    maxItems: options.maxItems ?? 10,
    flushAfterMs: 5_000,
    maxQueueItems: options.maxQueueItems ?? 100,
    flush: options.flush,
    retryable: retryableTransportError,
    onDropped: options.onDropped,
    schedule: options.schedule,
  });
}

describe('BatchQueue', () => {
  it('flushes when maxItems is reached', async () => {
    const timer = manualScheduler();
    const rec = recorder();
    const queue = makeQueue({
      flush: rec.flush,
      schedule: timer.schedule,
      onDropped: () => {},
      maxItems: 3,
    });
    queue.add(1);
    queue.add(2);
    queue.add(3);
    await tick();
    expect(rec.batches).toEqual([[1, 2, 3]]);
    expect(queue.size).toBe(0);
    expect(timer.pendingCount()).toBe(0);
  });

  it('flushes after the window when under maxItems', async () => {
    const timer = manualScheduler();
    const rec = recorder();
    const queue = makeQueue({ flush: rec.flush, schedule: timer.schedule, onDropped: () => {} });
    queue.add(1);
    expect(timer.scheduled).toEqual([5_000]);
    timer.fire();
    await tick();
    expect(rec.batches).toEqual([[1]]);
  });

  it('drops the oldest pending item past the bound', async () => {
    const timer = manualScheduler();
    const rec = recorder();
    const queue = makeQueue({
      flush: rec.flush,
      schedule: timer.schedule,
      onDropped: () => {},
      maxQueueItems: 3,
    });
    for (const item of [1, 2, 3, 4]) queue.add(item);
    expect(queue.size).toBe(3);
    timer.fire();
    await tick();
    expect(rec.batches).toEqual([[2, 3, 4]]);
  });

  it('retries a retryable failure with exponential backoff', async () => {
    const timer = manualScheduler();
    const failure = new TransportError('downstream', { status: 503, retryable: true });
    let fail = true;
    const batches: number[][] = [];
    const queue = new BatchQueue<number>({
      maxItems: 10,
      flushAfterMs: 5_000,
      maxQueueItems: 100,
      backoff: { initialMs: 1_000, maxMs: 60_000, multiplier: 2 },
      flush: async (items) => {
        batches.push(items);
        if (fail) throw failure;
      },
      retryable: retryableTransportError,
      onDropped: () => {},
      schedule: timer.schedule,
    });
    queue.add(7);
    timer.fire(); // window timer: first attempt
    await tick();
    expect(batches).toEqual([[7]]);
    timer.fire(); // retry 1, after 1s
    await tick();
    expect(timer.scheduled).toEqual([5_000, 1_000, 2_000]);
    fail = false;
    timer.fire(); // retry 2, after 2s
    await tick();
    expect(batches).toEqual([[7], [7], [7]]);
    expect(timer.pendingCount()).toBe(0);
    expect(queue.failedAttempts).toBe(0);
  });

  it('does not retry a non-retryable failure', async () => {
    const timer = manualScheduler();
    const rec = recorder();
    const queue = makeQueue({
      flush: rec.failWith(new TransportError('bad payload', { status: 422, retryable: false })),
      schedule: timer.schedule,
      onDropped: (items, error) => rec.dropped.push({ items, error }),
    });
    queue.add(1);
    timer.fire();
    await tick();
    expect(rec.dropped).toHaveLength(1);
    expect(rec.dropped[0]?.items).toEqual([1]);
    expect(queue.size).toBe(0);
    expect(timer.pendingCount()).toBe(0);
  });

  it('keeps the queue bounded while backing off', async () => {
    const timer = manualScheduler();
    const failure = new TransportError('downstream', { status: 500, retryable: true });
    const queue = makeQueue({
      flush: async () => {
        throw failure;
      },
      schedule: timer.schedule,
      onDropped: () => {},
      maxQueueItems: 3,
    });
    queue.add(1);
    timer.fire();
    await tick(); // failed; retry armed
    for (const item of [2, 3, 4, 5]) queue.add(item);
    expect(queue.size).toBe(3);
    expect(queue.failedAttempts).toBe(1);
  });

  it('coalesces flushNow with a flush already in flight', async () => {
    let releaseFlush: (() => void) | undefined;
    let calls = 0;
    const timer = manualScheduler();
    const queue = new BatchQueue<number>({
      maxItems: 10,
      flushAfterMs: 5_000,
      maxQueueItems: 100,
      flush: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          releaseFlush = resolve;
        });
      },
      retryable: retryableTransportError,
      onDropped: () => {},
      schedule: timer.schedule,
    });
    queue.add(1);
    timer.fire(); // window fires: flush #1 starts and blocks
    await tick();
    expect(calls).toBe(1);
    const coalesced = queue.flushNow();
    expect(calls).toBe(1); // coalesced, not a second flush
    releaseFlush?.();
    await coalesced;
    expect(calls).toBe(1);
  });

  it('flushes what is left on stop', async () => {
    const rec = recorder();
    const queue = makeQueue({
      flush: rec.flush,
      schedule: manualScheduler().schedule,
      onDropped: () => {},
    });
    queue.add(9);
    await queue.stop();
    expect(rec.batches).toEqual([[9]]);
  });

  it('surfaces and drops a batch that will not land, even on stop', async () => {
    const rec = recorder();
    const failure = new TransportError('still down', { status: 500, retryable: true });
    const queue = makeQueue({
      flush: rec.failWith(failure),
      schedule: manualScheduler().schedule,
      onDropped: (items, error) => rec.dropped.push({ items, error }),
    });
    queue.add(1);
    await expect(queue.stop()).rejects.toBe(failure);
    expect(rec.dropped[0]?.items).toEqual([1]);
    expect(queue.size).toBe(0);
  });
});
