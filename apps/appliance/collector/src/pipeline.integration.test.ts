import * as http from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IngestRecord } from './record';
import { SpoolWriter } from './spool';
import { SpoolUploader } from './uploader';

// Hermetic by construction — a loopback HTTP server and tmp dirs, no system
// state touched — so it runs under plain `pnpm check` without the integration
// gate the repo reserves for system-mutating tests.

interface StubRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** existsSync(watchPath) sampled while the request was being served. */
  watchedFileExisted: boolean | null;
}

const NETFLOW_RECORD = IngestRecord.parse({
  schema: 'vigil.flow.v1',
  source: 'netflow',
  receivedAt: '2026-10-09T12:00:00.000Z',
  exporter: { address: '192.168.1.1', version: 5, engineId: '0' },
  flow: {
    firstSwitchedMs: 0,
    lastSwitchedMs: 120_000,
    packets: 12,
    bytes: 1_024,
    protocol: 6,
    srcAddress: '192.168.1.20',
    srcPort: 52_000,
    dstAddress: '93.184.216.34',
    dstPort: 443,
    tcpFlags: 27,
    tos: 0,
  },
});

function uploaderConfig(endpoint: string) {
  return {
    s3Endpoint: endpoint,
    s3Region: 'us-east-1',
    s3Bucket: 'vigil-flows',
    s3Prefix: 'flows',
    s3AccessKey: 'AKIDEXAMPLE',
    s3SecretKey: 'secretsecretsecret',
  };
}

/** Scripted S3 stub: responses from the script, 200 when exhausted. */
function startS3Stub(): Promise<{
  port: number;
  requests: StubRequest[];
  setScript: (statuses: number[]) => void;
  /** Path the stub samples with existsSync on every request. */
  setWatchPath: (path: string) => void;
  close: () => Promise<void>;
}> {
  const requests: StubRequest[] = [];
  let script: number[] = [];
  let watchPath = '';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
        watchedFileExisted: watchPath === '' ? null : existsSync(watchPath),
      });
      const status = script.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(
        status < 300 ? '' : '<?xml version="1.0"?><Error><Code>ServiceUnavailable</Code></Error>',
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        requests,
        setScript: (statuses) => {
          script = statuses;
        },
        setWatchPath: (path) => {
          watchPath = path;
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

let rootDir: string;
let stub: Awaited<ReturnType<typeof startS3Stub>>;

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'vigil-pipeline-'));
  stub = await startS3Stub();
});

afterEach(async () => {
  await stub.close();
  rmSync(rootDir, { recursive: true, force: true });
});

/** Real writer + real aws4fetch uploader wired the way the service wires them. */
function makePipeline(): { writer: SpoolWriter; uploader: SpoolUploader } {
  const uploader = new SpoolUploader({
    config: uploaderConfig(`http://127.0.0.1:${stub.port}`),
    baseDelayMs: 10,
    maxDelayMs: 50,
  });
  const writer = new SpoolWriter({
    rootDir,
    maxSegmentBytes: 1 << 20,
    maxIntervalMs: 60 * 60_000,
    maxSpoolBytes: 64 << 20,
    onSegmentClosed: (segment) => {
      // Watch before the first PUT — no race with the uploader's delete.
      stub.setWatchPath(segment.gzipPath);
      uploader.enqueue(segment);
    },
  });
  return { writer, uploader };
}

/** Sole .gz segment in a source dir, for existsSync assertions. */
function netflowSegments(): string[] {
  return readdirSync(join(rootDir, 'netflow')).map((entry) => join(rootDir, 'netflow', entry));
}

