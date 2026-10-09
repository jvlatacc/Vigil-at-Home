import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { IngestRecord, type IngestRecord as IngestRecordType } from './record';
import { RateLimiter } from './rateLimit';

/** The 1 MiB per-line cap from the spec: a longer line rejects the request. */
export const MAX_LINE_BYTES = 1_048_576;

/** Whole-request guard: the largest batch a forwarder may send at once. */
const MAX_BODY_BYTES = 16 * MAX_LINE_BYTES;

export type IngestLogLevel = 'ERROR' | 'WARN';

export interface IngestServerOptions {
  /** TCP port to bind; 0 lets the OS pick an ephemeral port (tests). */
  port: number;
  /** Bearer token required by POST /ingest (config enforces min 16 chars). */
  token: string;
  /** Receives every accepted record — the spool writer's append hook. */
  onRecord: (record: IngestRecordType) => void;
  maxLineBytes?: number;
  log?: (level: IngestLogLevel, message: string) => void;
}

export interface IngestStats {
  accepted: number;
  invalidLines: number;
  unauthorized: number;
  tooLarge: number;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Maps one osquery results-log line to a vigil.flow.v1 record, permissively:
 * a JSON object always survives (whole line in `raw`); connection-shaped
 * columns additionally populate the flow fields. Returns null for lines that
 * are not JSON objects — the caller counts and rate-limited-logs those.
 */
export function osqueryLineToRecord(
  line: string,
  exporterAddress: string,
  receivedAt: string,
): IngestRecordType | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;
  const columns =
    object.columns !== null && typeof object.columns === 'object' && !Array.isArray(object.columns)
      ? (object.columns as Record<string, unknown>)
      : {};
  const remoteAddress = columns['remote_address'];
  const remotePort = columns['remote_port'];
  const candidate = {
    schema: 'vigil.flow.v1',
    source: 'osquery',
    receivedAt,
    exporter: { address: exporterAddress, version: null, engineId: null },
    flow:
      typeof remoteAddress === 'string' && remoteAddress.length > 0
        ? {
            // osquery rows carry no flow timing or counters; zeros are the
            // documented encoding of "unknown" for the osquery path.
            firstSwitchedMs: 0,
            lastSwitchedMs: 0,
            packets: 0,
            bytes: 0,
            protocol: Number(columns['protocol'] ?? 0),
            srcAddress: String(columns['local_address'] ?? ''),
            srcPort: Number(columns['local_port'] ?? 0),
            dstAddress: remoteAddress,
            dstPort: Number(remotePort ?? 0),
            tcpFlags: null,
            tos: null,
          }
        : null,
    raw: object,
  };
  const result = IngestRecord.safeParse(candidate);
  return result.success ? result.data : null;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * The authenticated NDJSON ingest endpoint from the spec: POST /ingest of
 * osquery results-log lines, one JSON object per line, bearer-token auth.
 * Per the spec's failure semantics: a missing or wrong token is 401, a line
 * over the 1 MiB cap is 413, malformed lines are counted and rate-limited-
 * logged (never fatal), and any batch that survives those checks is 202'd.
 * TLS is a deployment concern (reverse proxy), documented in the recipe.
 */
export class IngestServer {
  private readonly server: Server;
  private readonly port: number;
  private readonly tokenHash: Buffer;
  private readonly maxLineBytes: number;
  private readonly log: (level: IngestLogLevel, message: string) => void;
  private readonly limiter = new RateLimiter(5, 60_000);
  private readonly onRecord: (record: IngestRecordType) => void;
  private readonly stats: IngestStats = {
    accepted: 0,
    invalidLines: 0,
    unauthorized: 0,
    tooLarge: 0,
  };

  constructor(options: IngestServerOptions) {
    this.onRecord = options.onRecord;
    this.port = options.port;
    this.tokenHash = sha256(options.token);
    this.maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
    this.log = options.log ?? (() => {});
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    // An unhandled 'error' (port clash, socket reset before a response) must
    // not crash the service; these are per-connection, not pipeline failures.
    this.server.on('error', (err) => {
      if (this.limiter.admit()) this.log('WARN', `ingest server error: ${describe(err)}`);
    });
  }

  /** Binds to the configured port; port 0 lets the OS pick one. Disabling
   * the endpoint (VIGIL_INGEST_TCP_PORT=0) is a service-level decision. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** The actually bound port (tests bind port 0 and read this back). */
  boundPort(): number | null {
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : null;
  }

  currentStats(): IngestStats {
    return { ...this.stats };
  }

  /** Stops accepting connections and settles in-flight ones. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/ingest') {
        respond(response, 404, { error: 'not found' });
        return;
      }
      if (!this.authorized(request.headers.authorization)) {
        this.stats.unauthorized += 1;
        respond(response, 401, { error: 'unauthorized' });
        return;
      }

      const body = await this.readBody(request);
      if (body === null || this.hasOverCapLine(body)) {
        this.stats.tooLarge += 1;
        respond(response, 413, { error: `body or line exceeds ${this.maxLineBytes} bytes` });
        return;
      }

      const peer = request.socket.remoteAddress ?? 'unknown';
      const receivedAt = new Date().toISOString();
      let accepted = 0;
      let invalid = 0;
      for (const line of body.toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        const record = osqueryLineToRecord(line, peer, receivedAt);
        if (record === null) {
          invalid += 1;
          if (this.limiter.admit()) {
            this.log('WARN', `rejected malformed ingest line (${line.length} bytes) from ${peer}`);
          }
          continue;
        }
        this.onRecord(record);
        accepted += 1;
      }
      this.stats.accepted += accepted;
      this.stats.invalidLines += invalid;
      respond(response, 202, { accepted, invalid });
    } catch (err) {
      // Never fatal: the listeners and the pipeline keep running.
      if (this.limiter.admit()) this.log('ERROR', `ingest handler failed: ${describe(err)}`);
      respond(response, 500, { error: 'internal error' });
    }
  }

  private authorized(header: string | undefined): boolean {
    if (header === undefined || !header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length).trim();
    // Both sides are fixed-length SHA-256 digests, so timingSafeEqual cannot
    // throw on a length mismatch — and the comparison is explicitly
    // constant-time rather than depending on Buffer internals.
    return timingSafeEqual(sha256(presented), this.tokenHash);
  }

  private hasOverCapLine(body: Buffer): boolean {
    for (const line of body.toString('utf8').split('\n')) {
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) return true;
    }
    return false;
  }

  /** Collects the body, or null when it exceeds the whole-request cap. */
  private readBody(request: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const done = (value: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      request.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          request.destroy(); // unbounded stream — cut the socket
          done(null);
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => done(Buffer.concat(chunks)));
      request.on('error', () => done(null));
      request.on('close', () => done(null)); // aborted before end; end wins first
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
