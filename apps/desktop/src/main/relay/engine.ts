import { IngestAck, IngestRequest, type Cursor, type ShipRecord } from './wire.js';

/**
 * STAND-IN shipper engine — replace with the real `@vigil/shipper` on rebase
 * (shipper-engine PR, todo_mXIi6l3P). It implements the same seam the spec and
 * the e2e suite read against: keyset reads from a store, an injected transport,
 * redaction before send, batches at the house discipline (1 s or 500 records),
 * and a cursor that only advances on a relay ack — so a crash replays and the
 * relay's dedupe absorbs it.
 */

export type ShipperState = 'running' | 'backoff' | 'gap' | 'error' | 'revoked';

export interface ShipperStatus {
  state: ShipperState;
  /** Records read past the cursor and not yet acked. */
  lagRecords: number;
  lastAck?: Cursor;
  /** While a pruning gap is open: the cursor position it was detected at. */
  gapFromTs?: number;
}

/** What the shipper reads from the laptop's store, keyed by (ts, id). */
export interface ShipperStore {
  eventsSince(cursor: Cursor | null, limit: number): ShipRecord[];
  alertsSince(cursor: Cursor | null, limit: number): ShipRecord[];
  actionsSince(cursor: Cursor | null, limit: number): ShipRecord[];
  rulesIfChanged(version: number | null): ShipRecord[];
  /**
   * The oldest event still retained, for pruning-gap detection: a cursor
   * behind it points at rows that no longer exist. Optional — nothing
   * checks gaps without it.
   */
  oldestEvent?(): Cursor | null;
}

/** Injected transport: bearer token, gzip, 5 s timeout — spec §2. */
export interface ShipperTransport {
  push(request: IngestRequest): Promise<IngestAck>;
}

export interface ShipperOpts {
  store: ShipperStore;
  transport: ShipperTransport;
  /** The same redaction pass Vigil's own AI gets, applied before send. */
  redact: (b: unknown) => unknown;
  /** Who this device is on the wire; goes into every ingest request. */
  deviceId: string;
  batchEveryMs?: number;
  batchMax?: number;
  /** Retry schedule: 5 s doubling, cap 5 min, jittered. */
  backoff?: { baseMs?: number; capMs?: number };
}

const DEFAULT_BATCH_MS = 1_000;
const DEFAULT_BATCH_MAX = 500;
const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000;
/** Backoff jitter: the retry lands within ±20% of the schedule. */
const JITTER = 0.2;

/**
 * Batches stored telemetry and pushes it to the relay with at-least-once,
 * acked-cursor delivery. Lives under the app: started and stopped with the
 * `telemetry.relay` setting and the app lifecycle, never holding anything it
 * cannot re-derive from `vigil.db` except the cursor, which the app persists.
 */
export class RelayShipper {
  private readonly store: ShipperStore;
  private readonly transport: ShipperTransport;
  private readonly redact: (b: unknown) => unknown;
  private readonly deviceId: string;
  private readonly batchEveryMs: number;
  private readonly batchMax: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private stopped = true;

  private cursor: Cursor;
  private ruleVersion: number | null = null;
  private state: ShipperState = 'running';
  private lagRecords = 0;
  private lastAck: Cursor | undefined;
  private gapFromTs: number | undefined;
  private backoffMs: number;

  constructor(opts: ShipperOpts) {
    this.store = opts.store;
    this.transport = opts.transport;
    this.redact = opts.redact;
    this.deviceId = opts.deviceId;
    this.batchEveryMs = opts.batchEveryMs ?? DEFAULT_BATCH_MS;
    this.batchMax = opts.batchMax ?? DEFAULT_BATCH_MAX;
    this.backoffBaseMs = opts.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = opts.backoff?.capMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.cursor = { ts: 0, id: '' };
    this.backoffMs = this.backoffBaseMs;
  }

