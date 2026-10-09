import type { BackoffOptions } from './backoff.js';
import { backoffDelay, DEFAULT_BACKOFF } from './backoff.js';
import type {
  RuleSnapshot,
  ShipperStore,
  StoredAction,
  StoredAlert,
  StoredEvent,
} from './store.js';
import type { ShipperTransport } from './transport.js';
import {
  AlertBody,
  EventBody,
  IngestAck,
  IngestRequest,
  MAX_BATCH_RECORDS,
  type Cursor,
  type ShipRecord,
} from '@vigil/core';

/** How often a healthy engine looks for new records: the house batch discipline. */
export const BATCH_EVERY_MS = 1_000;

/** The most records one batch may carry — the relay's ingest cap. */
export const BATCH_MAX = MAX_BATCH_RECORDS;

/** Gap notes kept in `status()`, oldest first. */
export const MAX_GAP_NOTES = 10;

export type ShipperState = 'running' | 'backoff' | 'gap' | 'error';

/** Unsent records the store pruned before they could ship: the position jumped forward. */
export interface GapNote {
  /** The cursor position after the last shipped record before the gap. */
  from: Cursor;
  /** The oldest record the store still held when the gap was found. */
  to: Cursor;
  /** When the gap was detected, in ms from the epoch. */
  at: number;
}

/**
 * Why the engine stopped itself. `revoked`: the relay refused the device
 * token. `rejected`: the relay or its reply is permanently unacceptable
 * (a deterministic 4xx, an unparseable ack). `malformed`: a redacted body
 * failed the wire schema — never ship what we would not parse.
 */
export interface HaltReason {
  kind: 'revoked' | 'rejected' | 'malformed';
  message?: string;
}

export interface ShipperStatus {
  state: ShipperState;
  /** Records read from the store and not yet acked by the relay. */
  lagRecords: number;
  lastAck?: Cursor;
  lastAckAt?: number;
  /** Pruning gaps found so far, oldest first, at most `MAX_GAP_NOTES`. */
  gaps: GapNote[];
  /** Set while the engine has stopped itself; `start()` resumes shipping. */
  halted?: HaltReason;
  /** The last failure's message, whether it halted the engine or backed off. */
  lastError?: string;
}

export interface RelayShipperOptions {
  /** The device identity the relay knows this laptop by. */
  deviceId: string;
  store: ShipperStore;
  transport: ShipperTransport;
  /**
   * Applied to every record body before a record is built and sent — the
   * wiring passes `redactValue(b, localNames())` from `@vigil/ai/redact`, the
   * same pass Vigil's own AI gets. Required: the engine never ships a body
   * that has not been through it.
   */
  redact: (body: unknown) => unknown;
  /** Where to start reading; the wiring loads it from the settings store. Defaults to the stream's beginning. */
  cursor?: Cursor;
  batchEveryMs?: number;
  batchMax?: number;
  backoff?: BackoffOptions;
  /** Called on every relay ack so the wiring can persist the cursor; the engine holds no storage. */
  onAck?: (cursor: Cursor) => void;
  /** Called when pruning beat the shipper; wire this to the house alert channel. */
  onGap?: (note: GapNote) => void;
  /** Called when the engine stops itself; wire this to the house alert channel too. */
  onHalt?: (reason: HaltReason) => void;
  /** Clock, injected for tests. */
  now?: () => number;
}

/** A failure no retry can fix; the engine halts instead of burning the schedule. */
class HaltError extends Error {
  constructor(
    public readonly kind: HaltReason['kind'],
    message: string,
  ) {
    super(message);
    this.name = 'HaltError';
  }
}

const RETRYABLE_STATUS = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

/**
 * The id that sorts below every real record id — record ids are long
 * hashes — used where a position means "before any id at this ts". The
 * wire's Cursor requires a non-empty id (the contract's `Id` bound), so a
 * position at the stream's origin carries this placeholder, not `''`.
 */
const BEFORE_IDS = '0';

/**
 * The later of two cursor positions by (ts, id). The engine never lets its
 * cursor move backward, whatever the relay's ack says.
 */
export function laterCursor(a: Cursor, b: Cursor): Cursor {
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  if (a.id !== b.id) return a.id > b.id ? a : b;
  return a;
}

/**
 * Ships the app's stored telemetry to the relay: reads the store through the
 * thin `ShipperStore` interface, redacts every body, batches at the house
 * discipline (1 s or 500 records), and pushes gzipped through the injected
 * transport. The cursor moves only when the relay acks, so a crash replays a
 * batch and the relay's dedupe absorbs it — at-least-once, never lossy.
 *
 * The engine starts when the wiring calls `start()` (the setting is on, the
 * token exists) and stops on `stop()`. It sends nothing but ingest batches
 * and holds no secrets — the transport keeps the device token.
 */
export class RelayShipper {
  private readonly store: ShipperStore;
  private readonly transport: ShipperTransport;
  private readonly redact: (body: unknown) => unknown;
  private readonly onAck: RelayShipperOptions['onAck'];
  private readonly onGap: RelayShipperOptions['onGap'];
  private readonly onHalt: RelayShipperOptions['onHalt'];
  private readonly deviceId: string;
  private readonly batchEveryMs: number;
  private readonly batchMax: number;
  private readonly backoff: Required<BackoffOptions>;
  private readonly now: () => number;

