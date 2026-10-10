import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIpfixDataPacket,
  buildIpfixTemplatePacket,
  buildNetFlowV5Packet,
  buildNetFlowV9DataPacket,
  buildNetFlowV9TemplatePacket,
  CANONICAL_FLOW_TEMPLATE,
  encodeIpfixCanonicalRecord,
  encodeV9CanonicalRecord,
  IPFIX_FLOW_TEMPLATE,
  type V5RecordSpec,
} from './golden';
import {
  NetFlowListener,
  type ListenerCounters,
  type NetFlowListenerOptions,
  type VersionCounters,
} from './listener';
import type { IngestRecord } from './record';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const HEADER = { unixSecs: 1_789_000_000, sysUptimeMs: 10_000 };
const IPFIX_EXPORT_SEC = 1_789_000_000;

const V5_RECORD: V5RecordSpec = {
  src: '192.168.1.20',
  dst: '93.184.216.34',
  packets: 3,
  bytes: 300,
  first: 11000,
  last: 12000,
  srcPort: 52000,
  dstPort: 443,
  tcpFlags: 27,
  protocol: 6,
  tos: 4,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached before timeout');
    await sleep(25);
  }
}

function total(counters: ListenerCounters, field: keyof VersionCounters): number {
  return counters.v5[field] + counters.v9[field] + counters.ipfix[field] + counters.unknown[field];
}

function v5Packet(): Buffer {
  return buildNetFlowV5Packet({ ...HEADER, records: [V5_RECORD] });
}

const startedListeners: NetFlowListener[] = [];

async function startListener(
  sink: (records: IngestRecord[]) => void,
  overrides: Partial<NetFlowListenerOptions> = {},
): Promise<NetFlowListener> {
  const listener = new NetFlowListener({ port: 0, sink, now: () => NOW, ...overrides });
  await listener.start();
  startedListeners.push(listener);
  return listener;
}

