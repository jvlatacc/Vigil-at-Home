import { TransportError } from './transport.js';

/** Exponential backoff: delay = min(initialMs * multiplier^attempt, maxMs). */
export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  multiplier: number;
}

export interface BatchQueueOptions<T> {
  /** Flush when this many items are pending. */
  maxItems: number;
  /** …or this long after the first pending item, whichever comes first. */
  flushAfterMs: number;
  /** The queue is bounded: past this, the oldest pending item is dropped. */
  maxQueueItems: number;
  /** Sends one batch. Rejects when the batch did not land. */
  flush: (items: T[]) => Promise<void>;
  /** True for failures worth retrying with backoff (5xx, network). Others drop the batch. */
  retryable: (error: unknown) => boolean;
  /** Told about a batch that will not be retried, and why. */
  onDropped: (items: T[], error: unknown) => void;
  /** Injectable timer work, for tests. */
  schedule?: (fn: () => void, ms: number) => () => void;
  backoff?: BackoffOptions;
}

const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 60_000, multiplier: 2 };

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

export function retryableTransportError(error: unknown): boolean {
  return error instanceof TransportError && error.retryable;
}

/**
 * A bounded batcher: flush on size or after a window, exponential backoff on
 * retryable failures. While a batch is failing or in flight, new items
 * accumulate up to maxQueueItems; past that the oldest pending item is
 * dropped, so a dead endpoint can never grow memory. A non-retryable failure
 * drops that batch through onDropped and lets later items try their own
 * window — a batch is never retried into a wall it demonstrably cannot pass.
 */
export class BatchQueue<T> {
  private readonly options: BatchQueueOptions<T>;
  private readonly backoff: BackoffOptions;
  private readonly scheduleFn: (fn: () => void, ms: number) => () => void;

  private items: T[] = [];
  private flushTimer: (() => void) | null = null;
  private retryTimer: (() => void) | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private attempts = 0;

  constructor(options: BatchQueueOptions<T>) {
    this.options = options;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.scheduleFn = options.schedule ?? defaultSchedule;
  }

  /** Pending items, including any batch waiting out its backoff. */
  get size(): number {
    return this.items.length;
  }

  /** Flush failures since the last success. */
  get failedAttempts(): number {
    return this.attempts;
  }

  /** Add one item: flush immediately at maxItems, else start the window. */
  add(item: T): void {
    if (this.items.length >= this.options.maxQueueItems) this.items.shift();
    this.items.push(item);
    this.armFlush();
  }

  /**
   * Flush pending items now, cancelling any window or backoff timer.
   * Coalesces with a flush already running.
   */
  flushNow(): Promise<void> {
    this.cancelFlushTimer();
    this.cancelRetryTimer();
    if (this.inFlightPromise) return this.inFlightPromise;
    return this.runFlush();
  }

  /**
   * Cancel timers and flush whatever is left. One final attempt: anything
   * that still will not land is reported through onDropped and the error is
   * rethrown — stopping must not quietly lose a batch.
   */
  async stop(): Promise<void> {
    this.cancelFlushTimer();
    this.cancelRetryTimer();
    if (this.inFlightPromise) {
      await this.inFlightPromise;
      // The failed flush re-armed its retry while we waited.
      this.cancelRetryTimer();
    }
    if (!this.items.length) return;
    const batch = this.items;
    this.items = [];
    try {
      await this.options.flush(batch);
    } catch (error) {
      this.options.onDropped(batch, error);
      throw error;
    }
  }

  private runFlush(): Promise<void> {
    this.inFlightPromise ??= this.doRunFlush().finally(() => {
      this.inFlightPromise = null;
    });
    return this.inFlightPromise;
  }

  private async doRunFlush(): Promise<void> {
    if (!this.items.length) return;
    const batch = this.items;
    this.items = [];
    try {
      await this.options.flush(batch);
      this.attempts = 0;
      this.armFlush();
    } catch (error) {
      if (this.options.retryable(error)) {
        // Keep the batch, ahead of anything that arrived meanwhile.
        this.items = [...batch, ...this.items];
        this.scheduleRetry();
      } else {
        // The batch will not land: report it and let later items try.
        this.options.onDropped(batch, error);
      }
    }
  }

  private armFlush(): void {
    if (!this.items.length || this.inFlightPromise || this.retryTimer) return;
    if (this.items.length >= this.options.maxItems) {
      this.cancelFlushTimer();
      void this.flushNow();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = this.scheduleFn(() => {
        this.flushTimer = null;
        void this.flushNow();
      }, this.options.flushAfterMs);
    }
  }

  private scheduleRetry(): void {
    const delay = Math.min(
      this.backoff.initialMs * this.backoff.multiplier ** this.attempts,
      this.backoff.maxMs,
    );
    this.attempts += 1;
    this.retryTimer = this.scheduleFn(() => {
      this.retryTimer = null;
      void this.flushNow();
    }, delay);
  }

  private cancelFlushTimer(): void {
    this.flushTimer?.();
    this.flushTimer = null;
  }

  private cancelRetryTimer(): void {
    this.retryTimer?.();
    this.retryTimer = null;
  }
}
