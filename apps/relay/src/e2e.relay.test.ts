// End-to-end proof for the MCP telemetry gateway, in one process:
//
//   laptop store → RelayShipper (real engine, real HTTP transport)
//     → POST /v1/ingest → RelayStore (real node:sqlite, WAL)
//
// The relay runs as `startRelay` starts it — real listener, real ingest
// handler, real store, real retention — on an ephemeral port. The
// laptop→relay half below runs against the merged shipper-engine and
// relay-service modules. The SOC-readback half (the same flow read back
// through the MCP face and an SDK client) activates when the MCP-server
// module lands; until then it is staged, marked skip.
//
// The house redactor (`@vigil/ai/redact`, what the wiring passes) runs for
// real on the shipper side; assertions hold the fixture's email address and
// the sensor's raw record out of everything that leaves the laptop.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionRecord, Alert, Cursor, SensorEvent } from '@vigil/core';
import { redactValue, localNames } from '@vigil/ai/redact';
import {
  HttpShipperTransport,
  RelayShipper,
  type RuleSnapshot,
  type ShipperStore,
  type StoredAction,
  type StoredAlert,
  type StoredEvent,
} from '@vigil/shipper';
import { INGEST_PATH } from './ingest.js';
import { startRelay, type RelayServer } from './server.js';
import type { RelayConfig } from './config.js';
import { afterEach, describe, expect, it } from 'vitest';

// ————————————————————————————————————————————————————————————————————————
// Fixtures
// ————————————————————————————————————————————————————————————————————————

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const DEVICE_A = 'device-a-e2e-laptop';
const DEVICE_B = 'device-b-e2e-laptop';
const EVENT_COUNT = 60;
const EMAIL = 'ops@e2e-helpers.example';
const RAW_MARKER = 'SANTA-RAW-MARKER-7f3a';
const EXCLUSION_SECRET = 'EXCLUSION-SECRET-PATTERN';

/** Deterministic ids: stable per record so replays dedupe end to end. */
const rid = (n: number): string => `e2e-${n.toString().padStart(6, '0')}`;

/** A valid slimmed event body per kind: real required fields, no raw. */
function eventBody(i: number, id: string, ts: number, kind: SensorEvent['kind']): SensorEvent {
  const base = { id, ts };
  const proc = {
    path: i === 0 ? '/usr/bin/e2e-needle' : `/usr/bin/tool-${i % 7}`,
    pid: 1000 + i,
    parentPath: '/bin/zsh',
    signing: 'unsigned' as const,
    args: i === 1 ? ['--contact', EMAIL] : [`--pass-i-${i}`],
  };
  switch (kind) {
    case 'process.exec':
      return { kind, ...base, source: 'santa', process: proc };
    case 'network.connection':
      return {
        kind,
        ...base,
        source: 'osquery',
        direction: 'outbound',
        protocol: 'tcp',
        remoteAddress: '203.0.113.7',
        remotePort: 443,
        process: proc,
      };
    case 'file':
      return {
        kind,
        ...base,
        source: 'santa',
        op: 'write',
        path: `/tmp/e2e-${i}.bin`,
        process: proc,
      };
    case 'persistence':
      return {
        kind,
        ...base,
        source: 'osquery',
        change: 'added',
        mechanism: 'launch_agent',
        path: `/Library/LaunchAgents/e2e-${i}.plist`,
      };
    case 'system.alert':
      return {
        kind,
        ...base,
        source: 'osquery',
        subtype: 'xprotect_detected',
        details: { signature: 'e2e' },
      };
    case 'agent.tool_request':
      return {
        kind,
        ...base,
        source: 'vigil',
        agent: { host: 'claude-code' },
        tool: 'Bash',
        command: `tool-${i % 7} --pass-i-${i}`,
      };
    default:
      throw new Error(`fixture covers no body for ${kind}`);
  }
}

/** Sixty events: all six kinds, one needle path, one email arg, one raw record, one outside the 7-day window. */
function seedEvents(count = EVENT_COUNT): StoredEvent[] {
  const kinds: SensorEvent['kind'][] = [
    'process.exec',
    'network.connection',
    'file',
    'persistence',
    'system.alert',
    'agent.tool_request',
  ];
  const rows: StoredEvent[] = [];
  for (let i = 0; i < count; i++) {
    const kind = kinds[i % kinds.length] ?? 'process.exec';
    const isOld = i === count - 1; // outside search_events' 7-day window
    const ts = isOld ? NOW - 8 * DAY : NOW - (count - i) * 1_000;
    const body = eventBody(i, rid(i), ts, kind);
    if (i === 0) {
      // The sensor's own record: stored on the laptop, never shipped.
      body.raw = { santa: RAW_MARKER };
    }
    rows.push({ id: rid(i), ts, body });
  }
  return rows;
}

