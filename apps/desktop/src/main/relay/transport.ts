import { gzipSync } from 'node:zlib';
import { IngestAck, type IngestRequest } from './wire.js';
import { RevokedError } from './engine.js';

/**
 * The real ingest transport: one HTTPS POST per batch, gzipped JSON, the
 * device token as a bearer header, 5 s timeout — spec §2. The token is read
 * fresh for every push and never appears in a log line or an error message.
 */

export interface IngestTransport {
  push(request: IngestRequest): Promise<IngestAck>;
}

export const INGEST_TIMEOUT_MS = 5_000;

export function createIngestTransport(opts: {
  endpointUrl: string;
  token: () => string | undefined;
  deviceId: string;
  timeoutMs?: number;
}): IngestTransport {
  const timeoutMs = opts.timeoutMs ?? INGEST_TIMEOUT_MS;
  return {
    async push(request: IngestRequest): Promise<IngestAck> {
      const token = opts.token();
      if (!token) throw new RevokedError('No relay device token is saved');
      const body = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(request), 'utf8')));
      let res: Response;
      try {
        res = await fetch(`${opts.endpointUrl}/ingest`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(
          `could not reach the relay: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      // The relay answers 401 for a missing or unknown token and 403 for a
      // revoked device; from the laptop's side both mean stop and re-provision.
      if (res.status === 401 || res.status === 403) {
        throw new RevokedError(`the relay refused this device's token (${res.status})`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`the relay is busy (${res.status}); retrying`);
      }
      if (!res.ok) throw new Error(`the relay rejected the batch (${res.status})`);
      return IngestAck.parse(await res.json());
    },
  };
}
