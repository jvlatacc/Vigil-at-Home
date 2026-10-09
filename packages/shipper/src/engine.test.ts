import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  laterCursor,
  RelayShipper,
  type GapNote,
  type HaltReason,
  type ShipperStatus,
} from './engine.js';
import type {
  RuleSnapshot,
  ShipperStore,
  StoredAction,
  StoredAlert,
  StoredEvent,
} from './store.js';
import type { ShipperTransport } from './transport.js';
import type { Alert, Cursor, IngestAck, IngestRequest, SensorEvent, ShipRecord } from '@vigil/core';

// ---------------------------------------------------------------------------
// Fakes: the store, the transport, the redactor. The clock is vitest's.
// ---------------------------------------------------------------------------

class FakeStore implements ShipperStore {
  events: StoredEvent[] = [];
  alerts: StoredAlert[] = [];
  actions: StoredAction[] = [];
  snapshot: RuleSnapshot | undefined;

  async eventsSince(cursor: Cursor, limit: number): Promise<StoredEvent[]> {
    return this.events
      .filter((e) => e.ts > cursor.ts || (e.ts === cursor.ts && e.id > cursor.id))
      .slice(0, limit);
  }
  async alertsSince(cursor: Cursor, limit: number): Promise<StoredAlert[]> {
    return this.alerts
      .filter((a) => a.ts > cursor.ts || (a.ts === cursor.ts && a.id > cursor.id))
      .slice(0, limit);
  }
  async actionsSince(cursor: Cursor, limit: number): Promise<StoredAction[]> {
    return this.actions
      .filter((a) => a.ts > cursor.ts || (a.ts === cursor.ts && a.id > cursor.id))
      .slice(0, limit);
  }
  async rulesIfChanged(shipped: number | undefined): Promise<RuleSnapshot | undefined> {
    return this.snapshot && this.snapshot.version !== shipped ? this.snapshot : undefined;
  }
  async oldestEvent(): Promise<Cursor | undefined> {
    const first = this.events[0];
    return first ? { ts: first.ts, id: first.id } : undefined;
  }
}

class FakeTransport implements ShipperTransport {
  calls: IngestRequest[] = [];
  reply: (request: IngestRequest, call: number) => { status: number; body: string } = () => ({
    status: 202,
    body: '{}',
  });
  async push(request: IngestRequest) {
    this.calls.push(structuredClone(request));
    return this.reply(request, this.calls.length - 1);
  }
}