const ALERT_1: Alert = {
  id: 'e2e-000901',
  createdAt: NOW - 60_000,
  updatedAt: NOW - 30_000,
  ruleId: 'core.exec-script',
  ruleVersion: 1,
  title: 'Scripted interpreter launch',
  summary: 'osascript ran a fetched script',
  severity: 'high',
  fidelity: 'high',
  notify: 'silent',
  status: 'open',
  containment: 'none',
  eventIds: [rid(0)],
  actionIds: [],
  ai: {
    provider: 'e2e',
    at: NOW - 58_000,
    verdict: 'suspicious',
    confidence: 0.7,
    summary: 'looks scripted',
    proposalIds: [],
  },
  decision: { at: NOW - 57_000, verdict: 'benign', remember: false },
};

const ALERT_2: Alert = {
  id: 'e2e-000902',
  createdAt: NOW - 45_000,
  updatedAt: NOW - 40_000,
  ruleId: 'core.exec-script',
  ruleVersion: 1,
  title: 'Repeated network beacon',
  summary: 'same remote every 30 s',
  severity: 'medium',
  fidelity: 'high',
  notify: 'badge',
  status: 'resolved',
  containment: 'none',
  eventIds: [rid(2)],
  actionIds: [],
};

const ACTION_1: ActionRecord = {
  id: 'e2e-000911',
  action: { kind: 'persistence.disable', path: '/Library/LaunchAgents/e2e-3.plist' },
  actor: 'rule',
  ruleId: 'core.exec-script',
  alertId: ALERT_1.id,
  reason: 'matched core.exec-script in block mode',
  requestedAt: NOW - 20_000,
  status: 'done',
  result: { at: NOW - 19_000 },
};

const snapshotBody = (mode: 'alert' | 'block') => ({
  rules: [
    {
      id: 'core.exec-script',
      name: 'core.exec-script',
      description: 'script interpreters doing network things',
      mode,
      severity: 'high',
      exclusions: [EXCLUSION_SECRET],
    },
  ],
});

// ————————————————————————————————————————————————————————————————————————
// The laptop's store, as the shipper reads it
// ————————————————————————————————————————————————————————————————————————

/** Rows strictly after the cursor by (ts, id), oldest first, at most `limit`. */
function keysetAfter<T extends { id: string; ts: number }>(
  rows: T[],
  cursor: Cursor,
  limit: number,
): T[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  const start = sorted.findIndex(
    (r) => r.ts > cursor.ts || (r.ts === cursor.ts && r.id > cursor.id),
  );
  return (start === -1 ? [] : sorted.slice(start)).slice(0, limit);
}

/** A seeded laptop store behind the shipper's thin read interface. */
class SeededLaptopStore implements ShipperStore {
  events: StoredEvent[] = [];
  alerts: StoredAlert[] = [];
  actions: StoredAction[] = [];
  snapshot: RuleSnapshot | undefined;

  async eventsSince(cursor: Cursor, limit: number): Promise<StoredEvent[]> {
    return keysetAfter(this.events, cursor, limit);
  }
  async alertsSince(cursor: Cursor, limit: number): Promise<StoredAlert[]> {
    return keysetAfter(this.alerts, cursor, limit);
  }
  async actionsSince(cursor: Cursor, limit: number): Promise<StoredAction[]> {
    return keysetAfter(this.actions, cursor, limit);
  }
  async rulesIfChanged(shipped: number | undefined): Promise<RuleSnapshot | undefined> {
    return this.snapshot === undefined || this.snapshot.version === shipped
      ? undefined
      : this.snapshot;
  }
  async oldestEvent(): Promise<Cursor | undefined> {
    if (this.events.length === 0) return undefined;
    const oldest = this.events.reduce((a, b) => (a.ts <= b.ts ? a : b));
    return { ts: oldest.ts, id: oldest.id };
  }
  /** Simulates retention pruning, oldest first. */
  prune(count: number): void {
    this.events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    this.events = this.events.slice(count);
  }
}

// ————————————————————————————————————————————————————————————————————————
// The relay harness: the real service on an ephemeral port
// ————————————————————————————————————————————————————————————————————————

