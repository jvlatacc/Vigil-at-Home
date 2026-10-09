import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DetectionEngine } from '../engine.js';
import {
  cleanEntries,
  DEFAULT_FEEDS,
  FeedImporter,
  MemoryFeedStateStore,
  parseFeed,
  type FeedSource,
  type FeedStateStore,
  type FetchLike,
} from '../feeds/index.js';
import { macosCoreRules } from '../packs/macos-core.js';
import { sqliteStores, type SqlDatabase } from '../state/sqlite.js';
import { memoryStores } from '../state/stores.js';
import { chrome, connect, DAY, HOUR, proc, T0 } from './fixtures.js';

const sha = (c: string) => c.repeat(64);

describe('parseFeed', () => {
  it('reads one value per line and skips comments and trailing columns', () => {
    const text = '# Feodo\n; note\n\n  45.9.1.2  \n45.9.1.3,2026-09-01\n45.9.1.4 # c2\r\n';
    expect(parseFeed(text, 'lines')).toEqual(['45.9.1.2', '45.9.1.3', '45.9.1.4']);
  });
  it('reads host names out of a hosts file', () => {
    const text = '# URLhaus\n127.0.0.1\tbad.example\n0.0.0.0 a.example b.example\nlone.example\n';
    expect(parseFeed(text, 'hosts')).toEqual([
      'bad.example',
      'a.example',
      'b.example',
      'lone.example',
    ]);
  });
});

describe('cleanEntries', () => {
  it('keeps well-formed hashes, lowercased and deduplicated', () => {
    const r = cleanEntries('known_bad_sha256', [sha('A'), sha('a'), 'abc', sha('g')]);
    expect(r.entries).toEqual([sha('a')]);
    expect(r.dropped).toEqual({ malformed: 2 });
  });

  it('never lists shared platforms, their subdomains or their parents', () => {
    const r = cleanEntries(
      'known_bad_domains',
      [
        'evil.example',
        'Evil.Example.',
        'github.com',
        'raw.githubusercontent.com',
        'x.pages.dev',
        'com',
        'icloud.com',
        '1.2.3.4',
        'bad_host!.example',
        'mine.corp',
        'corp',
      ],
      { neverListDomains: ['mine.corp'] },
    );
    expect(r.entries).toEqual(['evil.example']);
    expect(r.dropped).toEqual({ protected_domain: 5, malformed: 3, ip_in_domain_list: 1 });
  });

  it('refuses private, reserved and very wide address ranges', () => {
    const r = cleanEntries(
      'known_bad_ips',
      [
        '45.9.1.2',
        '45.9.1.2/32',
        '45.9.2.0/24',
        '10.1.2.3',
        '192.168.1.1',
        '127.0.0.1',
        '8.0.0.0/8',
        '2a01:4f8::1',
        'fe80::1',
        '1.2.3.4/40',
        'nonsense',
        '5.6.7.8',
      ],
      { neverListNetworks: ['5.6.7.0/24'] },
    );
    expect(r.entries).toEqual(['45.9.1.2', '45.9.2.0/24', '2a01:4f8::1']);
    expect(r.dropped).toEqual({ reserved_address: 5, range_too_wide: 1, malformed: 2 });
  });
});

