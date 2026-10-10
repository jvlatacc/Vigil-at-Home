import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IngestServer, MAX_LINE_BYTES, osqueryLineToRecord } from './ingest';
import { IngestRecord } from './record';
import { SpoolWriter } from './spool';

const TOKEN = 'test-token-0123456789';

/** A realistic vigil_network_connections results-log row (bench-fixture shape). */
function osqueryConnectionLine(): string {
  return JSON.stringify({
    name: 'vigil_network_connections',
    hostIdentifier: 'macbook.local',
    calendarTime: 'Fri Oct  9 12:00:00 2026 UTC',
    unixTime: 1_791_547_200,
    epoch: 1_791_547_200,
    counter: 42,
    logNumericsAsStrings: false,
    hashIterations: 0,
    action: 'added',
    decorations: { host_uuid: 'ABCD-1234' },
    columns: {
      address: '192.168.1.20',
      local_address: '192.168.1.20',
      local_port: '52000',
      protocol: '6',
      remote_address: '93.184.216.34',
      remote_port: '443',
      pid: '431',
      path: '/Applications/Foo.app/Contents/MacOS/foo',
      state: 'ESTABLISHED',
    },
  });
}

function osqueryListenLine(): string {
  return JSON.stringify({
    name: 'vigil_listening_ports',
    unixTime: 1_791_547_200,
    action: 'added',
    columns: { protocol: '6', local_port: '22', local_address: '0.0.0.0', pid: '1' },
  });
}

let spoolRoot: string;

beforeEach(() => {
  spoolRoot = mkdtempSync(join(tmpdir(), 'vigil-ingest-'));
});

afterEach(() => {
  rmSync(spoolRoot, { recursive: true, force: true });
});

describe('osqueryLineToRecord', () => {
  it('maps a connection row to the record with flow fields and verbatim raw', () => {
    const record = osqueryLineToRecord(
      osqueryConnectionLine(),
      '192.168.1.66',
      '2026-10-09T12:00:00.000Z',
    );
    expect(record).not.toBeNull();
    const parsed = record!;
    expect(parsed.schema).toBe('vigil.flow.v1');
    expect(parsed.source).toBe('osquery');
    expect(parsed.receivedAt).toBe('2026-10-09T12:00:00.000Z');
    expect(parsed.exporter).toEqual({ address: '192.168.1.66', version: null, engineId: null });
    expect(parsed.flow).toEqual({
      firstSwitchedMs: 0,
      lastSwitchedMs: 0,
      packets: 0,
      bytes: 0,
      protocol: 6,
      srcAddress: '192.168.1.20',
      srcPort: 52000,
      dstAddress: '93.184.216.34',
      dstPort: 443,
      tcpFlags: null,
      tos: null,
    });
    // The original line survives, unknown fields and all.
    expect((parsed.raw as Record<string, unknown>)['name']).toBe('vigil_network_connections');
    expect((parsed.raw as Record<string, unknown>)['decorations']).toEqual({
      host_uuid: 'ABCD-1234',
    });
  });

  it('keeps non-network rows with flow: null and raw preserved', () => {
    const record = osqueryLineToRecord(
      osqueryListenLine(),
      '127.0.0.1',
      '2026-10-09T12:00:00.000Z',
    );
    expect(record?.flow).toBeNull();
    expect((record?.raw as Record<string, unknown>)['name']).toBe('vigil_listening_ports');
  });

  it('returns null for lines that are not JSON objects', () => {
    expect(osqueryLineToRecord('not json', '127.0.0.1', '2026-10-09T12:00:00.000Z')).toBeNull();
    expect(osqueryLineToRecord('[1,2,3]', '127.0.0.1', '2026-10-09T12:00:00.000Z')).toBeNull();
    expect(osqueryLineToRecord('null', '127.0.0.1', '2026-10-09T12:00:00.000Z')).toBeNull();
  });
});