const config = (dataDir: string, port?: number): RelayConfig => ({
  dataDir,
  host: '127.0.0.1',
  port: port ?? 0,
  maxDiskBytes: 256 * 1024 * 1024,
  retentionDays: 30,
  maxBodyBytes: 16 * 1024 * 1024,
  ratePerSec: 30,
  burst: 60,
});

interface RelayRig {
  ingestPort: number;
  relay: RelayServer;
  close(): Promise<void>;
}

async function startRelayRig(dataDir: string, ingestPort?: number): Promise<RelayRig> {
  const relay = await startRelay(config(dataDir, ingestPort));
  let closed = false;
  return {
    ingestPort: relay.port,
    relay,
    // Idempotent: the tests close rigs themselves and the afterEach runs
    // the same close again.
    close: async () => {
      if (closed) return;
      closed = true;
      await relay.close();
    },
  };
}

/** Every event id stored for the device — the shipped record of what landed. */
function storedEventIds(dataDir: string, device: string): Set<string> {
  const db = new DatabaseSync(join(dataDir, 'relay.db'));
  try {
    const rows = db
      .prepare('SELECT id FROM relay_events WHERE device_id = ?')
      .all(device) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } finally {
    db.close();
  }
}

/** The relay's stored event bodies for the device, as one string. */
function storedEventBodies(dataDir: string, device: string): string {
  const db = new DatabaseSync(join(dataDir, 'relay.db'));
  try {
    const rows = db
      .prepare('SELECT body FROM relay_events WHERE device_id = ?')
      .all(device) as Array<{ body: string }>;
    return JSON.stringify(rows.map((r) => r.body));
  } finally {
    db.close();
  }
}

/** The mode of the device's latest shipped rule snapshot, if one is stored. */
function storedSnapshotMode(dataDir: string, device: string): string | undefined {
  const db = new DatabaseSync(join(dataDir, 'relay.db'));
  try {
    const row = db.prepare('SELECT body FROM rule_snapshots WHERE device_id = ?').get(device) as
      { body: string } | undefined;
    const body = row === undefined ? undefined : (JSON.parse(row.body) as snapshotShape);
    return body?.rules[0]?.mode;
  } finally {
    db.close();
  }
}
type snapshotShape = { rules: Array<{ mode: string }> };

