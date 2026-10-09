import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { IpfixDecoder } from './decode/ipfix';
import { decodeNetFlowV5 } from './decode/v5';
import { NetFlowV9Decoder } from './decode/v9';
import { NetFlowDecodeError, type DecodedFlow } from './decode/types';
import { flowToRecord } from './normalize';
import type { IngestRecord } from './record';
import { RateLimiter } from './rateLimit';

const RECV_BUFFER_BYTES = 8 * 1024 * 1024;

type VersionKey = 'v5' | 'v9' | 'ipfix' | 'unknown';

export interface VersionCounters {
  received: number;
  decoded: number;
  dropped: number;
}

export interface ListenerCounters {
  v5: VersionCounters;
  v9: VersionCounters;
  ipfix: VersionCounters;
  unknown: VersionCounters;
  /** Socket-level errors (e.g. ICMP-surfaced failures) — never fatal. */
  socketErrors: number;
  /** Sink callback failures — records lost, surfaced by counter and log. */
  sinkErrors: number;
}

export interface NetFlowListenerOptions {
  /** UDP port to bind; 0 lets the OS pick an ephemeral port. */
  port: number;
  /** Receives every batch of normalized records decoded from one datagram. */
  sink: (records: IngestRecord[]) => void;
  /** Warn channel; defaults to console.warn. Injectable for tests. */
  log?: (message: string) => void;
  /** Malformed/socket warnings allowed per window. */
  maxWarnsPerWindow?: number;
  /** Appliance clock; defaults to the real one. Injectable for tests. */
  now?: () => Date;
}

function versionKeyOf(buf: Buffer): VersionKey {
  if (buf.length < 2) return 'unknown';
  switch (buf.readUInt16BE(0)) {
    case 5:
      return 'v5';
    case 9:
      return 'v9';
    case 10:
      return 'ipfix';
    default:
      return 'unknown';
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The NetFlow v5/v9/IPFIX UDP listener. One dgram socket, version detected
 * from the packet header, per-version dispatch into the shared normalizer.
 * Malformed datagrams and socket errors are counted and logged (rate-limited)
 * — they never crash the process.
 */
export class NetFlowListener {
  private readonly socket: Socket;
  private readonly v9Decoder = new NetFlowV9Decoder();
  private readonly ipfixDecoder = new IpfixDecoder();
  private readonly limiter: RateLimiter;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly byVersion = new Map<VersionKey, VersionCounters>();
  private socketErrors = 0;
  private sinkErrors = 0;

  constructor(private readonly options: NetFlowListenerOptions) {
    this.socket = createSocket('udp4');
    this.log = options.log ?? ((message) => console.warn(message));
    this.now = options.now ?? (() => new Date());
    this.limiter = new RateLimiter(options.maxWarnsPerWindow ?? 5, 60_000);
  }

  start(): Promise<void> {
    this.socket.on('message', this.onMessage);
    this.socket.on('error', this.onSocketError);
    return new Promise((resolve, reject) => {
      const onBindError = (err: Error): void => reject(err);
      this.socket.once('error', onBindError);
      this.socket.bind(this.options.port, () => {
        // The fd only exists after bind; sizing the buffer before bind fails with EBADF.
        this.socket.setRecvBufferSize(RECV_BUFFER_BYTES);
        this.socket.removeListener('error', onBindError);
        resolve();
      });
    });
  }

  stop(): void {
    this.socket.close();
  }

  /** The port actually bound — meaningful when started with port 0. */
  boundPort(): number | undefined {
    return this.socket.address().port;
  }

  counters(): ListenerCounters {
    const versionCounters = (key: VersionKey): VersionCounters => {
      const c = this.byVersion.get(key);
      return { received: c?.received ?? 0, decoded: c?.decoded ?? 0, dropped: c?.dropped ?? 0 };
    };
    return {
      v5: versionCounters('v5'),
      v9: versionCounters('v9'),
      ipfix: versionCounters('ipfix'),
      unknown: versionCounters('unknown'),
      socketErrors: this.socketErrors,
      sinkErrors: this.sinkErrors,
    };
  }

  private count(key: VersionKey, field: keyof VersionCounters): void {
    const counters = this.byVersion.get(key) ?? { received: 0, decoded: 0, dropped: 0 };
    counters[field] += 1;
    this.byVersion.set(key, counters);
  }

  private onMessage = (buf: Buffer, rinfo: RemoteInfo): void => {
    const versionKey = versionKeyOf(buf);
    this.count(versionKey, 'received');
    try {
      const records = this.decodePacket(buf, rinfo.address, versionKey);
      this.count(versionKey, 'decoded');
      if (records.length > 0) this.deliver(records);
    } catch (err) {
      this.count(versionKey, 'dropped');
      if (this.limiter.admit()) {
        this.log(
          `dropped malformed datagram (${versionKey}) from ${rinfo.address}: ${describeError(err)}`,
        );
      }
    }
  };

  private onSocketError = (err: Error): void => {
    this.socketErrors += 1;
    if (this.limiter.admit()) this.log(`socket error: ${describeError(err)}`);
  };

  private decodePacket(
    buf: Buffer,
    exporterAddress: string,
    versionKey: VersionKey,
  ): IngestRecord[] {
    const receivedAt = this.now().toISOString();
    let flows: DecodedFlow[];
    switch (versionKey) {
      case 'v5':
        flows = decodeNetFlowV5(buf);
        break;
      case 'v9':
        flows = this.v9Decoder.decode(buf, exporterAddress);
        break;
      case 'ipfix':
        flows = this.ipfixDecoder.decode(buf, exporterAddress);
        break;
      case 'unknown': {
        const detail = buf.length >= 2 ? `version ${buf.readUInt16BE(0)}` : 'truncated header';
        throw new NetFlowDecodeError(`unrecognized netflow datagram: ${detail}`);
      }
    }
    return flows.map((flow) => flowToRecord(flow, exporterAddress, receivedAt));
  }

  private deliver(records: IngestRecord[]): void {
    try {
      this.options.sink(records);
    } catch (err) {
      this.sinkErrors += 1;
      if (this.limiter.admit()) this.log(`sink delivery failed: ${describeError(err)}`);
    }
  }
}
