import { createReadStream, createWriteStream } from 'node:fs';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { IngestRecord } from './record';
import { RateLimiter } from './rateLimit';

/**
 * The production spool root. Tests inject their own directory; the public
 * VIGIL_* configuration contract deliberately has no override for this —
 * the path is part of the image, not operator configuration.
 */
export const SPOOL_ROOT = '/var/lib/vigil-appliance/spool';

/** Fixed layout constants: hourly partitions keyed by segment start time. */
const MS_PER_HOUR = 3_600_000;
const START_MS_DIGITS = 13;
const SEQ_DIGITS = 6;

/** `seg-<startMs>-<seq>.ndjson` while open, plus `.gz` once closed. */
const SEGMENT_NAME = /^seg-(\d{13,})-(\d{6,})\.ndjson(\.gz)?$/;

/** A closed, gzipped segment ready for upload. The open file never wears this. */
export interface ClosedSegment {
  source: IngestRecord['source'];
  /** Received-at time of the segment's first record — authoritative for keys. */
  startedAtMs: number;
  /** Per-source, monotonically increasing; continues above files found on boot. */
  seq: number;
  gzipPath: string;
  byteLength: number;
}

export type SpoolLogLevel = 'ERROR' | 'WARN';

export interface SpoolWriterOptions {
  /** Root directory; tests inject a temp dir, production uses SPOOL_ROOT. */
  rootDir: string;
  /** Close the open segment once its raw JSONL size would exceed this. */
  maxSegmentBytes: number;
  /** Force-close a segment this long after it opened, even if idle since. */
  maxIntervalMs: number;
  /** Drop the oldest closed segments beyond this total, logging one ERROR. */
  maxSpoolBytes: number;
  /** Receives every closed segment — the upload queue's enqueue hook. */
  onSegmentClosed?: (segment: ClosedSegment) => void;
  log?: (level: SpoolLogLevel, message: string) => void;
}

interface OpenSegment {
  fd: number | null;
  rawPath: string;
  startMs: number;
  seq: number;
  bytes: number;
}

export function parseSegmentName(
  name: string,
): { startMs: number; seq: number; gzipped: boolean } | null {
  const match = SEGMENT_NAME.exec(name);
  if (!match) return null;
  return { startMs: Number(match[1]), seq: Number(match[2]), gzipped: match[3] === '.gz' };
}

function hourIndex(ms: number): number {
  return Math.floor(ms / MS_PER_HOUR);
}

/**
 * Per-source JSONL spool: appends normalized records, rotates on the UTC hour
 * boundary, on the size cap, and on the upload interval; gzips closed segments
 * and hands them to `onSegmentClosed`. The open file is never handed over —
 * only closed, gzipped segments enter the upload queue.
 *
 * Appends are synchronous (ordered, no interleaving); gzip runs async and is
 * awaited by `drain`/`close`. Crash recovery: raw segment files found by
 * `init()` are gzipped into the backlog by the uploader's boot rescan.
 */
export class SpoolWriter {
  private readonly openSegments = new Map<IngestRecord['source'], OpenSegment>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly nextSeq: Record<IngestRecord['source'], number> = {
    netflow: 0,
    osquery: 0,
  };
  private readonly log: (level: SpoolLogLevel, message: string) => void;
  private readonly limiter = new RateLimiter(5, 60_000);
  private closed = false;

  constructor(private readonly options: SpoolWriterOptions) {
    this.log = options.log ?? (() => {});
  }

  /**
   * Creates the directory layout, gzips raw segment files left open by a
   * crash (they enter the backlog via the uploader's boot rescan), and seeds
   * sequence counters above every segment already on disk so new names never
   * collide with old objects.
   */
  async init(): Promise<void> {
    for (const source of ['netflow', 'osquery'] as const) {
      const dir = this.sourceDir(source);
      mkdirSync(dir, { recursive: true });
      let maxSeq = -1;
      for (const entry of readdirSync(dir)) {
        const parsed = parseSegmentName(entry);
        if (parsed) maxSeq = Math.max(maxSeq, parsed.seq);
        if (parsed && !parsed.gzipped) {
          // Stale open segment from a crash: close it into the backlog.
          const rawPath = `${dir}/${entry}`;
          this.track(this.finalizeSegment(source, parsed, rawPath, { enqueue: false }));
        }
      }
      this.nextSeq[source] = maxSeq + 1;
    }
    await this.drain();
    await this.enforceSpoolCap();
  }

  /**
   * Appends one record. Rotation triggers (hour boundary, size cap) are
   * checked before the write so bursts rotate mid-burst. Never throws for
   * routine problems — a lost write is counted and logged, not fatal.
   */
  append(record: IngestRecord): void {
    if (this.closed) {
      if (this.limiter.admit()) this.log('WARN', 'append after close; record dropped');
      return;
    }
    const receivedMs = orNow(Date.parse(record.receivedAt));
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let segment = this.openSegments.get(record.source);
    if (!segment) {
      segment = this.openSegment(record.source, receivedMs);
    } else if (hourIndex(receivedMs) !== hourIndex(segment.startMs)) {
      this.rotate(record.source, segment);
      segment = this.openSegment(record.source, receivedMs);
    } else if (segment.bytes + line.length > this.options.maxSegmentBytes) {
      this.rotate(record.source, segment);
      segment = this.openSegment(record.source, receivedMs);
    }
    this.writeLine(segment, line);
  }