function fakeFetch(
  bodies: Record<
    string,
    () => { status?: number; body?: string; etag?: string; location?: string }
  >,
) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      ...(init.redirect ? { redirect: init.redirect } : {}),
    });
    const r = bodies[url];
    if (!r) throw new Error('network down');
    const { status = 200, body = '', etag, location } = r();
    const hdrs: Record<string, string | undefined> = { etag, location };
    return {
      status,
      headers: { get: (n: string) => hdrs[n.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  return { fetch, calls };
}

const src = (over: Partial<FeedSource> & { id: string; url: string }): FeedSource => ({
  name: over.id,
  list: 'known_bad_ips',
  format: 'lines',
  intervalHours: 6,
  retainDays: 0,
  license: 'CC0-1.0',
  homepage: 'https://example.test/',
  ...over,
});

describe('FeedImporter', () => {
  it("combines sources into one list and keeps a failed source's old entries", async () => {
    const stores = memoryStores();
    let bFails = false;
    const { fetch } = fakeFetch({
      'https://a.test/ips': () => ({ body: '45.9.1.2\n' }),
      'https://b.test/ips': () => (bFails ? { status: 500 } : { body: '45.9.1.3\n' }),
    });
    let now = T0;
    const imp = new FeedImporter(
      [src({ id: 'a', url: 'https://a.test/ips' }), src({ id: 'b', url: 'https://b.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now, confirmWindowMs: 0 },
    );
    const first = await imp.run();
    expect(first.map((r) => r.status)).toEqual(['updated', 'updated']);
    expect(stores.lists.has('known_bad_ips', '45.9.1.2')).toBe(true);
    expect(stores.lists.has('known_bad_ips', '45.9.1.3')).toBe(true);

    bFails = true;
    now += 7 * HOUR;
    const second = await imp.run();
    expect(second[1]).toMatchObject({ status: 'failed', error: 'HTTP 500', entries: 1 });
    expect(stores.lists.has('known_bad_ips', '45.9.1.3')).toBe(true);
    expect(imp.status()[1]).toMatchObject({ lastError: 'HTTP 500', stale: false });
  });

  it('only fetches when due, and retries a failure sooner', async () => {
    const { fetch, calls } = fakeFetch({ 'https://a.test/ips': () => ({ body: '45.9.1.2' }) });
    let now = T0;
    const imp = new FeedImporter(
      [src({ id: 'a', url: 'https://a.test/ips' }), src({ id: 'down', url: 'https://down.test/' })],
      memoryStores().lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now },
    );
    await imp.run();
    now += 0.5 * HOUR;
    const r = await imp.run();
    expect(r.map((x) => x.status)).toEqual(['skipped', 'skipped']);
    now += 0.5 * HOUR; // after an hour the failed source retries; the healthy one waits 6 h
    expect((await imp.run()).map((x) => x.status)).toEqual(['skipped', 'failed']);
    expect(calls.filter((c) => c.url === 'https://a.test/ips')).toHaveLength(1);
    expect((await imp.run({ force: true }))[0]!.status).toBe('updated');
  });

  it('sends the ETag back and handles "not modified"', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.test/ips': () =>
        calls.length > 1 ? { status: 304 } : { body: '45.9.1.2', etag: '"v1"' },
    });
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'a', url: 'https://a.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, confirmWindowMs: 0 },
    );
    await imp.run({ force: true });
    const r = await imp.run({ force: true });
    expect(calls[1]!.headers['If-None-Match']).toBe('"v1"');
    expect(r[0]).toMatchObject({ status: 'not_modified', entries: 1 });
    expect(stores.lists.has('known_bad_ips', '45.9.1.2')).toBe(true);
  });

  it('keeps the old list when a full feed suddenly shrinks', async () => {
    const big = Array.from({ length: 100 }, (_, i) => `45.9.${i}.1`).join('\n');
    let body = big;
    const { fetch } = fakeFetch({ 'https://a.test/ips': () => ({ body }) });
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'a', url: 'https://a.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, confirmWindowMs: 0 },
    );
    await imp.run({ force: true });
    body = '<html>maintenance</html>';
    const r = await imp.run({ force: true });
    expect(r[0]!.status).toBe('failed');
    expect(r[0]!.error).toMatch(/shrank from 100 to 0/);
    expect(stores.lists.size('known_bad_ips')).toBe(100);
  });

  it("sends the user's key to a feed that needs one", async () => {
    const { fetch, calls } = fakeFetch({ 'https://k.test/ips': () => ({ body: '45.9.1.2' }) });
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'k', url: 'https://k.test/ips', auth: { key: 'abusech', header: 'Auth-Key' } })],
      stores.lists,
      new MemoryFeedStateStore(),
      {
        fetch,
        keys: (name) => (name === 'abusech' ? 'user-key-0123456789' : undefined),
        confirmWindowMs: 0,
      },
    );
    expect((await imp.run())[0]).toMatchObject({ status: 'updated', entries: 1 });
    expect(calls[0]!.headers['Auth-Key']).toBe('user-key-0123456789');
    expect(imp.status()[0]!.needsKey).toBeUndefined();
  });

  describe('redirects of a request carrying the key', () => {
    const keyed = (url: string, fetch: FetchLike) =>
      new FeedImporter(
        [src({ id: 'k', url, auth: { key: 'abusech', header: 'Auth-Key' } })],
        memoryStores().lists,
        new MemoryFeedStateStore(),
        { fetch, keys: () => 'user-key-0123456789', confirmWindowMs: 0 },
      );

    it('follows a same-origin https redirect and sends the key on each hop', async () => {
      const { fetch, calls } = fakeFetch({
        'https://k.test/ips': () => ({ status: 302, location: '/v2/ips' }),
        'https://k.test/v2/ips': () => ({ body: '45.9.1.2' }),
      });
      const r = await keyed('https://k.test/ips', fetch).run();
      expect(r[0]).toMatchObject({ status: 'updated', entries: 1 });
      expect(calls.map((c) => c.url)).toEqual(['https://k.test/ips', 'https://k.test/v2/ips']);
      for (const c of calls) {
        expect(c.redirect).toBe('manual');
        expect(c.headers['Auth-Key']).toBe('user-key-0123456789');
      }
    });

    it('refuses a redirect to another origin without requesting it', async () => {
      for (const location of [
        'https://elsewhere.test/ips',
        'https://k.test:8443/ips',
        'https://sub.k.test/ips',
      ]) {
        const { fetch, calls } = fakeFetch({
          'https://k.test/ips': () => ({ status: 301, location }),
          [location]: () => ({ body: '45.9.1.2' }),
        });
        const r = await keyed('https://k.test/ips', fetch).run();
        expect(r[0]).toMatchObject({ status: 'failed' });
        expect(r[0]!.error).toMatch(/another site/);
        expect(calls.map((c) => c.url)).toEqual(['https://k.test/ips']);
      }
    });

    it('refuses a redirect down to http', async () => {
      const { fetch, calls } = fakeFetch({
        'https://k.test/ips': () => ({ status: 307, location: 'http://k.test/ips' }),
        'http://k.test/ips': () => ({ body: '45.9.1.2' }),
      });
      const r = await keyed('https://k.test/ips', fetch).run();
      expect(r[0]).toMatchObject({ status: 'failed' });
      expect(calls.map((c) => c.url)).toEqual(['https://k.test/ips']);
    });

    it('stops after a few same-origin redirects', async () => {
      const { fetch, calls } = fakeFetch({
        'https://k.test/ips': () => ({ status: 302, location: '/ips' }),
      });
      const r = await keyed('https://k.test/ips', fetch).run();
      expect(r[0]!.error).toMatch(/too many/);
      expect(calls.length).toBeLessThanOrEqual(4);
    });

    it('leaves redirects to fetch when no key is sent', async () => {
      const { fetch, calls } = fakeFetch({ 'https://k.test/ips': () => ({ body: '45.9.1.2' }) });
      const imp = new FeedImporter(
        [src({ id: 'k', url: 'https://k.test/ips', auth: { key: 'abusech', header: 'Auth-Key' } })],
        memoryStores().lists,
        new MemoryFeedStateStore(),
        { fetch, keys: () => undefined },
      );
      await imp.run();
      expect(calls[0]!.redirect).toBeUndefined();
    });
  });

  it('fetches a keyed feed without a header when no key is saved', async () => {
    const { fetch, calls } = fakeFetch({ 'https://k.test/ips': () => ({ body: '45.9.1.2' }) });
    const imp = new FeedImporter(
      [src({ id: 'k', url: 'https://k.test/ips', auth: { key: 'abusech', header: 'Auth-Key' } })],
      memoryStores().lists,
      new MemoryFeedStateStore(),
      { fetch, keys: () => undefined, confirmWindowMs: 0 },
    );
    expect((await imp.run())[0]).toMatchObject({ status: 'updated', entries: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).not.toHaveProperty('Auth-Key');
    expect(imp.status()[0]).toMatchObject({ stale: false });
    expect(imp.status()[0]!.needsKey).toBeUndefined();
  });

  for (const refused of [401, 403]) {
    it(`treats a keyless HTTP ${refused} as needs_key and keeps what it already listed`, async () => {
      const big = Array.from({ length: 100 }, (_, i) => `45.9.${i}.1`).join('\n');
      let status = 200;
      const { fetch, calls } = fakeFetch({
        'https://k.test/ips': () => ({ status, body: status === 200 ? big : 'auth required' }),
        'https://open.test/ips': () => ({ body: '45.8.1.1' }),
      });
      let key: string | undefined = undefined;
      let now = T0;
      const stores = memoryStores();
      const state = new MemoryFeedStateStore();
      const imp = new FeedImporter(
        [
          src({ id: 'k', url: 'https://k.test/ips', auth: { key: 'abusech', header: 'Auth-Key' } }),
          src({ id: 'open', url: 'https://open.test/ips' }),
        ],
        stores.lists,
        state,
        { fetch, keys: () => key, now: () => now, confirmWindowMs: 0 },
      );
      await imp.run();
      expect(stores.lists.size('known_bad_ips')).toBe(101);
      expect(imp.status()[0]!.needsKey).toBeUndefined();

      // abuse.ch starts requiring a key, long after the last fetch.
      status = refused;
      now += 30 * HOUR;
      const before = state.get('k')!;
      const r = await imp.run({ force: true });
      expect(r.map((x) => x.status)).toEqual(['needs_key', 'updated']);
      expect(r[0]).toMatchObject({ entries: 100 });
      expect(r[0]!.error).toBeUndefined();
      expect(calls.at(-2)!.headers).not.toHaveProperty('Auth-Key');
      // No failure recorded, entries kept, and the other feed's rebuild keeps them in the list.
      expect(state.get('k')).toMatchObject({
        entries: before.entries,
        fetchedAt: before.fetchedAt,
        needsKey: true,
      });
      expect(state.get('k')!.lastError).toBeUndefined();
      expect(stores.lists.size('known_bad_ips')).toBe(101);
      expect(imp.status()[0]).toMatchObject({ needsKey: true, stale: false, entries: 100 });
      expect(imp.status()[0]!.lastError).toBeUndefined();

      // Adding a key makes it due at once and sends the header; success clears needs_key.
      status = 200;
      key = 'user-key-0123456789';
      expect(imp.status()[0]!.needsKey).toBeUndefined();
      expect((await imp.run())[0]).toMatchObject({ status: 'updated' });
      expect(calls.at(-1)!.headers['Auth-Key']).toBe('user-key-0123456789');
      expect(state.get('k')!.needsKey).toBeUndefined();
    });
  }

  it('fails as usual on other errors, and on a refusal when a key was sent', async () => {
    let status = 500;
    const { fetch } = fakeFetch({ 'https://k.test/ips': () => ({ status }) });
    let key: string | undefined = undefined;
    const imp = new FeedImporter(
      [src({ id: 'k', url: 'https://k.test/ips', auth: { key: 'abusech', header: 'Auth-Key' } })],
      memoryStores().lists,
      new MemoryFeedStateStore(),
      { fetch, keys: () => key },
    );
    expect((await imp.run({ force: true }))[0]).toMatchObject({
      status: 'failed',
      error: 'HTTP 500',
    });
    expect(imp.status()[0]!.needsKey).toBeUndefined();
    status = 401;
    key = 'wrong-key-0123456789';
    expect((await imp.run({ force: true }))[0]).toMatchObject({
      status: 'failed',
      error: 'HTTP 401',
    });
    expect(imp.status()[0]).toMatchObject({ lastError: 'HTTP 401' });
    expect(imp.status()[0]!.needsKey).toBeUndefined();
  });

  it('fetches the default keyed feeds without a key', async () => {
    const { fetch, calls } = fakeFetch({});
    const imp = new FeedImporter(
      DEFAULT_FEEDS.filter((f) => f.auth),
      memoryStores().lists,
      new MemoryFeedStateStore(),
      { fetch },
    );
    await imp.run({ force: true });
    expect(calls.map((c) => c.url)).toEqual(DEFAULT_FEEDS.filter((f) => f.auth).map((f) => f.url));
    for (const c of calls) expect(c.headers).not.toHaveProperty('Auth-Key');
  });

  it('runs once when asked again while a run is in progress', async () => {
    const { fetch, calls } = fakeFetch({ 'https://a.test/ips': () => ({ body: '45.9.1.2' }) });
    const imp = new FeedImporter(
      [src({ id: 'a', url: 'https://a.test/ips' })],
      memoryStores().lists,
      new MemoryFeedStateStore(),
      { fetch },
    );
    const [a, b] = await Promise.all([imp.run({ force: true }), imp.run({ force: true })]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  describe('shrink guard', () => {
    const ips = (n: number) => Array.from({ length: n }, (_, i) => `45.9.${i}.1`).join('\n');
    const seeded = async (seed: number) => {
      let body = ips(seed);
      const { fetch } = fakeFetch({ 'https://a.test/ips': () => ({ body }) });
      const stores = memoryStores();
      const imp = new FeedImporter(
        [src({ id: 'a', url: 'https://a.test/ips' })],
        stores.lists,
        new MemoryFeedStateStore(),
        { fetch, confirmWindowMs: 0 },
      );
      expect((await imp.run({ force: true }))[0]!.status).toBe('updated');
      expect(stores.lists.size('known_bad_ips')).toBe(seed);
      const update = async (next: string) => {
        body = next;
        return (await imp.run({ force: true }))[0]!;
      };
      return { imp, stores, update };
    };

    for (const [seed, next] of [
      [100, 10],
      [100, 0],
      [3, 0],
      [100, 49],
    ] as const) {
      it(`refuses ${seed} -> ${next}, keeps the old list and marks the feed stale`, async () => {
        const { imp, stores, update } = await seeded(seed);
        const r = await update(next ? ips(next) : '<html>maintenance</html>');
        expect(r).toMatchObject({ status: 'failed', entries: seed });
        expect(r.error).toMatch(new RegExp(`shrank from ${seed} to ${next}`));
        expect(stores.lists.size('known_bad_ips')).toBe(seed);
        expect(imp.status()[0]).toMatchObject({ heldBack: true, stale: true, entries: seed });
      });
    }

    it('accepts 100 -> 60 and 100 -> 50, and a later good update clears the hold', async () => {
      const { imp, stores, update } = await seeded(100);
      expect(await update(ips(60))).toMatchObject({ status: 'updated', entries: 60 });
      expect(stores.lists.size('known_bad_ips')).toBe(60);
      expect(imp.status()[0]).toMatchObject({ stale: false });
      expect(imp.status()[0]!.heldBack).toBeUndefined();

      await update('');
      expect(imp.status()[0]).toMatchObject({ heldBack: true, stale: true });
      expect(await update(ips(30))).toMatchObject({ status: 'updated', entries: 30 });
      expect(imp.status()[0]!.heldBack).toBeUndefined();
    });

    it('fills an empty stored list', async () => {
      const { stores, update } = await seeded(0);
      expect(await update(ips(5))).toMatchObject({ status: 'updated', entries: 5 });
      expect(stores.lists.size('known_bad_ips')).toBe(5);
    });
  });

  it('accumulates recent-only feeds and expires entries after retainDays', async () => {
    let body = sha('a');
    const { fetch } = fakeFetch({ 'https://h.test/recent': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/recent', list: 'known_bad_sha256', retainDays: 30 })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now, confirmWindowMs: 0 },
    );
    await imp.run();
    body = sha('b');
    now += DAY;
    expect((await imp.run())[0]).toMatchObject({ added: 1, removed: 0, entries: 2 });
    expect(stores.lists.has('known_bad_sha256', sha('a'))).toBe(true);
    now += 30 * DAY;
    expect((await imp.run())[0]).toMatchObject({ removed: 1, entries: 1 });
    expect(stores.lists.has('known_bad_sha256', sha('a'))).toBe(false);
  });

  it("never writes the user's own list and refuses unsafe configuration", () => {
    const lists = memoryStores().lists;
    const st = new MemoryFeedStateStore();
    const bad = (s: Partial<FeedSource>) => () =>
      new FeedImporter([src({ id: 'x', url: 'https://x.test/', ...s })], lists, st, {
        fetch: fakeFetch({}).fetch,
      });
    expect(bad({ list: 'user_blocked_sha256' as never })).toThrow(/may only fill/);
    expect(bad({ url: 'http://x.test/' })).toThrow(/https/);
    expect(bad({ id: 'Bad Id' })).toThrow(/lowercase/);
  });

  it('leaves the user-blocked list alone when rebuilding', async () => {
    const stores = memoryStores();
    stores.lists.add('user_blocked_sha256', sha('d'), { source: 'user', updatedAt: T0 });
    const { fetch } = fakeFetch({ 'https://h.test/': () => ({ body: sha('a') }) });
    await new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/', list: 'known_bad_sha256' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch },
    ).run();
    expect(stores.lists.has('user_blocked_sha256', sha('d'))).toBe(true);
  });

  it('feeds the known-bad rules: an IP hit blocks, a domain hit asks', async () => {
    const stores = memoryStores();
    const { fetch } = fakeFetch({
      'https://a.test/ips': () => ({ body: '45.9.1.2' }),
      'https://a.test/hosts': () => ({ body: '0.0.0.0 payload.evil.example' }),
    });
    await new FeedImporter(
      [
        src({ id: 'ips', url: 'https://a.test/ips' }),
        src({
          id: 'hosts',
          url: 'https://a.test/hosts',
          list: 'known_bad_domains',
          format: 'hosts',
        }),
      ],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, confirmWindowMs: 0 },
    ).run();
    const engine = new DetectionEngine(macosCoreRules, stores);
    const tool = proc({ path: '/Users/alex/Downloads/tool', pid: 4242, signing: 'unsigned' });
    const ip = engine
      .evaluate(connect(tool, '45.9.1.2'))
      .find((d) => d.match.ruleId === 'known-bad-destination');
    expect(ip?.execute).toEqual([{ kind: 'network.block', address: '45.9.1.2' }]);
    const dom = engine
      .evaluate(connect(chrome, '104.16.1.1', 'cdn.payload.evil.example'))
      .find((d) => d.match.ruleId === 'known-bad-domain');
    expect(dom?.execute).toEqual([]);
    expect(dom?.propose).toEqual([{ kind: 'network.block', address: '104.16.1.1' }]);
  });

  it('persists feed state in SQLite', async () => {
    const db = new DatabaseSync(':memory:') as unknown as SqlDatabase;
    const { fetch } = fakeFetch({
      'https://a.test/ips': () => ({ body: '45.9.1.2', etag: '"e"' }),
    });
    const s1 = sqliteStores(db);
    await new FeedImporter([src({ id: 'a', url: 'https://a.test/ips' })], s1.lists, s1.feeds, {
      fetch,
      confirmWindowMs: 0,
    }).run();
    const s2 = sqliteStores(db);
    expect(s2.feeds.get('a')).toMatchObject({
      etag: '"e"',
      entries: { '45.9.1.2': expect.any(Number) },
    });
    expect(s2.lists.has('known_bad_ips', '45.9.1.2')).toBe(true);
  });

  it('ships valid default sources', () => {
    expect(
      () =>
        new FeedImporter(DEFAULT_FEEDS, memoryStores().lists, new MemoryFeedStateStore(), {
          fetch: fakeFetch({}).fetch,
        }),
    ).not.toThrow();
    expect(new Set(DEFAULT_FEEDS.map((f) => f.list))).toEqual(
      new Set(['known_bad_ips', 'known_bad_domains', 'known_bad_sha256']),
    );
    // URLhaus and MalwareBazaar take the user's own abuse.ch key if they add one; none is shipped.
    expect(DEFAULT_FEEDS.filter((f) => f.auth).map((f) => f.id)).toEqual([
      'urlhaus-hosts',
      'malwarebazaar-recent',
    ]);
    for (const f of DEFAULT_FEEDS) expect(f.headers).toBeUndefined();
  });
});

describe('pending window and growth guard', () => {
  /** One /24 block of listable IPs: block(0, 10) → 45.9.0.1 … 45.9.0.10. */
  const block = (o: number, n: number) =>
    Array.from({ length: n }, (_, i) => `45.9.${o}.${i + 1}`).join('\n');

  const hashImporter = (
    lists: ReturnType<typeof memoryStores>['lists'],
    state: FeedStateStore,
    fetch: FetchLike,
    now: () => number,
  ) =>
    new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/hashes', list: 'known_bad_sha256' })],
      lists,
      state,
      { fetch, now },
    );

  it('holds a brand-new hash until the window passes, then the sweep promotes it', async () => {
    const { fetch } = fakeFetch({ 'https://h.test/hashes': () => ({ body: sha('a') }) });
    let now = T0;
    const stores = memoryStores();
    const imp = hashImporter(stores.lists, new MemoryFeedStateStore(), fetch, () => now);

    const r = (await imp.run())[0]!;
    expect(r).toMatchObject({ status: 'updated', entries: 0, added: 1 });
    // Nothing reached the list the helper enforces.
    expect(stores.lists.size('known_bad_sha256')).toBe(0);
    expect(imp.status()[0]).toMatchObject({ entries: 0, pending: 1 });

    // Still held inside the window, however often the feed repeats itself —
    // and the first listing, not the latest one, starts the clock.
    now += 23 * HOUR;
    await imp.run({ force: true });
    expect(stores.lists.size('known_bad_sha256')).toBe(0);

    now += 2 * HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 1 });
    expect(stores.lists.has('known_bad_sha256', sha('a'))).toBe(true);
    expect(imp.status()[0]).toMatchObject({ entries: 1 });
    expect(imp.status()[0]!.pending).toBeUndefined();
  });

  it('lets entries the feed already listed straight in and holds only new ones', async () => {
    let body = sha('a');
    const { fetch } = fakeFetch({ 'https://h.test/hashes': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const imp = hashImporter(stores.lists, new MemoryFeedStateStore(), fetch, () => now);

    await imp.run();
    expect(stores.lists.size('known_bad_sha256')).toBe(0);

    // Once a's window has passed it enforces, while the newer b waits its own.
    body = `${sha('a')}\n${sha('b')}`;
    now += 25 * HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 1 });
    expect(stores.lists.has('known_bad_sha256', sha('a'))).toBe(true);
    expect(stores.lists.has('known_bad_sha256', sha('b'))).toBe(false);
    expect(imp.status()[0]!.pending).toBe(1);

    now += DAY;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 2 });
    expect(stores.lists.has('known_bad_sha256', sha('b'))).toBe(true);
  });

  it('alerts when a promotion more than doubles the active set, then clears', async () => {
    let body = block(0, 10);
    const { fetch } = fakeFetch({ 'https://h.test/ips': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now },
    );

    await imp.run(); // the feed's first listing: ten held entries
    // A first fill is free: there was nothing to double.
    now += DAY + HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 10 });
    expect(imp.status()[0]!.growthAlert).toBeUndefined();

    // Twenty-five more wait out their window, then promote in one go: 10 → 35.
    body = `${block(0, 10)}\n${block(1, 25)}`;
    now += HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 10 });
    expect(imp.status()[0]!.pending).toBe(25);

    now += DAY + HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 35 });
    expect(imp.status()[0]!.growthAlert).toBe(true);

    // The next accepted update clears the alert, as it clears the shrink hold.
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated' });
    expect(imp.status()[0]!.growthAlert).toBeUndefined();
  });

  it('stays quiet while growth stays within the ratio', async () => {
    let body = block(0, 10);
    const { fetch } = fakeFetch({ 'https://h.test/ips': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now },
    );

    await imp.run();
    now += DAY + HOUR;
    await imp.run({ force: true }); // first fill: 10 active
    body = `${block(0, 10)}\n${block(1, 5)}`;
    now += HOUR;
    await imp.run({ force: true }); // 5 more wait out their window
    now += DAY + HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'updated', entries: 15 });
    expect(imp.status()[0]!.growthAlert).toBeUndefined();
  });

  it('promotes held entries even while their feed is failing', async () => {
    let status = 200;
    const { fetch } = fakeFetch({
      'https://h.test/hashes': () => ({ status, body: status === 200 ? sha('a') : 'down' }),
    });
    let now = T0;
    const stores = memoryStores();
    const imp = hashImporter(stores.lists, new MemoryFeedStateStore(), fetch, () => now);

    await imp.run(); // held pending
    status = 500;
    now += DAY + HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({ status: 'failed' });
    // The window had passed, so the entry enforces anyway.
    expect(stores.lists.has('known_bad_sha256', sha('a'))).toBe(true);
    expect(imp.status()[0]!.pending).toBeUndefined();
  });

  it('drops a held entry its feed retracts before the window passed', async () => {
    let body = sha('a');
    const { fetch } = fakeFetch({ 'https://h.test/hashes': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const state = new MemoryFeedStateStore();
    const imp = hashImporter(stores.lists, state, fetch, () => now);

    await imp.run(); // a held pending
    body = sha('b');
    now += HOUR;
    expect((await imp.run({ force: true }))[0]).toMatchObject({
      status: 'updated',
      entries: 0,
      added: 1,
    });
    // A replace-mode feed that stops listing an entry speaks: a was retracted
    // before it could enforce anything, and b restarts the window from now.
    expect(state.get('h')?.pending).toEqual({ [sha('b')]: T0 + HOUR });
  });

  it('keeps the shrink guard and pending entries working together', async () => {
    let body = block(0, 10);
    const { fetch } = fakeFetch({ 'https://h.test/ips': () => ({ body }) });
    let now = T0;
    const stores = memoryStores();
    const imp = new FeedImporter(
      [src({ id: 'h', url: 'https://h.test/ips' })],
      stores.lists,
      new MemoryFeedStateStore(),
      { fetch, now: () => now },
    );

    await imp.run(); // 10 pending
    now += DAY + HOUR;
    await imp.run({ force: true }); // promoted: 10 active, first fill
    body = `${block(0, 10)}\n${block(1, 5)}`;
    now += HOUR;
    await imp.run({ force: true }); // 5 more held pending
    body = block(0, 1); // the feed collapses
    now += HOUR;
    const r = (await imp.run({ force: true }))[0]!;
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.error).toMatch(/shrank from 10 to 1/);
    expect(imp.status()[0]).toMatchObject({ heldBack: true, entries: 10, pending: 5 });
    expect(stores.lists.size('known_bad_ips')).toBe(10);
  });

  it('keeps pending entries across a restart', async () => {
    const db = new DatabaseSync(':memory:') as unknown as SqlDatabase;
    const { fetch } = fakeFetch({ 'https://h.test/hashes': () => ({ body: sha('a') }) });
    const s1 = sqliteStores(db);
    await hashImporter(s1.lists, s1.feeds, fetch, Date.now).run();
    expect(s1.lists.size('known_bad_sha256')).toBe(0);

    // A fresh store over the same database sees the held entry, still held.
    const s2 = sqliteStores(db);
    expect(s2.feeds.get('h')?.pending).toEqual({ [sha('a')]: expect.any(Number) });
    expect(s2.lists.size('known_bad_sha256')).toBe(0);
  });
});
