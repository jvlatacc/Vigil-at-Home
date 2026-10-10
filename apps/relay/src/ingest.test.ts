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
let token: string | undefined;

afterEach(async () => {
  if (relay !== undefined) {
    await closeRelay(relay);
    relay = undefined;
  }
  token = undefined;
});

/** Starts a relay and enrolls the laptop the tests ship from. */
async function startAuthed(): Promise<TestRelay> {
  relay = await startTestRelay();
  token = relay.store.provisionDevice('laptop-1', Date.now()).token;
  return relay;
}

/** Sends an ingest batch with the enrolled device's token unless told not to. */
function ingest(
  body: string | Buffer,
  headers: Record<string, string> = {},
  withToken = true,
): Promise<unknown> {
  if (relay === undefined) throw new Error('relay not started');
  const auth = withToken && token !== undefined ? { authorization: `Bearer ${token}` } : {};
  return post(relay.port, INGEST_PATH, body, { ...auth, ...headers });
}

describe('POST /v1/ingest', () => {
  it('stores a valid batch and acks the batch cursor', async () => {
    await startAuthed();
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
    expect(relay?.store.stats().events).toBe(2);
  });

  it('answers a replayed batch with 202 and counted duplicates', async () => {
    await startAuthed();
    const batch = batchRequest([eventRecord('e1', 1), eventRecord('e2', 2)]);
    const first = (await ingest(batch)) as { status: number };
    const replay = (await ingest(batch)) as {
      status: number;
      json: { accepted: number; duplicates: number };
    };
    expect(first.status).toBe(200);
    expect(replay.status).toBe(202);
    expect(replay.json).toMatchObject({ accepted: 0, duplicates: 2 });
    expect(relay?.store.stats().events).toBe(2);
  });

  it('rejects malformed JSON with 400', async () => {
    await startAuthed();
    const reply = (await ingest('not json')) as { status: number; json: { error: string } };
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('invalid_json');
  });

  it('rejects schema violations with the zod path', async () => {
    await startAuthed();
    const bad = JSON.stringify({
      deviceId: 'laptop-1',
      cursor: { ts: 0, id: '0' },
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
    token = relay.store.provisionDevice('laptop-1', Date.now()).token;
    const flood = Array.from({ length: 500 }, (_, i) => eventRecord(`e${i}`, i));
    const reply = (await ingest(batchRequest(flood))) as { status: number };
    expect(reply.status).toBe(413);
  });

  it('accepts a gzip batch', async () => {
    await startAuthed();
    const reply = (await ingest(
      gzipped({
        v: 1,
        deviceId: 'laptop-1',
        cursor: { ts: 0, id: '0' },
        records: [eventRecord('e1', 1)],
      }),
      { 'content-encoding': 'gzip' },
    )) as { status: number };
    expect(reply.status).toBe(200);
    expect(relay?.store.stats().events).toBe(1);
  });

  it('rejects corrupt gzip with 400 invalid_encoding', async () => {
    await startAuthed();
    const reply = (await ingest(Buffer.from('definitely not gzip'), {
      'content-encoding': 'gzip',
    })) as { status: number; json: { error: string } };
    expect(reply.status).toBe(400);
    expect(reply.json.error).toBe('invalid_encoding');
  });
});

describe('ingest authentication', () => {
  it('answers 401 without a bearer token, advertising Bearer', async () => {
    await startAuthed();
    const reply = (await ingest(batchRequest([eventRecord('e1', 1)]), {}, false)) as {
      status: number;
      headers: Headers;
      json: { error: string };
    };
    expect(reply.status).toBe(401);
    expect(reply.headers.get('www-authenticate')).toBe('Bearer');
    expect(reply.json.error).toBe('missing_token');
    expect(relay?.store.stats().events).toBe(0);
  });

  it('answers 401 for an unknown token', async () => {
    await startAuthed();
    const reply = (await ingest(batchRequest([eventRecord('e1', 1)]), {
      authorization: 'Bearer rvd1_does-not-exist-00000000000000000000000000',
    })) as { status: number; json: { error: string } };
    expect(reply.status).toBe(401);
    expect(reply.json.error).toBe('unknown_token');
    expect(relay?.store.stats().events).toBe(0);
  });

  it('answers 401 when a SOC token pushes — SOC tokens read, never write', async () => {
    await startAuthed();
    const socToken = relay?.store.provisionSoc('soc-1', Date.now()).token;
    const reply = (await ingest(batchRequest([eventRecord('e1', 1)]), {
      authorization: `Bearer ${socToken}`,
    })) as { status: number; json: { error: string } };
    expect(reply.status).toBe(401);
    expect(reply.json.error).toBe('unknown_token');
    expect(relay?.store.stats().events).toBe(0);
  });

  it('answers 403 for a revoked device token', async () => {
    await startAuthed();
    const first = (await ingest(batchRequest([eventRecord('e1', 1)]))) as { status: number };
    relay?.store.revokeDevice('laptop-1', Date.now());
    const after = (await ingest(batchRequest([eventRecord('e2', 2)]))) as {
      status: number;
      json: { error: string };
    };
    expect(first.status).toBe(200);
    expect(after.status).toBe(403);
    expect(after.json.error).toBe('token_revoked');
    // Telemetry already stored stays readable by the SOC; revocation is not deletion.
    expect(relay?.store.stats().events).toBe(1);
  });

  it('answers 403 when the batch claims another device', async () => {
    await startAuthed();
    relay?.store.provisionDevice('laptop-2', Date.now());
    const reply = (await ingest(batchRequest([eventRecord('e1', 1)], 'laptop-2'))) as {
      status: number;
      json: { error: string };
    };
    expect(reply.status).toBe(403);
    expect(reply.json.error).toBe('wrong_device');
    expect(relay?.store.stats().events).toBe(0);
  });

  it('answers 403 with the old token and 200 with the new after reprovisioning', async () => {
    await startAuthed();
    const rotated = relay?.store.provisionDevice('laptop-1', Date.now()).token;
    const old = (await ingest(batchRequest([eventRecord('e1', 1)]))) as { status: number };
    const fresh =
      rotated === undefined || relay === undefined
        ? undefined
        : ((await post(relay.port, INGEST_PATH, batchRequest([eventRecord('e2', 2)]), {
            authorization: `Bearer ${rotated}`,
          })) as { status: number });
    expect(old.status).toBe(403); // rotation revokes the previous token at once
    expect(fresh?.status).toBe(200);
  });

  it('rate limits before parsing: a flood costs no reads', async () => {
    relay = await startTestRelay({ ratePerSec: 1, burst: 1 });
    token = relay.store.provisionDevice('laptop-1', Date.now()).token;
    const first = (await ingest(batchRequest([eventRecord('e1', 1)]))) as { status: number };
    // Garbage body: 429 proves the rate check ran before any parsing (a
    // parse would answer 400, like the malformed-batch test above).
    const flooded = (await ingest('not json')) as { status: number; json: { error: string } };
    expect(first.status).toBe(200);
    expect(flooded.status).toBe(429);
    expect(flooded.json.error).toBe('rate_limited');
  });

  it('rate limits unauthenticated floods by peer address too', async () => {
    relay = await startTestRelay({ ratePerSec: 1, burst: 1 });
    token = relay.store.provisionDevice('laptop-1', Date.now()).token;
    const noToken = (await ingest(batchRequest([eventRecord('e1', 1)]), {}, false)) as {
      status: number;
    };
    const next = (await ingest(batchRequest([eventRecord('e1', 1)]), {}, false)) as {
      status: number;
      json: { error: string };
    };
    expect(noToken.status).toBe(401);
    expect(next.status).toBe(429);
    expect(next.json.error).toBe('rate_limited');
  });
});

describe('GET /healthz', () => {
  it('answers 200 without authentication and without data', async () => {
    await startAuthed();
    const res = await fetch(`http://127.0.0.1:${relay?.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('routing', () => {
  it('answers 405 for a GET on the ingest path', async () => {
    await startAuthed();
    const res = await fetch(`http://127.0.0.1:${relay?.port}${INGEST_PATH}`);
    expect(res.status).toBe(405);
  });

  it('answers 404 for unknown paths', async () => {
    await startAuthed();
    const res = await fetch(`http://127.0.0.1:${relay?.port}/nope`);
    expect(res.status).toBe(404);
  });
});