  /**
   * Periodic driver for idle-time rotation: hour boundaries and the upload
   * interval must close segments even when nothing arrives. Resolves when
   * any triggered rotations (and the cap sweep) have settled.
   */
  async tick(nowMs: number): Promise<void> {
    if (this.closed) return;
    for (const source of ['netflow', 'osquery'] as const) {
      const segment = this.openSegments.get(source);
      if (!segment) continue;
      if (
        hourIndex(nowMs) !== hourIndex(segment.startMs) ||
        nowMs - segment.startMs >= this.options.maxIntervalMs
      ) {
        this.rotate(source, segment);
      }
    }
    await this.drain();
    await this.enforceSpoolCap();
  }

  /** Flushes every open segment (closed and gzipped) and settles all work. */
  async close(): Promise<void> {
    this.closed = true;
    for (const [source, segment] of this.openSegments) {
      this.rotate(source, segment);
    }
    await this.drain();
  }

  /** Awaits all in-flight gzip/upload-handoff work. */
  async drain(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private sourceDir(source: IngestRecord['source']): string {
    return `${this.options.rootDir}/${source}`;
  }

  private segmentPath(source: IngestRecord['source'], startMs: number, seq: number): string {
    const stem = `${String(startMs).padStart(START_MS_DIGITS, '0')}-${String(seq).padStart(SEQ_DIGITS, '0')}`;
    return `${this.sourceDir(source)}/seg-${stem}.ndjson`;
  }

  private openSegment(source: IngestRecord['source'], startMs: number): OpenSegment {
    const seq = this.nextSeq[source]++;
    const rawPath = this.segmentPath(source, startMs, seq);
    mkdirSync(this.sourceDir(source), { recursive: true });
    const fd = openSync(rawPath, 'a');
    const segment: OpenSegment = { fd, rawPath, startMs, seq, bytes: 0 };
    this.openSegments.set(source, segment);
    return segment;
  }

  private writeLine(segment: OpenSegment, line: Buffer): void {
    if (segment.fd === null) throw new Error('write to a closed spool segment');
    writeSync(segment.fd, line);
    segment.bytes += line.length;
  }

  /**
   * Closes the segment's fd synchronously and gzips it asynchronously. The
   * next append to this source reopens immediately — gzip never blocks
   * ingestion.
   */
  private rotate(source: IngestRecord['source'], segment: OpenSegment): void {
    this.openSegments.delete(source);
    if (segment.fd !== null) {
      fsyncSync(segment.fd);
      closeSync(segment.fd);
      segment.fd = null;
    }
    this.track(
      this.finalizeSegment(
        source,
        { startMs: segment.startMs, seq: segment.seq },
        segment.rawPath,
        { enqueue: true },
      ),
    );
  }

  private async finalizeSegment(
    source: IngestRecord['source'],
    parsed: { startMs: number; seq: number },
    rawPath: string,
    { enqueue }: { enqueue: boolean },
  ): Promise<void> {
    const gzipPath = `${rawPath}.gz`;
    try {
      await gzipFile(rawPath, gzipPath);
      unlinkUnchecked(rawPath);
      const byteLength = statSync(gzipPath).size;
      if (enqueue) {
        this.options.onSegmentClosed?.({
          source,
          startedAtMs: parsed.startMs,
          seq: parsed.seq,
          gzipPath,
          byteLength,
        });
      }
    } catch (err) {
      // The raw file stays on disk — boot-time recovery retries the gzip.
      if (this.limiter.admit()) {
        this.log('ERROR', `failed to finalize spool segment ${rawPath}: ${describe(err)}`);
      }
    }
    await this.enforceSpoolCap();
  }

  /**
   * Bounded-loss policy: when closed segments exceed the spool cap, delete
   * the oldest until under the cap. One ERROR per sweep; the open files are
   * never candidates. Ingestion continues regardless.
   */
  private async enforceSpoolCap(): Promise<void> {
    const openPaths = new Set<string>();
    for (const segment of this.openSegments.values()) openPaths.add(segment.rawPath);

    const candidates: { path: string; size: number }[] = [];
    let total = 0;
    for (const source of ['netflow', 'osquery'] as const) {
      let entries: string[];
      try {
        entries = readdirSync(this.sourceDir(source));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const parsed = parseSegmentName(entry);
        if (!parsed) continue;
        const path = `${this.sourceDir(source)}/${entry}`;
        if (openPaths.has(path)) continue;
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          continue;
        }
        candidates.push({ path, size });
        total += size;
      }
    }
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    let dropped = 0;
    for (const candidate of candidates) {
      if (total <= this.options.maxSpoolBytes) break;
      try {
        unlinkSync(candidate.path);
        total -= candidate.size;
        dropped += 1;
      } catch {
        // Already gone (concurrent sweep) — treat as dropped.
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.log(
        'ERROR',
        `spool exceeded ${this.options.maxSpoolBytes} bytes; dropped ${dropped} oldest segment(s) — ingestion continues`,
      );
    }
  }
}

function orNow(ms: number): number {
  return Number.isFinite(ms) ? ms : Date.now();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unlinkUnchecked(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to recover: the raw file is gone either way.
  }
}

async function gzipFile(sourcePath: string, gzipPath: string): Promise<void> {
  await pipeline(createReadStream(sourcePath), createGzip(), createWriteStream(gzipPath));
}

/** Test helper: reads a raw spool file back into records. */
export function readSpoolLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