  private cursor: Cursor;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cycling = false;
  private stopped = true;
  private state: ShipperState = 'running';
  private failures = 0;
  private lagRecords = 0;
  private retryInMs = DEFAULT_BACKOFF.baseMs;
  private lastAck: Cursor | undefined;
  private lastAckAt: number | undefined;
  private lastError: string | undefined;
  private halted: HaltReason | undefined;
  private gaps: GapNote[] = [];
  /**
   * Whether the cursor marks a real acked position. A brand-new shipper
   * ({ts: 0, id: '0'}, nothing acked yet) has nothing to lose, so pruning
   * cannot make a gap until the first ack — or a restart from a saved cursor.
   */
  private positioned: boolean;
  private shippedRuleVersion: number | undefined;
  private pendingRuleVersion: number | undefined;
  /** The batch read and built but not yet acked; resent until the relay takes it. */
  private pendingBatch: IngestRequest | undefined;

  constructor(opts: RelayShipperOptions) {
    // Validated through the wire schema itself — one source of truth for the
    // device-id shape the relay enforces.
    this.deviceId = IngestRequest.shape.deviceId.parse(opts.deviceId);
    this.store = opts.store;
    this.transport = opts.transport;
    this.redact = opts.redact;
    this.onAck = opts.onAck;
    this.onGap = opts.onGap;
    this.onHalt = opts.onHalt;
    if (opts.batchMax !== undefined && (!Number.isInteger(opts.batchMax) || opts.batchMax < 1)) {
      throw new Error(`batchMax must be a positive integer, got ${opts.batchMax}`);
    }
    this.batchMax = Math.min(opts.batchMax ?? BATCH_MAX, BATCH_MAX);
    if (
      opts.batchEveryMs !== undefined &&
      (!Number.isInteger(opts.batchEveryMs) || opts.batchEveryMs < 50)
    ) {
      throw new Error(
        `batchEveryMs must be an integer of at least 50 ms, got ${String(opts.batchEveryMs)}`,
      );
    }
    this.batchEveryMs = opts.batchEveryMs ?? BATCH_EVERY_MS;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.now = opts.now ?? Date.now;
    this.cursor = opts.cursor ? { ...opts.cursor } : { ts: 0, id: BEFORE_IDS };
    this.positioned = opts.cursor !== undefined;
  }

  /** Begins the cycle. Resumes a halted engine — the wiring decides when that is safe. */
  start(): void {
    this.stopped = false;
    this.halted = undefined;
    if (!this.cycling && this.timer === undefined) this.scheduleNext(0);
  }

  /** Stops the cycle. An in-flight push still settles; the cursor moves only on its ack. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  status(): ShipperStatus {
    return {
      state: this.state,
      lagRecords: this.lagRecords,
      ...(this.lastAck ? { lastAck: { ...this.lastAck } } : {}),
      ...(this.lastAckAt !== undefined ? { lastAckAt: this.lastAckAt } : {}),
      gaps: this.gaps.map((g) => ({ at: g.at, from: { ...g.from }, to: { ...g.to } })),
      ...(this.halted ? { halted: { ...this.halted } } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped || this.halted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.cycle();
    }, delayMs);
  }

  private async cycle(): Promise<void> {
    if (this.cycling || this.stopped || this.halted) return;
    this.cycling = true;
    try {
      await this.tick();
    } finally {
      this.cycling = false;
      if (!this.stopped && !this.halted) {
        this.scheduleNext(this.state === 'backoff' ? this.retryInMs : this.batchEveryMs);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.halted) return;
    try {
      if (!this.pendingBatch) {
        await this.detectGap();
        this.pendingBatch = await this.buildBatch();
        if (!this.pendingBatch) return; // nothing new to ship
      }
      await this.pushPendingBatch();
    } catch (err) {
      if (err instanceof HaltError) {
        this.halt({ kind: err.kind, message: err.message });
        return;
      }
      this.failures += 1;
      this.state = 'backoff';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.retryInMs = backoffDelay(this.failures - 1, this.backoff);
    }
  }

  private halt(reason: HaltReason): void {
    this.halted = reason;
    this.state = 'error';
    this.lastError = reason.message;
    this.onHalt?.(reason);
  }

  /**
   * The store's oldest surviving event belongs at or behind the cursor —
   * pruning is oldest-first. When it has moved past the cursor, records the
   * shipper never read were dropped: advance to the oldest survivor, note the
   * gap (bounded, repeats folded), and let the wiring raise the house alert.
   */
  private async detectGap(): Promise<void> {
    // Before the first ack (or a saved cursor) there is no position to be
    // behind: the whole store is simply where the stream starts.
    if (!this.positioned) return;
    const oldest = await this.store.oldestEvent();
    if (!oldest || oldest.ts <= this.cursor.ts) return;
    const from: Cursor = { ...this.cursor };
    // BEFORE_IDS sorts below every real id, so the next read includes the survivor itself.
    this.cursor = { ts: oldest.ts, id: BEFORE_IDS };
    const note: GapNote = { from, to: { ...oldest }, at: this.now() };
    const last = this.gaps[this.gaps.length - 1];
    if (last && last.from.ts === from.ts && last.to.ts === oldest.ts && last.to.id === oldest.id) {
      last.at = note.at;
      return;
    }
    this.gaps.push(note);
    if (this.gaps.length > MAX_GAP_NOTES) this.gaps = this.gaps.slice(-MAX_GAP_NOTES);
    this.state = 'gap';
    this.onGap?.(note);
  }

