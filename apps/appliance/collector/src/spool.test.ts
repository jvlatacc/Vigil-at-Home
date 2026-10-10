import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IngestRecord } from './record';
import { parseSegmentName, SpoolWriter, type ClosedSegment, type SpoolLogLevel } from './spool';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vigil-spool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const baseRecord: IngestRecord = {
  schema: 'vigil.flow.v1',
  source: 'netflow',
  receivedAt: '2026-10-09T12:00:00.000Z',
  exporter: { address: '192.168.1.1', version: 5, engineId: '7' },
  flow: {
    firstSwitchedMs: 1788999991500,
    lastSwitchedMs: 1788999995500,
    packets: 10,
    bytes: 1500,
    protocol: 6,
    srcAddress: '192.168.1.20',
    srcPort: 52000,
    dstAddress: '93.184.216.34',
    dstPort: 443,
    tcpFlags: 27,
    tos: 4,
  },
};

function record(overrides: Partial<IngestRecord> = {}): IngestRecord {
  return { ...baseRecord, ...overrides };
}

function osqueryRecord(receivedAt = baseRecord.receivedAt): IngestRecord {
  return record({
    source: 'osquery',
    receivedAt,
    flow: null,
    exporter: { address: '192.168.1.20', version: null, engineId: null },
  });
}

interface Harness {
  writer: SpoolWriter;
  segments: ClosedSegment[];
  logs: { level: SpoolLogLevel; message: string }[];
}

function makeWriter(
  overrides: Partial<ConstructorParameters<typeof SpoolWriter>[0]> = {},
): Harness {
  const segments: ClosedSegment[] = [];
  const logs: { level: SpoolLogLevel; message: string }[] = [];
  const writer = new SpoolWriter({
    rootDir: dir,
    maxSegmentBytes: 64 * 1024 * 1024,
    maxIntervalMs: 300_000,
    maxSpoolBytes: 2048 * 1024 * 1024,
    onSegmentClosed: (segment) => segments.push(segment),
    log: (level, message) => logs.push({ level, message }),
    ...overrides,
  });
  return { writer, segments, logs };
}

function rawFiles(source: string): string[] {
  const entries = existsSync(join(dir, source)) ? readdirSync(join(dir, source)) : [];
  return entries.filter((name) => name.endsWith('.ndjson'));
}

function gzFiles(source: string): string[] {
  const entries = existsSync(join(dir, source)) ? readdirSync(join(dir, source)) : [];
  return entries.filter((name) => name.endsWith('.ndjson.gz'));
}

function recordsIn(gzipPath: string): IngestRecord[] {
  const text = gunzipSync(readFileSync(gzipPath)).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IngestRecord);
}

