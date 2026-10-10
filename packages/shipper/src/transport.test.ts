import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { HttpShipperTransport, PUSH_TIMEOUT_MS } from './transport.js';
import type { IngestRequest } from '@vigil/core';

const request: IngestRequest = {
  v: 1,
  deviceId: 'laptop-a1b2c3',
  cursor: { ts: 1, id: 'e1' },
  records: [
    {
      r: 'event',
      id: 'e1',
      ts: 1,
      body: {
        id: 'e1',
        ts: 1,
        source: 'osquery',
        kind: 'process.exec',
        process: { path: '/usr/bin/curl', pid: 1, args: [], signing: 'unsigned' },
      },
    },
  ],
};

describe('HttpShipperTransport', () => {
  it('pushes one gzipped JSON body with the bearer token and timeout', async () => {
    let seen:
      | {
          url: string;
          init: {
            method: string;
            headers: Record<string, string>;
            body: Uint8Array;
            signal?: AbortSignal;
          };
        }
      | undefined;
    const transport = new HttpShipperTransport({
      endpoint: 'https://relay.example.test/ingest',
      token: 'tok-123',
      fetch: async (url, init) => {
        seen = { url, init } as typeof seen;
        return { status: 202, text: async () => '{}' };
      },
    });
    const reply = await transport.push(request);
    expect(reply.status).toBe(202);
    expect(seen?.url).toBe('https://relay.example.test/ingest');
    expect(seen?.init.method).toBe('POST');
    expect(seen?.init.headers.Authorization).toBe('Bearer tok-123');
    expect(seen?.init.headers['Content-Encoding']).toBe('gzip');
    expect(seen?.init.headers['Content-Type']).toBe('application/json');
    const decoded = JSON.parse(gunzipSync(Buffer.from(seen!.init.body)).toString());
    expect(decoded).toEqual(request);
    expect(seen?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the token fresh on every push', async () => {
    let tokenAtCall = '';
    let round = 0;
    const transport = new HttpShipperTransport({
      endpoint: 'https://relay.example.test/ingest',
      token: () => (round === 0 ? 'tok-old' : 'tok-new'),
      fetch: async (_url, init) => {
        tokenAtCall = init.headers.Authorization ?? '';
        round += 1;
        return { status: 202, text: async () => '{}' };
      },
    });
    await transport.push(request);
    await transport.push(request);
    expect(tokenAtCall).toBe('Bearer tok-new');
  });

  it('refuses to push without a token', async () => {
    const transport = new HttpShipperTransport({
      endpoint: 'https://relay.example.test/ingest',
      token: () => undefined,
      fetch: async () => {
        throw new Error('must not be called');
      },
    });
    await expect(transport.push(request)).rejects.toThrow(/no relay token/);
  });

  it('uses the 5 s house timeout by default', () => {
    expect(PUSH_TIMEOUT_MS).toBe(5_000);
  });
});
