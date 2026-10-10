import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { segmentKey, SpoolUploader } from './uploader';
import type { ClosedSegment } from './spool';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vigil-uploader-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const config = {
  s3Endpoint: 'https://s3.example.com',
  s3Region: 'us-east-1',
  s3Bucket: 'vigil-flows',
  s3Prefix: 'flows',
  s3AccessKey: 'AKIDEXAMPLE',
  s3SecretKey: 'secretsecretsecret',
};

const baseSegment: ClosedSegment = {
  source: 'netflow',
  startedAtMs: Date.UTC(2026, 9, 9, 14, 0, 0),
  seq: 1,
  gzipPath: '',
  byteLength: 0,
};

function segmentOnDisk(
  overrides: Partial<ClosedSegment> = {},
  content = '{"schema":"vigil.flow.v1"}\n',
): ClosedSegment {
  const segment = { ...baseSegment, ...overrides };
  const path = join(dir, `seg-${segment.startedAtMs}-${segment.seq}.ndjson.gz`);
  const body = gzipSync(Buffer.from(content, 'utf8'));
  writeFileSync(path, body);
  return { ...segment, gzipPath: path, byteLength: body.length };
}

/** Waits for real fs/network I/O to settle the pump without busy-looping. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface PutRequest {
  url: string;
  init: RequestInit;
}

function putStub(responses: Array<number | Error>): {
  puts: PutRequest[];
  put: (url: string, init: RequestInit) => Promise<Response>;
} {
  const puts: PutRequest[] = [];
  const queue = [...responses];
  return {
    puts,
    put: async (url, init) => {
      puts.push({ url, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return new Response(null, { status: next ?? 200 });
    },
  };
}

function makeUploader(
  overrides: Partial<ConstructorParameters<typeof SpoolUploader>[0]> = {},
  responses: Array<number | Error> = [200],
): { uploader: SpoolUploader; puts: PutRequest[]; delays: number[]; logs: string[] } {
  const stub = putStub(responses);
  const delays: number[] = [];
  const logs: string[] = [];
  const uploader = new SpoolUploader({
    config,
    putObject: stub.put,
    baseDelayMs: 10,
    maxDelayMs: 100,
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  });
  return { uploader, puts: stub.puts, delays, logs };
}

describe('segmentKey', () => {
  it('builds the spec key with UTC hour partitions and no padding', () => {
    // 2026-01-05T03:04:05Z — single-digit month, day and hour all zero-padded.
    const key = segmentKey('flows', {
      ...baseSegment,
      startedAtMs: Date.UTC(2026, 0, 5, 3, 4, 5),
      seq: 7,
    });
    expect(key).toBe(
      'flows/netflow/2026/01/05/03/seg-' + Date.UTC(2026, 0, 5, 3, 4, 5) + '-7.ndjson.gz',
    );
  });

  it('sorts by time through the prefix and source separators', () => {
    const early = segmentKey('flows', { ...baseSegment, startedAtMs: Date.UTC(2026, 0, 1) });
    const late = segmentKey('flows', { ...baseSegment, startedAtMs: Date.UTC(2026, 0, 2) });
    expect(early < late).toBe(true);
  });
});

describe('SpoolUploader', () => {
  it('PUTs the path-style URL with the spec headers and deletes the segment after 2xx', async () => {
    const segment = segmentOnDisk();
    const { uploader, puts } = makeUploader();
    uploader.enqueue(segment);
    await uploader.idle();

    expect(puts).toHaveLength(1);
    const request = puts[0]!;
    expect(request.url).toBe(
      'https://s3.example.com/vigil-flows/flows/netflow/2026/10/09/14/seg-' +
        baseSegment.startedAtMs +
        '-1.ndjson.gz',
    );
    expect(request.init.method).toBe('PUT');
    expect(request.init.headers).toMatchObject({
      'content-type': 'application/x-ndjson',
      'content-encoding': 'gzip',
    });
    expect(existsSync(segment.gzipPath)).toBe(false);
  });

  it('retries 5xx with exponential backoff and jitter, then deletes after 2xx', async () => {
    const segment = segmentOnDisk();
    const { uploader, puts, delays } = makeUploader({}, [503, 503, 200]);
    uploader.enqueue(segment);
    await uploader.idle();

    expect(puts).toHaveLength(3);
    // baseDelayMs 10, random()=0.5: full jitter gives 5 then 10; the 200
    // attempt sleeps no more.
    expect(delays).toEqual([5, 10]);
    expect(existsSync(segment.gzipPath)).toBe(false);
  });

  it('retries 429 and network errors like 5xx', async () => {
    const segment = segmentOnDisk();
    const { uploader, puts } = makeUploader({}, [429, new Error('socket hang up'), 204]);
    uploader.enqueue(segment);
    await uploader.idle();

    expect(puts).toHaveLength(3);
    expect(existsSync(segment.gzipPath)).toBe(false);
  });

  it('parks the segment on disk on a terminal 4xx and moves on', async () => {
    const segment = segmentOnDisk();
    const { uploader, puts, logs } = makeUploader({}, [403]);
    uploader.enqueue(segment);
    await uploader.idle();

    expect(puts).toHaveLength(1);
    expect(existsSync(segment.gzipPath)).toBe(true);
    expect(logs.some((entry) => entry.startsWith('ERROR:') && entry.includes('403'))).toBe(true);
  });

  it('drops a segment that vanished from the spool without attempting a PUT', async () => {
    const missing = { ...baseSegment, gzipPath: join(dir, 'seg-gone.ndjson.gz'), byteLength: 1 };
    const { uploader, puts, logs } = makeUploader();
    uploader.enqueue(missing);
    await uploader.idle();

    expect(puts).toHaveLength(0);
    expect(logs.some((entry) => entry.includes('vanished'))).toBe(true);
  });

  it('uploads queued segments FIFO', async () => {
    const first = segmentOnDisk({ seq: 1 }, 'first\n');
    const second = segmentOnDisk({ seq: 2 }, 'second\n');
    const { uploader, puts } = makeUploader();
    uploader.enqueue(first);
    uploader.enqueue(second);
    await uploader.idle();

    expect(puts[0]?.url).toBe(uploader.urlFor(first));
    expect(puts[1]?.url).toBe(uploader.urlFor(second));
    expect(puts[0]?.url.endsWith('-1.ndjson.gz')).toBe(true);
    expect(puts[1]?.url.endsWith('-2.ndjson.gz')).toBe(true);
  });

  it('stops retrying when stopped during backoff and leaves the segment on disk', async () => {
    const segment = segmentOnDisk();
    const pendingSleeps: Array<(value: void) => void> = [];
    const { uploader, puts } = makeUploader(
      {
        sleep: (ms) =>
          new Promise((resolve) => {
            pendingSleeps.push(resolve);
            void ms;
          }),
      },
      [503, 503, 503],
    );

    uploader.enqueue(segment);
    await until(() => puts.length === 1); // first attempt failed; now inside backoff

    const stopped = uploader.stop();
    for (const resolve of pendingSleeps.splice(0)) resolve();
    await stopped;
    await until(() => pendingSleeps.length === 0);

    expect(puts).toHaveLength(1); // never retried after stop
    expect(existsSync(segment.gzipPath)).toBe(true); // at-least-once: still on disk
  });

  it('scans the spool directory and enqueues closed gz segments oldest-first', async () => {
    const uploader = new SpoolUploader({
      config,
      putObject: async () => new Response(null, { status: 200 }),
    });
    const netflowDir = join(dir, 'netflow');
    const osqueryDir = join(dir, 'osquery');
    mkdirSync(netflowDir, { recursive: true });
    mkdirSync(osqueryDir, { recursive: true });
    writeFileSync(join(netflowDir, 'seg-1789000000000-000001.ndjson.gz'), gzipSync('older'));
    writeFileSync(join(netflowDir, 'seg-1789000001000-000002.ndjson.gz'), gzipSync('newer'));
    writeFileSync(join(netflowDir, 'seg-1789000002000-000003.ndjson'), 'open, not gz');
    writeFileSync(join(netflowDir, 'not-a-segment.txt'), 'junk');
    writeFileSync(join(osqueryDir, 'seg-1788999000000-000009.ndjson.gz'), gzipSync('oldest'));

    const enqueued = await uploader.scanAndEnqueue(dir);
    await uploader.idle();

    expect(enqueued).toBe(3);
    expect(existsSync(join(netflowDir, 'seg-1789000000000-000001.ndjson.gz'))).toBe(false);
    expect(existsSync(join(netflowDir, 'seg-1789000001000-000002.ndjson.gz'))).toBe(false);
    expect(existsSync(join(osqueryDir, 'seg-1788999000000-000009.ndjson.gz'))).toBe(false);
    // The raw open file and junk are untouched.
    expect(existsSync(join(netflowDir, 'seg-1789000002000-000003.ndjson'))).toBe(true);
    expect(existsSync(join(netflowDir, 'not-a-segment.txt'))).toBe(true);
  });

  it('ignores enqueue after stop, keeping the segment on disk', async () => {
    const segment = segmentOnDisk();
    const { uploader, puts, logs } = makeUploader();
    await uploader.stop();
    uploader.enqueue(segment);
    await uploader.idle();

    expect(puts).toHaveLength(0);
    expect(logs.some((entry) => entry.includes('stays on disk'))).toBe(true);
    expect(existsSync(segment.gzipPath)).toBe(true);
  });
});
