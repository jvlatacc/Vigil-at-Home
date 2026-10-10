import type { RelayStore } from './store.js';

/** The retention knobs the relay enforces. */
export interface RetentionLimits {
  /** Streams older than this many days are dropped. */
  retentionDays: number;
  /** The disk ceiling; once past it, oldest records go first. */
  maxDiskBytes: number;
}

/** What one retention pass deleted. */
export interface RetainRun {
  byTime: number;
  byDisk: number;
}

/** Rows deleted per eviction statement — the store's batch discipline. */
const EVICT_BATCH = 5_000;
/** Stop the disk loop well under the cap so the next batch fits. */
const DISK_HEADROOM = 0.95;
/** A bound on the disk-eviction loop: rows are small; this can't loop forever. */
const MAX_DISK_PASSES = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps the relay inside its retention promises: a time cap and a disk cap,
 * oldest first, like the laptop's own service. Checks hourly, and again
 * whenever the store crosses an insert threshold (the store calls
 * `onRetentionDue`, which startRelay points back here).
 */
export class Retainer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly store: RelayStore,
    private readonly limits: RetentionLimits,
    private readonly everyMs: number = 3_600_000,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.run();
    this.timer = setInterval(() => this.run(), this.everyMs);
    // An idle relay's retention clock must not hold the process open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Runs one pass; a pass that is already running is skipped, not queued. */
  run(): RetainRun {
    if (this.running) return { byTime: 0, byDisk: 0 };
    this.running = true;
    try {
      const cutoff = Date.now() - this.limits.retentionDays * DAY_MS;
      const byTime = this.store.evictOlderThan(cutoff, EVICT_BATCH);
      const usage = this.store.stats().usageBytes;
      const target = Math.floor(this.limits.maxDiskBytes * DISK_HEADROOM);
      const byDisk =
        usage > this.limits.maxDiskBytes
          ? this.store.evictToBytes(target, EVICT_BATCH, MAX_DISK_PASSES)
          : 0;
      return { byTime, byDisk };
    } finally {
      this.running = false;
    }
  }
}