describe('SpoolWriter', () => {
  it('appends records as JSONL per source and round-trips them', async () => {
    const { writer } = makeWriter();
    await writer.init();
    writer.append(baseRecord);
    writer.append(osqueryRecord());

    const netflowRaw = join(dir, 'netflow', rawFiles('netflow')[0] ?? '');
    const parsed = readFileSync(netflowRaw, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as IngestRecord);
    expect(parsed).toEqual([baseRecord]);
    expect(rawFiles('osquery')).toHaveLength(1);
    expect(gzFiles('netflow')).toHaveLength(0);
  });

  it('never hands over the open segment; close() flushes it', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    writer.append(record({ receivedAt: '2026-10-09T12:00:00.000Z' }));
    writer.append(record({ receivedAt: '2026-10-09T12:00:01.000Z' }));
    await writer.drain();
    expect(segments).toEqual([]);
    expect(gzFiles('netflow')).toHaveLength(0);
    expect(rawFiles('netflow')).toHaveLength(1);

    await writer.close();
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startedAtMs).toBe(Date.parse('2026-10-09T12:00:00.000Z'));
    expect(rawFiles('netflow')).toHaveLength(0);
    expect(gzFiles('netflow')).toHaveLength(1);
  });

  it('rotates on the UTC hour boundary mid-burst', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    writer.append(record({ receivedAt: '2026-10-09T12:59:59.500Z' }));
    writer.append(record({ receivedAt: '2026-10-09T13:00:00.500Z' }));
    await writer.close();

    expect(segments).toHaveLength(2);
    expect(segments[0]?.startedAtMs).toBe(Date.parse('2026-10-09T12:59:59.500Z'));
    expect(segments[1]?.startedAtMs).toBe(Date.parse('2026-10-09T13:00:00.500Z'));
    // The second record landed in the 13:00 segment, not the 12:xx one.
    const first = recordsIn(segments[0]!.gzipPath);
    expect(first).toHaveLength(1);
    expect(first[0]?.receivedAt).toBe('2026-10-09T12:59:59.500Z');
  });

  it('rotates when the size cap would be exceeded', async () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(baseRecord)}\n`, 'utf8');
    const { writer, segments } = makeWriter({ maxSegmentBytes: lineBytes + 1 });
    await writer.init();
    writer.append(record());
    writer.append(record());
    writer.append(record());
    await writer.close();

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(recordsIn(segment.gzipPath)).toHaveLength(1);
    }
  });

  it('force-closes a segment once the upload interval elapses', async () => {
    const { writer, segments } = makeWriter({ maxIntervalMs: 1000 });
    await writer.init();
    const t0 = Date.parse('2026-10-09T12:00:00.000Z');
    writer.append(record({ receivedAt: '2026-10-09T12:00:00.000Z' }));

    await writer.tick(t0 + 999);
    expect(segments).toHaveLength(0);

    await writer.tick(t0 + 1000);
    expect(segments).toHaveLength(1);
  });

  it('closes on the hour boundary from the tick while ingestion is idle', async () => {
    const { writer, segments } = makeWriter({ maxIntervalMs: Number.MAX_SAFE_INTEGER });
    await writer.init();
    writer.append(record({ receivedAt: '2026-10-09T12:59:00.000Z' }));
    await writer.tick(Date.parse('2026-10-09T13:01:00.000Z'));
    expect(segments).toHaveLength(1);
    expect(rawFiles('netflow')).toHaveLength(0);
  });

  it('creates nothing and logs nothing when ticking an idle spool', async () => {
    const { writer, segments, logs } = makeWriter();
    await writer.init();
    await writer.tick(Date.now());
    expect(segments).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  it('closed segments gunzip back to the appended records', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    const one = record({ receivedAt: '2026-10-09T12:00:00.000Z' });
    const two = record({ receivedAt: '2026-10-09T12:00:01.000Z' });
    writer.append(one);
    writer.append(two);
    await writer.close();

    expect(recordsIn(segments[0]!.gzipPath)).toEqual([one, two]);
    expect(segments[0]!.byteLength).toBeGreaterThan(0);
  });

  it('separates sources into their own directories and segments', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    writer.append(record({ receivedAt: '2026-10-09T12:00:00.000Z' }));
    writer.append(osqueryRecord('2026-10-09T12:00:01.000Z'));
    await writer.close();

    // onSegmentClosed fires as each concurrent gzip promise settles, so the
    // callback order is not deterministic (differs on APFS). Assert per-source
    // structure, not completion order.
    expect(segments.map((segment) => segment.source).sort()).toEqual(['netflow', 'osquery']);
    expect(rawFiles('netflow')).toHaveLength(0);
    expect(rawFiles('osquery')).toHaveLength(0);
    expect(gzFiles('netflow')).toHaveLength(1);
    expect(gzFiles('osquery')).toHaveLength(1);
  });

  it('recovers raw segment files left open by a crash without notifying the sink', async () => {
    const stalePath = join(dir, 'netflow', 'seg-1788999991500-000003.ndjson');
    mkdirSync(join(dir, 'netflow'), { recursive: true });
    writeFileSync(stalePath, `${JSON.stringify(baseRecord)}\n`);

    const { writer, segments } = makeWriter();
    await writer.init();

    expect(existsSync(stalePath)).toBe(false);
    expect(gzFiles('netflow')).toEqual(['seg-1788999991500-000003.ndjson.gz']);
    expect(segments).toEqual([]); // backlog enqueue belongs to the uploader's boot rescan
  });

  it('continues sequence numbers above segments found on disk', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    writer.append(record({ receivedAt: '2026-10-09T12:00:00.000Z' }));
    await writer.close();
    const firstSeq = segments[0]!.seq;

    const second = makeWriter();
    await second.writer.init();
    second.writer.append(record({ receivedAt: '2026-10-09T12:05:00.000Z' }));
    await second.writer.close();

    expect(second.segments[0]!.seq).toBeGreaterThan(firstSeq);
    expect(parseSegmentName(second.segments[0]!.gzipPath.split('/').pop() ?? '')).toEqual({
      startMs: Date.parse('2026-10-09T12:05:00.000Z'),
      seq: second.segments[0]!.seq,
      gzipped: true,
    });
  });

  it('drops the oldest closed segments beyond the spool cap with one ERROR', async () => {
    // Writer A fills the spool with two closed segments under a huge cap.
    const filler = makeWriter();
    await filler.writer.init();
    for (let i = 0; i < 2; i++) {
      filler.writer.append(record({ receivedAt: `2026-10-09T12:0${i}:00.000Z` }));
      await filler.writer.tick(Date.parse('2026-10-09T12:10:00.000Z') + i);
    }
    expect(filler.segments).toHaveLength(2);
    const [oldest, newest] = filler.segments;
    // Cap one byte under the combined total: exactly the oldest must go.
    const cap = oldest!.byteLength + newest!.byteLength - 1;

    const { writer, logs } = makeWriter({ maxSpoolBytes: cap });
    writer.append(record({ receivedAt: '2026-10-09T12:11:00.000Z' }));
    const openBefore = rawFiles('netflow');
    expect(openBefore).toHaveLength(1);

    await writer.tick(Date.parse('2026-10-09T12:12:00.000Z'));

    expect(logs.filter((entry) => entry.level === 'ERROR')).toHaveLength(1);
    expect(logs[0]?.message).toMatch(/dropped 1 oldest segment/);
    expect(existsSync(oldest!.gzipPath)).toBe(false);
    expect(existsSync(newest!.gzipPath)).toBe(true);
    // The open file survived the sweep.
    expect(rawFiles('netflow')).toEqual(openBefore);
    // Ingestion continues after the sweep.
    writer.append(record({ receivedAt: '2026-10-09T12:13:00.000Z' }));
    expect(rawFiles('netflow')).toEqual(openBefore);
  });

  it('keeps working when recovery of a poisoned segment fails', async () => {
    // A directory where a segment file belongs: gzip recovery cannot read it.
    mkdirSync(join(dir, 'osquery'), { recursive: true });
    mkdirSync(join(dir, 'osquery', 'seg-1788999991500-000000.ndjson'));

    const { writer, segments, logs } = makeWriter();
    await writer.init();
    expect(logs.some((entry) => entry.level === 'ERROR')).toBe(true);

    // Ingestion is unharmed: new segments open above the poisoned sequence.
    writer.append(osqueryRecord());
    await writer.close();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.seq).toBe(1);
    expect(segments[0]!.source).toBe('osquery');
  });

  it('falls back to the wall clock for records with an unparseable receivedAt', async () => {
    const { writer, segments } = makeWriter();
    await writer.init();
    writer.append(record({ receivedAt: 'not-a-timestamp' }));
    await writer.close();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.startedAtMs).toBeGreaterThan(0);
  });
});