  private async buildBatch(): Promise<IngestRequest | undefined> {
    const limit = this.batchMax;
    const [events, alerts, actions] = await Promise.all([
      this.store.eventsSince(this.cursor, limit),
      this.store.alertsSince(this.cursor, limit),
      this.store.actionsSince(this.cursor, limit),
    ]);
    const positioned: Array<{ ts: number; id: string; record: ShipRecord }> = [
      ...events.map((e) => ({ ts: e.ts, id: e.id, record: this.eventRecord(e) })),
      ...alerts.map((a) => ({ ts: a.ts, id: a.id, record: this.alertRecord(a) })),
      ...actions.map((a) => ({ ts: a.ts, id: a.id, record: this.actionRecord(a) })),
    ];
    positioned.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const records = positioned.slice(0, limit).map((p) => p.record);
    // A rules snapshot rides along only when the batch has room: the relay
    // takes at most 500 records, and the snapshot stays pending until it ships.
    const snapshot = await this.store.rulesIfChanged(this.shippedRuleVersion);
    if (snapshot && records.length < limit) {
      records.push(this.ruleRecord(snapshot));
      this.pendingRuleVersion = snapshot.version;
    }
    if (records.length === 0) return undefined;
    // These are now read and unacked; the ack subtracts what the relay took.
    this.lagRecords += records.length;
    return IngestRequest.parse({
      v: 1,
      deviceId: this.deviceId,
      cursor: { ...this.cursor },
      records,
    });
  }

  private eventRecord(stored: StoredEvent): ShipRecord {
    // The sensor's raw record never ships, even for alert-referenced events.
    const { raw: _raw, ...body } = stored.body;
    const parsed = EventBody.safeParse(this.redact(body));
    if (!parsed.success) {
      throw new HaltError(
        'malformed',
        `redacted event body failed the wire schema: ${parsed.error.message}`,
      );
    }
    return { r: 'event', id: stored.id, ts: stored.ts, body: parsed.data };
  }

  private alertRecord(stored: StoredAlert): ShipRecord {
    const parsed = AlertBody.safeParse(this.redact(stored.body));
    if (!parsed.success) {
      throw new HaltError(
        'malformed',
        `redacted alert body failed the wire schema: ${parsed.error.message}`,
      );
    }
    return { r: 'alert', id: stored.id, ts: stored.ts, body: parsed.data };
  }

  private actionRecord(stored: StoredAction): ShipRecord {
    return { r: 'action', id: stored.id, ts: stored.ts, body: this.redact(stored.body) };
  }

  private ruleRecord(snapshot: RuleSnapshot): ShipRecord {
    return {
      r: 'rule',
      id: snapshot.id,
      version: snapshot.version,
      body: this.redact(snapshot.body),
    };
  }

  private async pushPendingBatch(): Promise<void> {
    const request = this.pendingBatch;
    if (!request) return;
    const reply = await this.transport.push(request);
    if (reply.status === 200 || reply.status === 202) {
      let ackRaw: unknown;
      try {
        ackRaw = JSON.parse(reply.body);
      } catch {
        throw new HaltError('rejected', `relay reply is not JSON (HTTP ${reply.status})`);
      }
      const ack = IngestAck.safeParse(ackRaw);
      if (!ack.success) {
        throw new HaltError('rejected', `relay reply is not an ingest ack (HTTP ${reply.status})`);
      }
      // Never let the cursor move backward, whatever the relay's ack says.
      this.cursor = laterCursor(ack.data.ackedCursor, this.cursor);
      this.positioned = true;
      this.lastAck = { ...this.cursor };
      this.lastAckAt = this.now();
      this.onAck?.(this.cursor);
      this.lagRecords = Math.max(0, this.lagRecords - (ack.data.accepted + ack.data.duplicates));
      this.failures = 0;
      this.state = 'running';
      this.pendingBatch = undefined;
      if (this.pendingRuleVersion !== undefined) {
        this.shippedRuleVersion = this.pendingRuleVersion;
        this.pendingRuleVersion = undefined;
      }
    } else if (reply.status === 401 || reply.status === 403) {
      throw new HaltError('revoked', `relay refused the device token (HTTP ${reply.status})`);
    } else if (RETRYABLE_STATUS(reply.status)) {
      this.lastError = `relay returned HTTP ${reply.status}`;
      throw new Error(`relay returned HTTP ${reply.status}`);
    } else {
      throw new HaltError('rejected', `relay returned HTTP ${reply.status}`);
    }
  }
}