describe('spool → S3 pipeline (aws4fetch over HTTP)', () => {
  it('PUTs closed segments with SigV4 to a path-style URL and unlinks after 2xx', async () => {
    const { writer, uploader } = makePipeline();
    await writer.init();
    await writer.append(NETFLOW_RECORD);
    await writer.close();
    await uploader.idle();

    expect(stub.requests).toHaveLength(1);
    const put = stub.requests[0]!;
    expect(put.method).toBe('PUT');
    // Path-style: bucket and key in the path, no bucket subdomain.
    expect(put.url).toMatch(
      /^\/vigil-flows\/flows\/netflow\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/seg-\d+-\d+\.ndjson\.gz$/,
    );
    // SigV4 markers, in the Authorization header and as headers.
    const authorization = put.headers.authorization ?? '';
    expect(authorization.startsWith('AWS4-HMAC-SHA256')).toBe(true);
    expect(authorization).toContain('Credential=AKIDEXAMPLE/');
    expect(put.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(put.headers['x-amz-content-sha256']).toBeDefined();
    expect(put.headers['content-type']).toBe('application/x-ndjson');
    expect(put.headers['content-encoding']).toBe('gzip');
    // The uploaded body is the gzipped NDJSON segment with the record in it.
    const decoded: unknown = JSON.parse(gunzipSync(put.body).toString('utf8'));
    expect(decoded).toEqual(NETFLOW_RECORD);
    // Deleted only after the 2xx: the spool dir is empty now.
    expect(netflowSegments()).toHaveLength(0);
    await uploader.stop();
  });

  it('retries injected 503s with identical bytes and deletes only after the 2xx', async () => {
    stub.setScript([503, 503, 200]);
    const { writer, uploader } = makePipeline();
    await writer.init();
    await writer.append(NETFLOW_RECORD);
    await writer.close();
    const [segmentPath] = netflowSegments();
    expect(segmentPath).toBeDefined();

    await uploader.idle();

    expect(stub.requests).toHaveLength(3);
    // Retry idempotency: the same path-style URL and identical bytes each time.
    expect(new Set(stub.requests.map((request) => request.url)).size).toBe(1);
    expect(stub.requests[0]!.body.equals(stub.requests[1]!.body)).toBe(true);
    expect(stub.requests[1]!.body.equals(stub.requests[2]!.body)).toBe(true);
    // The file existed while every PUT — including the 2xx — was in flight;
    // deletion happens after the response, and the spool is empty now.
    expect(stub.requests.every((request) => request.watchedFileExisted)).toBe(true);
    expect(netflowSegments()).toHaveLength(0);
    await uploader.stop();
  });

  it('drains the on-disk backlog when a fresh uploader boots', async () => {
    // Two writers flush segments with no uploader running — a crash backlog.
    for (let i = 0; i < 2; i++) {
      const writer = new SpoolWriter({
        rootDir,
        maxSegmentBytes: 1 << 20,
        maxIntervalMs: 60 * 60_000,
        maxSpoolBytes: 64 << 20,
        onSegmentClosed: () => {},
      });
      await writer.init();
      await writer.append({ ...NETFLOW_RECORD, receivedAt: `2026-10-09T12:00:0${i}.000Z` });
      await writer.close();
    }

    // A fresh uploader boots: rescan finds both closed segments, oldest first.
    const uploader = new SpoolUploader({
      config: uploaderConfig(`http://127.0.0.1:${stub.port}`),
      baseDelayMs: 10,
      maxDelayMs: 50,
    });
    const found = await uploader.scanAndEnqueue(rootDir);
    await uploader.idle();

    expect(found).toBe(2);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.url < stub.requests[1]!.url).toBe(true);
    // Backlog drained: no spool files remain.
    expect(netflowSegments()).toHaveLength(0);
    await uploader.stop();
  });

  it('never uploads the open segment; it goes out only after close', async () => {
    const { writer, uploader } = makePipeline();
    await writer.init();
    await writer.append(NETFLOW_RECORD);

    // The uploader sees nothing while the segment is open.
    const found = await uploader.scanAndEnqueue(rootDir);
    await uploader.idle();
    expect(found).toBe(0);
    expect(stub.requests).toHaveLength(0);
    expect(netflowSegments()).toHaveLength(1); // still open on disk

    // Closing hands the segment to the uploader, which PUTs it.
    await writer.close();
    await uploader.idle();
    expect(stub.requests).toHaveLength(1);
    await uploader.stop();
  });
});
