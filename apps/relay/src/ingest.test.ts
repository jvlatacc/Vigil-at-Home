import { afterEach, describe, expect, it } from 'vitest';
import { INGEST_PATH } from './ingest.js';
import {
  batchRequest,
  closeRelay,
  eventRecord,
  gzipped,
  post,
  startTestRelay,
  type TestRelay,
} from './test-support.js';

let relay: TestRelay | undefined;

afterEach(async () => {
  if (relay !== undefined) {
    await closeRelay(relay);
    relay = undefined;
  }
});

/** Sends an ingest batch to the test relay. */
function ingest(body: string | Buffer, headers: Record<string, string> = {}): Promise<unknown> {
  if (relay === undefined) throw new Error('relay not started');
  return post(relay.port, INGEST_PATH, body, headers);
}

describe('POST /v1/ingest', () => {
  it('stores a valid batch and acks the batch cursor', async () => {
    relay = await startTestRelay();
    const reply = (await ingest(batchRequest([eventRecord('e1', 1), eventRecord('e2', 2)]))) as {
      status: number;
      json: { v: number; accepted: number; duplicates: number; ackedCursor: { ts: number } };
    };
    expect(reply.status).toBe(200);
    expect(reply.json).toMatchObject({
      v: 1,
      accepted: 2,
      duplicates: 0,
      ackedCursor: { ts: 2 },
    });
    expect(relay.store.stats().events).toBe(2);
  });

  it('answers a replayed batch with 202 and counted duplicates', async () => {
    relay = await startTestRelay();
    const batch = batchRequest([eventRecord('e1', 1), eventRecord('e2', 2)]);
    const first = (await ingest(batch)) as { status: number };
    const replay = (await ingest(batch)) as {
      status: number;
      json: { accepted: number; duplicates: number };
    };
    expect(first.status).toBe(200);
    expect(replay.status).toBe(202);
    expect(replay.json).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(relay.store.stats().events).toBe(2);
  });

  it('rejects malformed JSON with 400', async () => {
    relay = await startTestRelay();
    const reply = (await ingest('not json')) as { status: number; json: { error: string } };
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('invalid_json');
  });

  it('rejects schema violations with the zod path', async () => {
    relay = await startTestRelay();
    const bad = JSON.stringify({
      deviceId: 'laptop-1',
      cursor: { ts: 0, id: '' },
      records: [eventRecord('e1', 1)],
    });
    const reply = (await ingest(bad)) as {
      status: number;
      json: { error: string; issues: { path: string }[] };
    };
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('invalid_ingest');
    expect(reply.json.issues[0]?.path).toBe('v');
  });

  it('rejects bodies over the cap with 413', async () => {
    relay = await startTestRelay({ maxBodyBytes: 1024 });
    const flood = Array.from({ length: 500 }, (_, i) => eventRecord(`e${i}`, i));
    const reply = (await ingest(batchRequest(flood))) as { status: number };
    expect(reply.status).toBe(413);
  });

  it('accepts a gzip batch', async () => {
    relay = await startTestRelay();
    const reply = (await ingest(
      gzipped({
        v: 1,
        deviceId: 'laptop-1',
        cursor: { ts: 0, id: '' },
        records: [eventRecord('e1', 1)],
      }),
      { 'content-encoding': 'gzip' },
    )) as { status: number };
    expect(reply.status).toBe(200);
    expect(relay?.store.stats().events).toBe(1);
  });

  it('rejects corrupt gzip with 400 invalid_encoding', async () => {
    relay = await startTestRelay();
    const reply = (await ingest(Buffer.from('definitely not gzip'), {
      'content-encoding': 'gzip',
    })) as { status: number; json: { error: string } };
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('invalid_encoding');
  });
});

describe('GET /healthz', () => {
  it('answers 200 without authentication and without data', async () => {
    relay = await startTestRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('routing', () => {
  it('answers 405 for a GET on the ingest path', async () => {
    relay = await startTestRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}${INGEST_PATH}`);
    expect(res.status).toBe(405);
  });

  it('answers 404 for unknown paths', async () => {
    relay = await startTestRelay();
    const res = await fetch(`http://127.0.0.1:${relay.port}/nope`);
    expect(res.status).toBe(404);
  });
});