const redactedInputs: unknown[] = [];
const redact = (body: unknown): unknown => {
  redactedInputs.push(body);
  return JSON.parse(JSON.stringify(body).replaceAll('/Users/alice', '/Users/<user>'));
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let n = 0;
const makeEvent = (ts: number, overrides: Partial<SensorEvent> = {}): StoredEvent => {
  n += 1;
  const id = `e${String(n).padStart(4, '0')}`;
  return {
    id,
    ts,
    body: {
      id,
      ts,
      source: 'osquery',
      kind: 'process.exec',
      process: {
        pid: 4000 + n,
        path: `/Users/alice/tools/app${n}`,
        args: [`/Users/alice/run${n}.sh`],
        signing: 'unsigned',
      },
      ...overrides,
    } as SensorEvent,
  };
};

const makeAlert = (ts: number, eventIds: string[]): StoredAlert => {
  n += 1;
  const id = `a${String(n).padStart(4, '0')}`;
  const body: Alert = {
    id,
    createdAt: ts,
    updatedAt: ts,
    ruleId: 'core.exec-script',
    ruleVersion: 3,
    title: 'Scripted fetch',
    summary: 'A script tried to fetch something.',
    severity: 'medium',
    fidelity: 'high',
    notify: 'badge',
    status: 'open',
    containment: 'none',
    eventIds,
    actionIds: [],
  };
  return { id, ts, body };
};

const makeAction = (ts: number): StoredAction => {
  n += 1;
  const id = `x${String(n).padStart(4, '0')}`;
  return { id, ts, body: { kind: 'process.kill', pid: 4242, at: ts } };
};

/** The relay-side ack: everything accepted, cursor at the last record. */
const ackFor = (
  request: IngestRequest,
  accepted = request.records.length,
  duplicates = 0,
): string => {
  // A rule record carries no ts (spec shape), so the cursor stands on the
  // last positional record; an all-rules batch acks the stream's beginning.
  const positional = [...request.records].reverse().find((r) => r.r !== 'rule');
  const ack: IngestAck = {
    v: 1,
    accepted,
    duplicates,
    ackedCursor: positional ? { ts: positional.ts, id: positional.id } : { ts: 0, id: '0' },
  };
  return JSON.stringify(ack);
};

interface Harness {
  store: FakeStore;
  transport: FakeTransport;
  acks: Cursor[];
  gaps: GapNote[];
  halts: HaltReason[];
  shipper: RelayShipper;
  status(): ShipperStatus;
}

const DEVICE = 'laptop-a1b2c3';

function makeShipper(opts: Partial<ConstructorParameters<typeof RelayShipper>[0]> = {}): Harness {
  const store = new FakeStore();
  const transport = new FakeTransport();
  const acks: Cursor[] = [];
  const gaps: GapNote[] = [];
  const halts: HaltReason[] = [];
  const shipper = new RelayShipper({
    deviceId: DEVICE,
    store,
    transport,
    redact,
    onAck: (cursor) => acks.push({ ...cursor }),
    onGap: (note) => gaps.push({ ...note }),
    onHalt: (reason) => halts.push({ ...reason }),
    ...opts,
  });
  return {
    store,
    transport,
    acks,
    gaps,
    halts,
    shipper,
    status: () => shipper.status(),
  };
}

/** One full engine cycle: the timer fires and the tick's promises settle. */
const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  redactedInputs.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Batch discipline
// ---------------------------------------------------------------------------

describe('batch discipline', () => {
  it('ships what the store holds on each 1 s cycle', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000), makeEvent(2000)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick(); // first cycle, at t=0
    expect(h.transport.calls).toHaveLength(1);
    expect(h.transport.calls[0]!.records).toHaveLength(2);

    h.store.events.push(makeEvent(3000));
    await tick(999); // 999 ms later: not yet
    expect(h.transport.calls).toHaveLength(1);
    await tick(1); // the 1 s boundary
    expect(h.transport.calls).toHaveLength(2);
    expect(h.transport.calls[1]!.records.map((r) => r.id)).toEqual(['e0003']);
  });

  it('caps a batch at 500 records and drains the rest on later cycles', async () => {
    const h = makeShipper();
    h.store.events = Array.from({ length: 1200 }, (_, i) => makeEvent(i + 1));
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    await tick(1000);
    await tick(1000);
    expect(h.transport.calls.map((c) => c.records.length)).toEqual([500, 500, 200]);
    expect(h.status().lagRecords).toBe(0);
    expect(h.acks).toHaveLength(3);
  });

  it('merges streams in (ts, id) order', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000), makeEvent(3000)];
    h.store.alerts = [makeAlert(2000, ['e0001'])];
    h.store.actions = [makeAction(3500)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.transport.calls[0]!.records.map((r) => r.r)).toEqual([
      'event',
      'alert',
      'event',
      'action',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('runs every body through the redactor and strips raw', async () => {
    const h = makeShipper();
    const event = makeEvent(1000);
    (event.body as { raw?: unknown }).raw = { santa: 'original log line' };
    h.store.events = [event];
    h.store.alerts = [makeAlert(1100, [event.id])];
    h.store.actions = [makeAction(1200)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();

    const wire = JSON.stringify(h.transport.calls[0]);
    expect(wire).not.toContain('alice');
    expect(wire).toContain('/Users/<user>');
    expect(wire).not.toContain('original log line');
    expect(redactedInputs).toHaveLength(3); // event, alert, action
    // Records arriving at the transport still satisfy the ingest schema.
    expect(h.transport.calls[0]!.records).toHaveLength(3);
  });

  it('halts without shipping when a redacted body fails the wire schema', async () => {
    const h = makeShipper({
      redact: () => ({ kind: 'process.exec' }) as unknown, // required fields gone
    });
    h.store.events = [makeEvent(1000)];
    h.shipper.start();
    await tick();
    expect(h.transport.calls).toHaveLength(0);
    const st = h.status();
    expect(st.state).toBe('error');
    expect(st.halted?.kind).toBe('malformed');
    expect(h.halts[0]?.kind).toBe('malformed');
  });
});

// ---------------------------------------------------------------------------
// Cursor: advances only on ack
// ---------------------------------------------------------------------------

describe('cursor', () => {
  it('moves only on the relay ack, even when the store has more', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000), makeEvent(2000)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.acks).toEqual([{ ts: 2000, id: 'e0002' }]);
    expect(h.status().lastAck).toEqual({ ts: 2000, id: 'e0002' });
  });

  it('counts lag from build to ack', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000), makeEvent(2000), makeEvent(3000)];
    h.transport.reply = () => ({ status: 503, body: 'overloaded' });
    h.shipper.start();
    await tick();
    expect(h.status().lagRecords).toBe(3);
    expect(h.status().lastAck).toBeUndefined();

    h.transport.reply = (req) => ({ status: 202, body: ackFor(req, 0, 3) });
    await tick(5000); // backoff elapsed; the same batch is replayed
    expect(h.status().lagRecords).toBe(0);
    expect(h.acks).toEqual([{ ts: 3000, id: 'e0003' }]);
  });
});