describe('IngestServer', () => {
  let server: IngestServer;
  let url: string;
  let records: IngestRecord[];
  let logs: string[];

  function startServer(maxLineBytes?: number): void {
    records = [];
    logs = [];
    server = new IngestServer({
      port: 0,
      token: TOKEN,
      onRecord: (record) => records.push(record),
      ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
      log: (level, message) => logs.push(`${level}: ${message}`),
    });
  }

  beforeEach(async () => {
    startServer();
    await server.listen();
    url = `http://127.0.0.1:${server.boundPort()}/ingest`;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('accepts NDJSON with the bearer token: 202, records mapped, stats counted', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: `${osqueryConnectionLine()}\n${osqueryListenLine()}\n`,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: number; invalid: number };
    expect(body).toEqual({ accepted: 2, invalid: 0 });
    expect(records).toHaveLength(2);
    expect(records[0]?.source).toBe('osquery');
    expect(records[1]?.flow).toBeNull();
    expect(server.currentStats().accepted).toBe(2);
  });

  it('rejects a missing token with 401', async () => {
    const response = await fetch(url, { method: 'POST', body: osqueryConnectionLine() });
    expect(response.status).toBe(401);
    expect(records).toHaveLength(0);
  });

  it('rejects a wrong token with 401', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}x` },
      body: osqueryConnectionLine(),
    });
    expect(response.status).toBe(401);
    expect(records).toHaveLength(0);
    expect(server.currentStats().unauthorized).toBe(1);
  });

  it('rejects a non-bearer scheme with 401', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Basic ${TOKEN}` },
      body: osqueryConnectionLine(),
    });
    expect(response.status).toBe(401);
  });

  it('rejects a line over the 1 MiB cap with 413 and accepts nothing from the batch', async () => {
    const hugeLine = JSON.stringify({
      name: 'huge',
      columns: { remote_address: 'x'.repeat(MAX_LINE_BYTES + 1) },
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: `${osqueryConnectionLine()}\n${hugeLine}\n`,
    });
    expect(response.status).toBe(413);
    expect(records).toHaveLength(0);
    expect(server.currentStats().tooLarge).toBe(1);
  });

  it('counts malformed lines, logs them rate-limited, and still accepts the rest', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: `${osqueryConnectionLine()}\nnot-json\n\n`,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: number; invalid: number };
    expect(body).toEqual({ accepted: 1, invalid: 1 });
    expect(records).toHaveLength(1);
    expect(logs.some((entry) => entry.startsWith('WARN:') && entry.includes('malformed'))).toBe(
      true,
    );
  });

  it('answers 404 for anything that is not POST /ingest', async () => {
    const post = await fetch(url.replace(/\/ingest$/, '/other'), {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: osqueryConnectionLine(),
    });
    expect(post.status).toBe(404);
    const get = await fetch(url);
    expect(get.status).toBe(404);
  });

  it('binds an ephemeral port when started with port 0', async () => {
    const ephemeral = new IngestServer({ port: 0, token: TOKEN, onRecord: () => {} });
    await ephemeral.listen();
    const port = ephemeral.boundPort();
    expect(port).not.toBeNull();
    expect(port).toBeGreaterThan(0);
    await ephemeral.stop();
  });

  it('feeds accepted records into the osquery spool as closed gz segments', async () => {
    const writer = new SpoolWriter({
      rootDir: spoolRoot,
      maxSegmentBytes: 1 << 20,
      maxIntervalMs: 60 * 60_000,
      maxSpoolBytes: 64 << 20,
    });
    const ingest = new IngestServer({
      port: 0,
      token: TOKEN,
      onRecord: (record) => writer.append(record),
    });
    await ingest.listen();
    const ingestUrl = `http://127.0.0.1:${ingest.boundPort()}/ingest`;
    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: `${osqueryConnectionLine()}\n`,
    });
    expect(response.status).toBe(202);

    await writer.close();
    await ingest.stop();

    const segments = readdirSync(join(spoolRoot, 'osquery'));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(/^seg-\d{13,}-\d{6,}\.ndjson\.gz$/);
    const stored = IngestRecord.parse(
      JSON.parse(
        gunzipSync(readFileSync(join(spoolRoot, 'osquery', segments[0] ?? ''))).toString('utf8'),
      ),
    );
    expect((stored.raw as Record<string, unknown>)['name']).toBe('vigil_network_connections');
  });
});
