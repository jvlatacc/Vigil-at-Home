import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { IngestRequest } from './wire.js';

const gzipAsync = promisify(gzip);

/** How long a push waits for the relay before giving up, per the house timeout discipline. */
export const PUSH_TIMEOUT_MS = 5_000;

/**
 * The part of the WHATWG fetch API the transport uses, shaped for a POST —
 * the feed importer's `FetchLike` pattern: injected, so tests pass a fake and
 * the app passes `globalThis.fetch`.
 */
export type PostFetchLike = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: Uint8Array;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

/** What comes back from one push: the relay's HTTP status and raw reply body. */
export interface ShipperTransportReply {
  status: number;
  body: string;
}

/**
 * The wire the engine pushes through. The engine builds and validates the
 * batch; the transport serializes it, compresses it, authenticates it, and
 * returns the relay's answer. Throws on network failure or timeout — the
 * engine treats any throw as retryable.
 */
export interface ShipperTransport {
  push(request: IngestRequest): Promise<ShipperTransportReply>;
}

export interface HttpShipperTransportOptions {
  /** The relay's ingest URL, e.g. `https://relay.example.com/ingest`. */
  endpoint: string;
  /**
   * The device token, or a getter read on every push — the same read-fresh
   * rule the feed importer applies to keys, so a token change lands at once.
   */
  token: string | (() => string | undefined);
  timeoutMs?: number;
  fetch?: PostFetchLike;
}

/**
 * Pushes batches to the relay over HTTPS: one gzipped JSON body, bearer
 * token, bounded by a timeout. The engine never sees the token; the token
 * must never appear in a shipped body either, and tests hold both lines.
 */
export class HttpShipperTransport implements ShipperTransport {
  private readonly fetchImpl: PostFetchLike;

  constructor(private readonly opts: HttpShipperTransportOptions) {
    // The app passes globalThis.fetch; tests inject a fake.
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async push(request: IngestRequest): Promise<ShipperTransportReply> {
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token;
    if (!token) throw new Error('no relay token to authenticate the push');
    const body = await gzipAsync(JSON.stringify(request));
    const reply = await this.fetchImpl(this.opts.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? PUSH_TIMEOUT_MS),
    });
    return { status: reply.status, body: await reply.text() };
  }
}