// ---------------------------------------------------------------------------
// Crash-replay idempotence
// ---------------------------------------------------------------------------

describe('crash replay', () => {
  it('replays the byte-identical batch when an ack is lost, duplicates counted, none lost', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000), makeEvent(2000)];
    // The relay stores the first push but the laptop sees only a 503.
    h.transport.reply = (req, call) =>
      call === 0
        ? { status: 503, body: 'ack lost' }
        : { status: 202, body: ackFor(req, 0, req.records.length) };
    h.shipper.start();
    await tick();
    await tick(5000);
    expect(h.transport.calls).toHaveLength(2);
    expect(h.transport.calls[0]).toEqual(h.transport.calls[1]); // same batch, byte-identical
    // Nothing lost: the duplicates were counted delivered and the cursor moved.
    expect(h.acks).toEqual([{ ts: 2000, id: 'e0002' }]);
    expect(h.status().lagRecords).toBe(0);
  });

  it('keeps the pending batch across failures instead of rebuilding it', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000)];
    h.transport.reply = (req, call) =>
      call < 2 ? { status: 500, body: 'x' } : { status: 202, body: ackFor(req) };
    h.shipper.start();
    await tick();
    await tick(5000);
    await tick(10000);
    expect(h.transport.calls).toHaveLength(3);
    expect(new Set(h.transport.calls.map((c) => JSON.stringify(c))).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('backoff', () => {
  it('retries at 5 s, 10 s, 20 s; resets to 1 s after an ack', async () => {
    const h = makeShipper({ backoff: { jitter: () => 1 } });
    h.store.events = [makeEvent(1000)];
    h.transport.reply = (req, call) =>
      call < 3 ? { status: 500, body: 'x' } : { status: 202, body: ackFor(req) };
    h.shipper.start();
    await tick(); // failure 1: next retry in 5 s
    expect(h.status().state).toBe('backoff');
    await tick(4999);
    expect(h.transport.calls).toHaveLength(1);
    await tick(1); // t=5 s: failure 2, next in 10 s
    expect(h.transport.calls).toHaveLength(2);
    await tick(9999);
    expect(h.transport.calls).toHaveLength(2);
    await tick(1); // t=15 s: failure 3, next in 20 s
    expect(h.transport.calls).toHaveLength(3);
    await tick(20_000); // t=35 s: the push finally lands
    expect(h.transport.calls).toHaveLength(4);
    expect(h.status().state).toBe('running');
    const callsAfterAck = h.transport.calls.length;

    h.store.events.push(makeEvent(2000));
    await tick(1000); // healthy cadence again, not 40 s
    expect(h.transport.calls.length).toBe(callsAfterAck + 1);
    expect(h.status().state).toBe('running');
  });

  it('doubles 5 s to the 5-minute cap, jittered within [delay/2, delay)', async () => {
    // The engine schedules its next wait in `retryInMs`; driving one retry at
    // a time with the fake timers pins the schedule exactly.
    const nextDelay = (s: RelayShipper): number =>
      (s as unknown as { retryInMs: number }).retryInMs;

    const h = makeShipper({ backoff: { jitter: () => 1 } });
    h.store.events = [makeEvent(1000)];
    h.transport.reply = () => ({ status: 500, body: 'x' });
    h.shipper.start();
    await tick(); // start's immediate timer: failure 1
    const expected = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
    expect(nextDelay(h.shipper)).toBe(expected[0]);
    for (let i = 1; i < expected.length; i += 1) {
      await vi.advanceTimersToNextTimerAsync(); // exactly the pending retry fires
      expect(nextDelay(h.shipper)).toBe(expected[i]);
    }

    const h2 = makeShipper({ backoff: { jitter: () => 0 } });
    h2.store.events = [makeEvent(1000)];
    h2.transport.reply = () => ({ status: 500, body: 'x' });
    h2.shipper.start();
    await tick();
    expect(nextDelay(h2.shipper)).toBe(2_500); // half of 5 s
    await vi.advanceTimersToNextTimerAsync();
    expect(nextDelay(h2.shipper)).toBe(5_000); // half of 10 s
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersToNextTimerAsync();
    expect(nextDelay(h2.shipper)).toBe(150_000); // half of the 5-minute cap
  });
});

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

describe('gap detection', () => {
  it('advances past pruned events, reports the gap, ships what survives', async () => {
    const h = makeShipper({ cursor: { ts: 100, id: 'e0000' } });
    // The cursor stands at ts=100; the store was pruned to begin at ts=500.
    h.store.events = [makeEvent(500), makeEvent(600)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.gaps).toEqual([
      { from: { ts: 100, id: 'e0000' }, to: { ts: 500, id: 'e0001' }, at: expect.any(Number) },
    ]);
    expect(h.status().gaps).toHaveLength(1);
    const batch = h.transport.calls[0]!;
    expect(batch.cursor).toEqual({ ts: 500, id: '0' }); // jumped forward
    expect(batch.records.map((r) => r.id)).toEqual(['e0001', 'e0002']);
    expect(h.acks[0]).toEqual({ ts: 600, id: 'e0002' });
    expect(h.status().lastAck).toEqual({ ts: 600, id: 'e0002' });
  });

  it('does not report a gap while the oldest event is still at or behind the cursor', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(500), makeEvent(600)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.gaps).toEqual([]);
    expect(h.status().gaps).toEqual([]);
  });

  it('folds repeated looks at the same gap into one note', async () => {
    const h = makeShipper({ cursor: { ts: 100, id: 'e0000' } });
    h.store.events = [makeEvent(500)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    await tick(1000); // nothing new; the gap stays one note
    expect(h.gaps).toHaveLength(1);
  });

  it('never reports a gap before the first ack: a fresh shipper owns the whole store', async () => {
    const h = makeShipper(); // no cursor: nothing has ever been acked
    h.store.events = [makeEvent(500), makeEvent(600)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.gaps).toEqual([]);
    expect(h.transport.calls[0]!.cursor).toEqual({ ts: 0, id: '0' }); // starts at the beginning
    expect(h.transport.calls[0]!.records.map((r) => r.id)).toEqual(['e0001', 'e0002']);
  });
});

