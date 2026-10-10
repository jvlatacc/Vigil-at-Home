import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { AwsClient } from 'aws4fetch';
import { parseSegmentName, type ClosedSegment } from './spool';
import { RateLimiter } from './rateLimit';

/** The VIGIL_S3_* slice of the appliance config the uploader needs. */
export interface UploaderConfig {
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3Prefix: string;
  s3AccessKey: string;
  s3SecretKey: string;
}

export interface SpoolUploaderOptions {
  config: UploaderConfig;
  /**
   * The PUT itself — defaults to aws4fetch SigV4 against the endpoint.
   * Injectable so retry tests run without sockets or signing.
   */
  putObject?: (url: string, init: RequestInit) => Promise<Response>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full-jitter source; injectable for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'ERROR' | 'WARN', message: string) => void;
  /** Per-attempt timeout; each timed-out attempt is retryable. */
  requestTimeoutMs?: number;
}

/**
 * Deterministic, sortable, retry-idempotent S3 key for a closed segment:
 * `<prefix>/<source>/YYYY/MM/DD/HH/seg-<startMs>-<seq>.ndjson.gz` in UTC.
 * Re-uploading the same segment overwrites the same key, so retries can
 * never duplicate objects.
 */
export function segmentKey(prefix: string, segment: ClosedSegment): string {
  const t = new Date(segment.startedAtMs);
  const parts = [
    String(t.getUTCFullYear()),
    String(t.getUTCMonth() + 1).padStart(2, '0'),
    String(t.getUTCDate()).padStart(2, '0'),
    String(t.getUTCHours()).padStart(2, '0'),
  ];
  return `${prefix}/${segment.source}/${parts.join('/')}/seg-${segment.startedAtMs}-${segment.seq}.ndjson.gz`;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function isNoSuchFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Uploads closed spool segments to any path-style S3-compatible endpoint with
 * SigV4 (aws4fetch). At-least-once: the spool file is unlinked only after a
 * 2xx; 5xx/429/timeouts retry with exponential backoff and full jitter;
 * other 4xx park the segment on disk (it re-enters via the next boot's
 * rescan). Boot-time `scanAndEnqueue` drains the on-disk backlog oldest-first.
 */
export class SpoolUploader {
  private readonly s3: AwsClient;
  private readonly config: UploaderConfig;
  private readonly put: (url: string, init: RequestInit) => Promise<Response>;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (level: 'ERROR' | 'WARN', message: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly queue: ClosedSegment[] = [];
  private readonly parkLimiter = new RateLimiter(5, 60_000);
  private pumpPromise: Promise<void> | null = null;
  private running = false;
  private stopped = false;

  constructor(options: SpoolUploaderOptions) {
    this.config = options.config;
    this.s3 = new AwsClient({
      accessKeyId: options.config.s3AccessKey,
      secretAccessKey: options.config.s3SecretKey,
      service: 's3',
      region: options.config.s3Region,
    });
    this.put = options.putObject ?? ((url, init) => this.s3.fetch(url, init));
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  /** Object URL for one segment — path-style: endpoint/bucket/key. */
  urlFor(segment: ClosedSegment): string {
    const endpoint = this.config.s3Endpoint.replace(/\/+$/, '');
    return `${endpoint}/${this.config.s3Bucket}/${segmentKey(this.config.s3Prefix, segment)}`;
  }

  /**
   * Queues a closed segment for upload. Never throws: after shutdown a
   * segment simply stays on disk for the next boot's rescan.
   */
  enqueue(segment: ClosedSegment): void {
    if (this.stopped) {
      if (this.parkLimiter.admit()) this.log('WARN', 'enqueue after stop; segment stays on disk');
      return;
    }
    this.queue.push(segment);
    this.pump();
  }

  /**
   * Boot-time rescan: enqueues every closed (.gz) segment on disk, oldest
   * first. Stale open segments are not candidates — the spool writer's init
   * gzips them first, then the caller rescans.
   */
  async scanAndEnqueue(rootDir: string): Promise<number> {
    const found: ClosedSegment[] = [];
    for (const source of ['netflow', 'osquery'] as const) {
      const dir = `${rootDir}/${source}`;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const parsed = parseSegmentName(entry);
        if (!parsed || !parsed.gzipped) continue;
        const gzipPath = `${dir}/${entry}`;
        try {
          found.push({
            source,
            startedAtMs: parsed.startMs,
            seq: parsed.seq,
            gzipPath,
            byteLength: (await stat(gzipPath)).size,
          });
        } catch {
          // Vanished between readdir and stat — nothing to enqueue.
        }
      }
    }
    found.sort((a, b) => a.startedAtMs - b.startedAtMs || a.seq - b.seq);
    for (const segment of found) this.enqueue(segment);
    return found.length;
  }

  /** Resolves once the queue is drained (or the uploader stopped). */
  async idle(): Promise<void> {
    while (!this.stopped && (this.running || this.queue.length > 0)) {
      await (this.pumpPromise ?? Promise.resolve());
    }
  }

  /** Finishes the in-flight attempt and stops uploading; queued segments stay on disk. */
  async stop(): Promise<void> {
    this.stopped = true;
    await (this.pumpPromise ?? Promise.resolve());
  }

  private pump(): Promise<void> {
    if (this.running) return this.pumpPromise ?? Promise.resolve();
    this.running = true;
    this.pumpPromise = this.pumpLoop().finally(() => {
      this.running = false;
      this.pumpPromise = null;
    });
    return this.pumpPromise;
  }

  private async pumpLoop(): Promise<void> {
    while (!this.stopped) {
      const segment = this.queue.shift();
      if (!segment) return;
      await this.uploadWithRetry(segment);
    }
  }

  private async uploadWithRetry(segment: ClosedSegment): Promise<void> {
    const url = this.urlFor(segment);
    for (let attempt = 1; ; attempt++) {
      try {
        const body = await readFile(segment.gzipPath);
        const response = await this.put(url, {
          method: 'PUT',
          body: new Uint8Array(body),
          headers: {
            'content-type': 'application/x-ndjson',
            'content-encoding': 'gzip',
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (response.ok) {
          try {
            await unlink(segment.gzipPath);
          } catch (err) {
            if (!isNoSuchFile(err) && this.parkLimiter.admit()) {
              this.log(
                'ERROR',
                `uploaded ${segment.gzipPath} but could not remove it: ${describe(err)}`,
              );
            }
          }
          return;
        }
        if (!isRetryableStatus(response.status)) {
          // Park on disk — a configuration error would retry forever otherwise.
          if (this.parkLimiter.admit()) {
            this.log(
              'ERROR',
              `PUT ${url} rejected with ${response.status}; segment parked on disk`,
            );
          }
          return;
        }
        if (this.parkLimiter.admit()) {
          this.log('WARN', `PUT ${url} failed with ${response.status}; will retry`);
        }
      } catch (err) {
        if (isNoSuchFile(err)) {
          // Dropped by the spool cap while queued — bounded loss, not an error.
          if (this.parkLimiter.admit())
            this.log('WARN', `segment ${segment.gzipPath} vanished; dropped`);
          return;
        }
        if (this.parkLimiter.admit()) {
          this.log('WARN', `PUT ${url} failed: ${describe(err)}; will retry`);
        }
      }
      if (this.stopped) return;
      await this.sleep(this.backoffDelay(attempt));
      if (this.stopped) return;
    }
  }

  /** Exponential backoff with full jitter, capped at maxDelayMs. */
  private backoffDelay(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.random() * exp);
  }
}