async function sendUdp(port: number, packets: readonly Buffer[]): Promise<void> {
  const client = createSocket('udp4');
  try {
    for (const packet of packets) {
      await new Promise<void>((resolve, reject) =>
        client.send(packet, port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    client.close();
  }
}

afterEach(() => {
  for (const listener of startedListeners) listener.stop();
  startedListeners.length = 0;
});

describe('NetFlowListener', () => {
  it('absorbs a 10k-datagram burst and reconciles counters', { timeout: 60_000 }, async () => {
    const records: IngestRecord[] = [];
    const listener = await startListener((rs) => records.push(...rs));
    const port = listener.boundPort()!;

    const packet = v5Packet();
    const client = createSocket('udp4');
    try {
      // Chunked pacing: the kernel caps the receive buffer well below the
      // 720 KB this burst represents, so un-paced queueing drops datagrams at
      // the OS socket queue — a protocol property, not a listener defect.
      for (let i = 0; i < 10_000; i++) {
        await new Promise<void>((resolve, reject) =>
          client.send(packet, port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
        );
        if (i % 100 === 99) await sleep(10);
      }
    } finally {
      client.close();
    }

    try {
      await waitFor(() => total(listener.counters(), 'received') >= 10_000, 45_000);
    } catch (err) {
      console.error(
        'burst counters at timeout:',
        JSON.stringify(listener.counters()),
        'records:',
        records.length,
      );
      throw err;
    }
    await sleep(100); // let in-flight decodes finish before reconciling
    const counters = listener.counters();
    expect(counters.v5).toEqual({ received: 10_000, decoded: 10_000, dropped: 0 });
    expect(total(counters, 'received')).toBe(10_000);
    expect(total(counters, 'dropped')).toBe(0);
    expect(records).toHaveLength(10_000);
    expect(records[0]).toMatchObject({ schema: 'vigil.flow.v1', source: 'netflow' });
    expect(records[0]!.flow!.srcAddress).toBe('192.168.1.20');
    expect(records[0]!.receivedAt).toBe(NOW.toISOString());
  });

  it(
    'dispatches v5, v9 and IPFIX by header and normalizes each flow',
    { timeout: 30_000 },
    async () => {
      const records: IngestRecord[] = [];
      const listener = await startListener((rs) => records.push(...rs));
      const port = listener.boundPort()!;

      // v9 exporter: template first, then data.
      await sendUdp(port, [
        buildNetFlowV9TemplatePacket({
          ...HEADER,
          sourceId: 42,
          templates: [CANONICAL_FLOW_TEMPLATE],
        }),
      ]);
      await sendUdp(port, [
        buildNetFlowV9DataPacket({
          ...HEADER,
          sourceId: 42,
          sets: [
            {
              templateId: CANONICAL_FLOW_TEMPLATE.id,
              records: [
                encodeV9CanonicalRecord({
                  src: '192.168.1.20',
                  dst: '93.184.216.34',
                  srcPort: 52000,
                  dstPort: 443,
                  bytes: 300,
                  packets: 3,
                  protocol: 6,
                  tos: 4,
                  tcpFlags: 27,
                  firstUptimeMs: 11_000,
                  lastUptimeMs: 12_000,
                }),
              ],
            },
          ],
        }),
      ]);

      // IPFIX exporter: template first, then data.
      await sendUdp(port, [
        buildIpfixTemplatePacket({
          exportTimeSec: IPFIX_EXPORT_SEC,
          domainId: 7,
          templates: [IPFIX_FLOW_TEMPLATE],
        }),
      ]);
      await sendUdp(port, [
        buildIpfixDataPacket({
          exportTimeSec: IPFIX_EXPORT_SEC,
          domainId: 7,
          sets: [
            {
              templateId: IPFIX_FLOW_TEMPLATE.id,
              records: [
                encodeIpfixCanonicalRecord({
                  src: '198.51.100.5',
                  dst: '198.51.100.6',
                  srcPort: 53000,
                  dstPort: 80,
                  bytes: 1000,
                  packets: 10,
                  protocol: 6,
                  tos: 0,
                  tcpFlags: 16,
                  firstMs: IPFIX_EXPORT_SEC * 1000,
                  lastMs: IPFIX_EXPORT_SEC * 1000 + 1000,
                }),
              ],
            },
          ],
        }),
      ]);

      await sendUdp(port, [v5Packet()]);

      // Template packets decode to zero flows; only data and v5 packets yield records.
      await waitFor(() => records.length >= 3);
      const counters = listener.counters();
      expect(counters.v5).toEqual({ received: 1, decoded: 1, dropped: 0 });
      expect(counters.v9).toEqual({ received: 2, decoded: 2, dropped: 0 });
      expect(counters.ipfix).toEqual({ received: 2, decoded: 2, dropped: 0 });

      const v9Record = records.find((r) => r.exporter.version === 9)!;
      expect(v9Record.exporter).toEqual({ address: '127.0.0.1', version: 9, engineId: '42' });
      expect(v9Record.receivedAt).toBe(NOW.toISOString());
      expect(v9Record.flow).toMatchObject({ srcAddress: '192.168.1.20', dstPort: 443 });

      const ipfixRecord = records.find((r) => r.exporter.version === 10)!;
      expect(ipfixRecord.exporter).toEqual({ address: '127.0.0.1', version: 10, engineId: '7' });
      expect(ipfixRecord.flow).toMatchObject({ srcAddress: '198.51.100.5', dstPort: 80 });
    },
  );

  it('counts malformed datagrams as dropped and rate-limits their warnings', async () => {
    const records: IngestRecord[] = [];
    const warns: string[] = [];
    const listener = await startListener((rs) => records.push(...rs), {
      log: (message) => warns.push(message),
      maxWarnsPerWindow: 2,
    });
    const port = listener.boundPort()!;

    const malformed = v5Packet();
    malformed.writeUInt16BE(9999, 2); // record count lies: no such records exist
    await sendUdp(
      port,
      Array.from({ length: 20 }, () => malformed),
    );
    await waitFor(() => listener.counters().v5.dropped >= 20);

    expect(listener.counters().v5).toEqual({ received: 20, decoded: 0, dropped: 20 });
    expect(records).toHaveLength(0);
    expect(warns).toHaveLength(2);

    // The process survived the flood: a good packet still decodes.
    await sendUdp(port, [v5Packet()]);
    await waitFor(() => records.length >= 1);
    expect(listener.counters().v5.decoded).toBe(1);
  });

  it('drops datagrams with an unknown or truncated header without crashing', async () => {
    const records: IngestRecord[] = [];
    const listener = await startListener((rs) => records.push(...rs));
    const port = listener.boundPort()!;

    const junk = Buffer.alloc(24);
    junk.writeUInt16BE(7, 0); // no such protocol version
    const truncated = Buffer.from([5]); // one byte — no header to read
    await sendUdp(port, [junk, truncated]);
    await waitFor(() => total(listener.counters(), 'received') >= 2);

    expect(listener.counters().unknown).toEqual({ received: 2, decoded: 0, dropped: 2 });
    expect(records).toHaveLength(0);

    await sendUdp(port, [v5Packet()]);
    await waitFor(() => records.length >= 1);
    expect(listener.counters().v5.decoded).toBe(1);
  });

  it('keeps listening when the sink throws', async () => {
    const records: IngestRecord[] = [];
    let calls = 0;
    const listener = await startListener((rs) => {
      calls += 1;
      if (calls === 1) throw new Error('sink boom');
      records.push(...rs);
    });
    const port = listener.boundPort()!;

    await sendUdp(port, [v5Packet(), v5Packet()]);
    await waitFor(() => calls >= 2);

    expect(listener.counters().sinkErrors).toBe(1);
    expect(listener.counters().v5.decoded).toBe(2);
    expect(records).toHaveLength(1);
  });
});