async function waitFor(what: string, probe: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ————————————————————————————————————————————————————————————————————————
// The tests
// ————————————————————————————————————————————————————————————————————————

describe('relay e2e: laptop → relay, merged modules', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const addCleanup = (c: () => Promise<void> | void): void => {
    cleanups.push(c);
  };

  afterEach(async () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      await c?.();
    }
  });

  const shipperOpts = (rig: RelayRig, token: string) => ({
    transport: new HttpShipperTransport({
      endpoint: `http://127.0.0.1:${rig.ingestPort}${INGEST_PATH}`,
      token,
    }),
    redact: (body: unknown) => redactValue(body, localNames()),
    batchEveryMs: 50,
    backoff: { baseMs: 20, maxMs: 100, jitter: () => 0.1 },
  });

  it('ships all four record kinds from the laptop to the relay', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vigil-relay-e2e-'));
    addCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const rig = await startRelayRig(dataDir);
    addCleanup(() => rig.close());

    const device = rig.relay.store.provisionDevice(DEVICE_A, Date.now());
    rig.relay.store.provisionDevice(DEVICE_B, Date.now());
    const soc = rig.relay.store.provisionSoc('soc-e2e', Date.now());

    // The laptop's own store, and a second device whose data lands directly
    // (device B exists to prove per-device storage, not shipping).
    const laptop = new SeededLaptopStore();
    laptop.events = seedEvents();
    laptop.alerts = [
      { id: ALERT_1.id, ts: ALERT_1.createdAt, body: ALERT_1 },
      { id: ALERT_2.id, ts: ALERT_2.createdAt, body: ALERT_2 },
    ];
    laptop.actions = [{ id: ACTION_1.id, ts: ACTION_1.requestedAt, body: ACTION_1 }];
    laptop.snapshot = { id: 'e2e-000900', version: 1, body: snapshotBody('alert') };
    rig.relay.store.applyBatch(
      DEVICE_B,
      [
        {
          r: 'event',
          id: 'e2e-b-000001',
          ts: NOW - 5_000,
          body: eventBody(50, 'e2e-b-000001', NOW - 5_000, 'process.exec'),
        },
        {
          r: 'event',
          id: 'e2e-b-000002',
          ts: NOW - 4_000,
          body: eventBody(51, 'e2e-b-000002', NOW - 4_000, 'file'),
        },
      ],
      Date.now(),
    );

    const shipper = new RelayShipper({
      deviceId: DEVICE_A,
      store: laptop,
      ...shipperOpts(rig, device.token),
    });
    shipper.start();
    addCleanup(() => shipper.stop());

    await waitFor('all laptop records to land on the relay', () => {
      const stats = rig.relay.store.stats();
      return (
        stats.events === EVENT_COUNT + 2 &&
        stats.alerts === 2 &&
        stats.actions === 1 &&
        stats.rules === 1 &&
        shipper.status().state === 'running' &&
        shipper.status().lagRecords === 0
      );
    });

    // What landed on the relay is the slimmed, redacted form: the sensor's
    // raw record never left the laptop, and the house redactor ran on the
    // rest — the fixture's email arg included.
    expect(storedEventIds(dataDir, DEVICE_A).has(rid(0))).toBe(true);
    const stored = storedEventBodies(dataDir, DEVICE_A);
    expect(stored).not.toContain(RAW_MARKER);
    expect(stored).not.toContain(EMAIL);

    // The auth matrix, on the ingest face: a device token pushes (the
    // shipper just proved it); no token or a SOC token does not.
    const ingestUrl = `http://127.0.0.1:${rig.ingestPort}${INGEST_PATH}`;
    const post = (token?: string): Promise<Response> =>
      fetch(ingestUrl, {
        method: 'POST',
        headers: {
          ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ v: 1, deviceId: DEVICE_A, cursor: { ts: 0, id: '0' }, records: [] }),
      });
    expect((await post()).status).toBe(401); // no token
    expect((await post(soc.token)).status).toBe(401); // a SOC token cannot push
  }, 20_000);

  it('dedupes a replayed batch and moves the cursor only on ack', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vigil-relay-dedupe-'));
    addCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const rig = await startRelayRig(dataDir);
    addCleanup(() => rig.close());
    const device = rig.relay.store.provisionDevice(DEVICE_A, Date.now());

    // A valid single-record batch, pushed twice by hand: the first lands,
    // the identical replay counts its duplicates and stores nothing new.
    const record = {
      r: 'event' as const,
      id: rid(0),
      ts: NOW - 1_000,
      body: eventBody(0, rid(0), NOW - 1_000, 'process.exec'),
    };
    const post = (body: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${rig.ingestPort}${INGEST_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${device.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const batch = {
      v: 1 as const,
      deviceId: DEVICE_A,
      cursor: { ts: 0, id: '0' },
      records: [record],
    };

    const first = await post(batch);
    expect(first.status).toBe(200);
    const ack1 = (await first.json()) as { accepted: number; duplicates: number };
    expect(ack1.accepted).toBe(1);
    expect(ack1.duplicates).toBe(0);

    const replay = await post(batch);
    expect(replay.status).toBe(202); // accepted, nothing new stored
    const ack2 = (await replay.json()) as { accepted: number; duplicates: number };
    expect(ack2.accepted).toBe(0);
    expect(ack2.duplicates).toBe(1);
    expect(rig.relay.store.stats().events).toBe(1); // exactly one row, ever
  }, 20_000);

  it('detects a pruning gap and says so instead of losing it silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vigil-relay-gap-'));
    addCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const rig = await startRelayRig(dataDir);
    addCleanup(() => rig.close());
    const device = rig.relay.store.provisionDevice(DEVICE_A, Date.now());

    const laptop = new SeededLaptopStore();
    for (let i = 0; i < 5; i++) {
      laptop.events.push({
        id: rid(i),
        ts: NOW - (10 - i) * 1_000,
        body: eventBody(i, rid(i), NOW - (10 - i) * 1_000, 'process.exec'),
      });
    }
    const gaps: Array<{ from: Cursor; to: Cursor }> = [];
    const shipper = new RelayShipper({
      deviceId: DEVICE_A,
      store: laptop,
      ...shipperOpts(rig, device.token),
      onGap: (note) => gaps.push({ from: note.from, to: note.to }),
    });
    shipper.start();
    addCleanup(() => shipper.stop());
    await waitFor('first five events to ship', () => rig.relay.store.stats().events === 5);
    shipper.stop();

    // A long outage against the retention cap: twenty records arrive —
    // newer than the cursor, so the cursor has not seen them — then pruning
    // drops the fifteen oldest: five already shipped, ten never read.
    for (let i = 5; i < 25; i++) {
      laptop.events.push({
        id: rid(i),
        ts: NOW + (i - 4) * 1_000,
        body: eventBody(i, rid(i), NOW + (i - 4) * 1_000, 'process.exec'),
      });
    }
    laptop.prune(15);
    const oldestBefore = (await laptop.oldestEvent()) as Cursor;

    shipper.start();
    await waitFor('the survivors to ship after the gap', () => {
      const stats = rig.relay.store.stats();
      return (
        stats.events === 15 &&
        shipper.status().state === 'running' &&
        shipper.status().lagRecords === 0
      );
    });

    expect(gaps).toHaveLength(1);
    // The cursor after e2e-000004 — NOW - 6_000 — and the oldest survivor.
    expect(gaps[0]?.from.ts).toBe(NOW - 6_000);
    expect(gaps[0]?.to.ts).toBe(oldestBefore.ts);
    // Lost records stay lost — the gap note is the record of them — and the
    // survivors arrived exactly once.
    const survivorIds = storedEventIds(dataDir, DEVICE_A);
    const lost = ['e2e-000005', 'e2e-000010', 'e2e-000014'];
    const kept = ['e2e-000000', 'e2e-000004', 'e2e-000015', 'e2e-000024'];
    for (const id of lost) {
      expect(survivorIds.has(id)).toBe(false); // the gap's cost, on the record
    }
    for (const id of kept) {
      expect(survivorIds.has(id)).toBe(true);
    }
    expect(survivorIds.size).toBe(15); // five shipped + ten survivors, exactly once
  }, 20_000);

  it('resumes with zero lost and zero duplicated records after the relay restarts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'vigil-relay-restart-'));
    addCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const rig1 = await startRelayRig(dataDir);
    addCleanup(() => rig1.close());
    const device = rig1.relay.store.provisionDevice(DEVICE_A, Date.now());

    const laptop = new SeededLaptopStore();
    laptop.events = seedEvents();
    laptop.snapshot = { id: 'e2e-000900', version: 1, body: snapshotBody('alert') };

    const shipper = new RelayShipper({
      deviceId: DEVICE_A,
      store: laptop,
      ...shipperOpts(rig1, device.token),
      batchMax: 30, // several batches, so the kill lands mid-stream
    });
    shipper.start();
    addCleanup(() => shipper.stop());
    await waitFor(
      'the first wave to land in batches',
      () => rig1.relay.store.stats().events === EVENT_COUNT,
    );
    shipper.stop();

    // More telemetry while the relay is up, then kill it as the second wave
    // is mid-stream.
    const wave2: StoredEvent[] = [];
    for (let i = EVENT_COUNT; i < EVENT_COUNT + 120; i++) {
      const ts = NOW + i;
      wave2.push({ id: rid(i), ts, body: eventBody(i, rid(i), ts, 'process.exec') });
    }
    laptop.events.push(...wave2);
    laptop.snapshot = { id: 'e2e-000900', version: 2, body: snapshotBody('block') };

    shipper.start();
    await waitFor(
      'the second wave to begin landing',
      () => rig1.relay.store.stats().events > EVENT_COUNT,
    );
    await rig1.close(); // the relay dies mid-stream

    // The relay comes back on the same address; durable state survives.
    const rig2 = await startRelayRig(dataDir, rig1.ingestPort);
    addCleanup(() => rig2.close());

    await waitFor('every record to land after the restart', () => {
      const stats = rig2.relay.store.stats();
      return (
        stats.events === EVENT_COUNT + 120 && stats.rules === 1 && shipper.status().lagRecords === 0
      );
    });

    expect(shipper.status().halted).toBeUndefined();

    // Every laptop event is on the relay exactly once: no loss, no
    // duplicates. The shipper ships everything it can read — the 8-day-old
    // record included; the 7-day window is the SOC readback's, not the
    // shipper's.
    const seenIds = storedEventIds(dataDir, DEVICE_A);
    const laptopIds = laptop.events.map((e) => e.id);
    expect(seenIds.size).toBe(laptopIds.length);
    expect([...seenIds].sort()).toEqual([...new Set(laptopIds)].sort());

    // The snapshot that rode along after the restart is the live one.
    expect(storedSnapshotMode(dataDir, DEVICE_A)).toBe('block');
  }, 20_000);

  // The SOC-readback half — the same telemetry read back through the MCP
  // face with an SDK client (device scoping, caps, redaction on the way
  // out) — activates when the MCP-server module lands on the release
  // branch. It replaces the staged placeholder below.
  describe('relay e2e: SOC readback over MCP (staged)', () => {
    it.skip('activates when the MCP-server module merges', () => {});
  });
});
