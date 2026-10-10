import { createSocket } from 'node:dgram';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildNetFlowV5Packet } from './golden';
import { IngestRecord } from './record';
import { startService, type ServiceHandle } from './service';

const TOKEN = 'test-service-token-0123456789';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Grabs a free TCP port the OS just released (tiny race, acceptable here). */
async function freeTcpPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function freeUdpPort(): Promise<number> {
  const probe = createSocket('udp4');
  await new Promise<void>((resolve) => probe.bind(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise<void>((resolve) => probe.close(resolve));
  return port;
}

function serviceEnv(listenUdpPort: number, ingestTcpPort: number): Record<string, string> {
  return {
    VIGIL_LISTEN_UDP_PORT: String(listenUdpPort),
    VIGIL_INGEST_TCP_PORT: String(ingestTcpPort),
    VIGIL_INGEST_TOKEN: TOKEN,
    // A port that refuses connections: uploads fail and segments stay parked.
    VIGIL_S3_ENDPOINT: 'http://127.0.0.1:1',
    VIGIL_S3_BUCKET: 'test-bucket',
    VIGIL_S3_ACCESS_KEY: 'test-access-key',
    VIGIL_S3_SECRET_KEY: 'test-secret-key',
    VIGIL_UPLOAD_INTERVAL_SEC: '3600', // no interval rotations mid-test
    VIGIL_UPLOAD_MAX_MB: '64',
    VIGIL_SPOOL_MAX_MB: '64',
  };
}

function osqueryLine(): string {
  return JSON.stringify({
    name: 'vigil_network_connections',
    unixTime: 1_791_547_200,
    action: 'added',
    columns: {
      local_address: '192.168.1.20',
      local_port: '52000',
      protocol: '6',
      remote_address: '93.184.216.34',
      remote_port: '443',
    },
  });
}

function readGzLines(spoolRoot: string, source: 'netflow' | 'osquery'): IngestRecord[] {
  const dir = join(spoolRoot, source);
  return readdirSync(dir).map((name) =>
    IngestRecord.parse(JSON.parse(gunzipSync(readFileSync(join(dir, name))).toString('utf8'))),
  );
}

describe('startService wiring', () => {
  let spoolRoot: string;
  let handles: ServiceHandle[];

  beforeEach(() => {
    spoolRoot = mkdtempSync(join(tmpdir(), 'vigil-service-'));
    handles = [];
  });

  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.stop();
    rmSync(spoolRoot, { recursive: true, force: true });
  });

  it('runs both listeners into one spool and flushes open segments on stop', async () => {
    const [udpPort, tcpPort] = await Promise.all([freeUdpPort(), freeTcpPort()]);
    const handle = await startService({ env: serviceEnv(udpPort, tcpPort), spoolRoot });
    handles.push(handle);
    expect(handle.netflowPort()).toBe(udpPort);
    expect(handle.ingestPort()).toBe(tcpPort);

    // Path 1: authenticated NDJSON ingest → 202, record in the open segment.
    const ingestResponse = await fetch(`http://127.0.0.1:${tcpPort}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: `${osqueryLine()}\n`,
    });
    expect(ingestResponse.status).toBe(202);

    // Path 2: a real NetFlow v5 datagram from the golden builder.
    const udp = createSocket('udp4');
    const packet = buildNetFlowV5Packet({
      unixSecs: 1_791_547_200,
      records: [
        {
          src: '192.168.1.20',
          dst: '93.184.216.34',
          packets: 3,
          bytes: 1440,
          first: 100,
          last: 400,
          srcPort: 52000,
          dstPort: 443,
          tcpFlags: 27,
          protocol: 6,
          tos: 0,
        },
      ],
    });
    udp.send(packet, udpPort, '127.0.0.1');
    await sleep(150); // loopback delivery is fast but not synchronous
    udp.close();

    // The ingest endpoint is live through the service: 401 without a token.
    const probe = await fetch(`http://127.0.0.1:${tcpPort}/ingest`, {
      method: 'POST',
      body: osqueryLine(),
    });
    expect(probe.status).toBe(401);

    await handle.stop();

    // Graceful shutdown flushed both open segments as closed gz files. No S3
    // was reachable, so at-least-once means the files stay parked on disk.
    const osqueryRecords = readGzLines(spoolRoot, 'osquery');
    expect(osqueryRecords).toHaveLength(1);
    expect(osqueryRecords[0]?.source).toBe('osquery');
    expect((osqueryRecords[0]?.raw as Record<string, unknown>)['name']).toBe(
      'vigil_network_connections',
    );

    const netflowRecords = readGzLines(spoolRoot, 'netflow');
    expect(netflowRecords).toHaveLength(1);
    expect(netflowRecords[0]?.source).toBe('netflow');
    expect(netflowRecords[0]?.flow?.dstAddress).toBe('93.184.216.34');
    expect(netflowRecords[0]?.flow?.dstPort).toBe(443);
    expect(netflowRecords[0]?.flow?.packets).toBe(3);
  });

  it('port 0 disables both ingestion paths while the pipeline still boots', async () => {
    const handle = await startService({ env: serviceEnv(0, 0), spoolRoot });
    handles.push(handle);
    expect(handle.netflowPort()).toBeUndefined();
    expect(handle.ingestPort()).toBeNull();
    await handle.stop(); // clean shutdown with nothing listening
  });

  it('refuses to start on invalid config, naming the offending variable', async () => {
    const env = serviceEnv(0, 0);
    delete env['VIGIL_INGEST_TOKEN'];
    await expect(startService({ env, spoolRoot })).rejects.toThrow(/VIGIL_INGEST_TOKEN/);
  });
});