  /** Resume from the cursor the app persisted. Only call before start(). */
  resume(cursor: Cursor): void {
    if (!this.stopped) throw new Error('resume before start');
    this.cursor = cursor;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.state !== 'revoked' && this.state !== 'gap') this.state = 'running';
    this.timer = setInterval(() => this.tick(), this.batchEveryMs);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = undefined;
    this.retryTimer = undefined;
  }

  status(): ShipperStatus {
    return {
      state: this.state,
      lagRecords: this.lagRecords,
      ...(this.lastAck ? { lastAck: this.lastAck } : {}),
      ...(this.gapFromTs !== undefined ? { gapFromTs: this.gapFromTs } : {}),
    };
  }

  /** One shipping pass. Skipped while a push is already in flight. */
  private tick(): void {
    if (this.inFlight || this.stopped || this.state === 'revoked') return;
    this.inFlight = true;
    void this.flush().finally(() => {
      this.inFlight = false;
    });
  }

  private async flush(): Promise<void> {
    const gap = this.checkGap();
    const records = this.gather();
    this.lagRecords = records.length;
    if (records.length === 0) {
      if (this.state !== 'gap') this.state = 'running';
      return;
    }
    const request = IngestRequest.parse({
      v: 1,
      deviceId: this.deviceId,
      cursor: this.cursor,
      records,
    });
    try {
      const parsed = IngestAck.parse(await this.transport.push(request));
      // The cursor advances only on an ack: a crash replays, and the relay's
      // dedupe (ids are unique per device) absorbs the replay.
      this.cursor = parsed.ackedCursor;
      this.lastAck = parsed.ackedCursor;
      this.backoffMs = this.backoffBaseMs;
      if (this.state === 'revoked') return; // stopped; the app decides what's next
      if (gap !== undefined) {
        this.gapFromTs = gap;
        this.state = 'gap';
      } else {
        this.gapFromTs = undefined;
        this.state = 'running';
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Pruning-gap detection: with an ack behind the oldest retained event, the
   * span in between was pruned before it shipped. Advance the cursor to the
   * oldest event (the event itself is still here and ships), mark the gap in
   * the status for the app to alert on, and clear it on the next ack.
   */
  private checkGap(): number | undefined {
    if (this.gapFromTs !== undefined) return this.gapFromTs;
    const oldest = this.store.oldestEvent?.() ?? null;
    if (!oldest || !this.lastAck || this.cursor.ts >= oldest.ts) return undefined;
    this.cursor = oldest;
    return oldest.ts;
  }

  /** Reads every kind since the cursor, merges in (ts, id) order, caps the batch. */
  private gather(): ShipRecord[] {
    const limit = this.batchMax;
    const merged = [
      ...this.store.eventsSince(this.cursor, limit),
      ...this.store.alertsSince(this.cursor, limit),
      ...this.store.actionsSince(this.cursor, limit),
      ...this.store.rulesIfChanged(this.ruleVersion),
    ];
    if (merged.length === 0) return [];
    merged.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const records = merged.slice(0, limit);
    // Redaction before send: bodies leaving are the same pass Vigil's AI gets.
    return records.map((record) => ({ ...record, body: this.redact(record.body) }));
  }

  /** A failed push: back off (doubled, jittered, capped) and keep the cursor. */
  private fail(err: unknown): void {
    if (err instanceof RevokedError) {
      this.state = 'revoked';
      this.stop();
      return;
    }
    this.state = 'backoff';
    const jitter = this.backoffMs * JITTER * (Math.random() * 2 - 1);
    const wait = Math.min(this.backoffMs + jitter, this.backoffCapMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.backoffCapMs);
    if (!this.stopped) {
      this.retryTimer = setTimeout(() => this.tick(), Math.max(0, wait));
      this.retryTimer.unref?.();
    }
    // The failure itself surfaces through status(); the app's service logs it.
    if (process.env.NODE_ENV !== 'test') {
      console.error('[relay-shipper]', err instanceof Error ? err.message : err);
    }
  }
}

/** The relay refused this device's token: shipping stops until re-provisioned. */
export class RevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevokedError';
  }
}