describe('laterCursor', () => {
  it('compares by ts, then id', () => {
    const a = { ts: 5, id: 'a' };
    expect(laterCursor(a, { ts: 4, id: 'z' })).toEqual(a);
    expect(laterCursor(a, { ts: 5, id: 'b' })).toEqual({ ts: 5, id: 'b' });
    expect(laterCursor(a, a)).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Halts: revoked token, rejected relay, and their recovery
// ---------------------------------------------------------------------------

describe('halts', () => {
  it('stops on 403 and stays stopped until started again', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000)];
    h.transport.reply = () => ({ status: 403, body: 'unknown device' });
    h.shipper.start();
    await tick();
    expect(h.status().state).toBe('error');
    expect(h.status().halted?.kind).toBe('revoked');
    expect(h.halts).toEqual([{ kind: 'revoked', message: expect.any(String) }]);
    const callsAtHalt = h.transport.calls.length;
    await tick(300_000);
    await tick(300_000);
    expect(h.transport.calls.length).toBe(callsAtHalt); // no retries on the schedule

    // Re-provisioned: the wiring starts the engine again.
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.transport.calls.length).toBe(callsAtHalt + 1);
    expect(h.status().state).toBe('running');
    expect(h.status().halted).toBeUndefined();
  });

  it('stops on a deterministic 400 and on a 200 reply that is not an ack', async () => {
    const rejected = makeShipper();
    rejected.store.events = [makeEvent(1000)];
    rejected.transport.reply = () => ({ status: 400, body: '{"error":"bad"}' });
    rejected.shipper.start();
    await tick();
    expect(rejected.status().halted?.kind).toBe('rejected');

    const nonsense = makeShipper();
    nonsense.store.events = [makeEvent(1000)];
    nonsense.transport.reply = () => ({ status: 200, body: '<html>gateway</html>' });
    nonsense.shipper.start();
    await tick();
    expect(nonsense.status().halted?.kind).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Rules snapshot
// ---------------------------------------------------------------------------

describe('rules snapshot', () => {
  it('rides along once per version and defers when a batch is full', async () => {
    const h = makeShipper();
    h.store.snapshot = { id: 'rules-snapshot', version: 3, body: { note: 'v3' } };
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });

    h.store.events = Array.from({ length: 500 }, (_, i) => makeEvent(i + 1));
    h.shipper.start();
    await tick();
    const kinds = h.transport.calls[0]!.records.map((r) => r.r);
    expect(kinds.filter((k) => k === 'rule')).toEqual([]); // no room: batch was full
    await tick(1000);
    const second = h.transport.calls[1]!;
    expect(second.records.map((r) => r.r)).toEqual(['rule']); // shipped once events drain
    const rule = second.records.find(
      (r): r is Extract<ShipRecord, { r: 'rule' }> => r.r === 'rule',
    );
    expect(rule?.version).toBe(3);
    await tick(1000);
    expect(h.transport.calls).toHaveLength(2); // unchanged version ships nothing more
  });
});

// ---------------------------------------------------------------------------
// Empty store, start/stop
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('idles without pushing when the store has nothing new', async () => {
    const h = makeShipper();
    h.shipper.start();
    await tick(3000);
    expect(h.transport.calls).toHaveLength(0);
    expect(h.status().state).toBe('running');
    expect(h.status().lagRecords).toBe(0);
  });

  it('stops cleanly and ships nothing while stopped', async () => {
    const h = makeShipper();
    h.store.events = [makeEvent(1000)];
    h.shipper.start();
    h.shipper.stop();
    await tick(5000);
    expect(h.transport.calls).toHaveLength(0);
  });

  it('resumes from the cursor it was built with, as after a restart', async () => {
    const h = makeShipper({ cursor: { ts: 1000, id: 'e0001' } });
    h.store.events = [makeEvent(1000), makeEvent(2000)];
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.transport.calls[0]!.records.map((r) => r.id)).toEqual(['e0002']);
  });

  it('never ships an empty batch even when a rules snapshot is unchanged', async () => {
    const h = makeShipper();
    h.store.snapshot = { id: 'rules-snapshot', version: 1, body: {} };
    h.transport.reply = (req) => ({ status: 202, body: ackFor(req) });
    h.shipper.start();
    await tick();
    expect(h.transport.calls).toHaveLength(1); // first snapshot is a change (undefined → 1)
    expect(h.transport.calls[0]!.records.map((r) => r.r)).toEqual(['rule']);
    await tick(1000);
    expect(h.transport.calls).toHaveLength(1);
  });
});
