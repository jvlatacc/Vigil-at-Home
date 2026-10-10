import type { ListStore } from '../state/stores.js';
import { parseFeed } from './parse.js';
import type { FeedKeyName, FeedList, FeedSource } from './sources.js';
import { cleanEntries, type CleanOptions, type DropReason } from './validate.js';

/** What the importer remembers per source between runs. */
export interface FeedState {
  sourceId: string;
  /** Entry → last time the feed listed it (ms). */
  entries: Record<string, number>;
  /**
   * Entry → when this source first listed it (ms). A brand-new entry waits
   * here for the confirm window before it joins `entries` and can enforce
   * anything, so a tampered feed cannot steer containment the moment it is
   * compromised. The sweep promotes these; a feed that stops listing an entry
   * before its window passed retracts it.
   */
  pending?: Record<string, number>;
  etag?: string;
  lastModified?: string;
  /** Last successful fetch (including "not modified"). */
  fetchedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** The provider refused a request sent without a key (401/403); cleared by any other answer. */
  needsKey?: boolean;
  /**
   * The last update would have shrunk the stored list by more than half or
   * emptied it, so it was refused and the old list kept. Cleared by the next
   * accepted update (or "not modified").
   */
  heldBack?: boolean;
  /**
   * The last promotion more than doubled this source's active set — the shape
   * of a tampered feed cashing in held entries. Cleared by the next accepted
   * update (or "not modified"), like `heldBack`.
   */
  growthAlert?: boolean;
}

export interface FeedStateStore {
  get(sourceId: string): FeedState | undefined;
  put(state: FeedState): void;
  all(): FeedState[];
}

export class MemoryFeedStateStore implements FeedStateStore {
  private readonly states = new Map<string, FeedState>();
  get(sourceId: string): FeedState | undefined {
    const s = this.states.get(sourceId);
    if (!s) return undefined;
    const { pending, ...rest } = s;
    return {
      ...rest,
      entries: { ...s.entries },
      // The nested maps are copies, like `entries`: callers may hold a state
      // and mutate it without reaching into the store.
      ...(pending && { pending: { ...pending } }),
    };
  }
  put(state: FeedState): void {
    const { pending, ...rest } = state;
    this.states.set(state.sourceId, {
      ...rest,
      entries: { ...state.entries },
      ...(pending && { pending: { ...pending } }),
    });
  }
  all(): FeedState[] {
    return [...this.states.values()];
  }
}

/** The part of the WHATWG fetch API the importer uses; the app passes globalThis.fetch. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'manual' },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface FeedImporterOptions extends CleanOptions {
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Refuse bodies larger than this. */
  maxBytes?: number;
  /** Refuse a feed listing more entries than this. */
  maxEntries?: number;
  /**
   * A replace-mode feed that suddenly lists less than this share of what it
   * listed before is treated as broken and its old entries are kept, at any
   * list size. An update that would empty a stored list is always refused.
   */
  minShrinkRatio?: number;
  /**
   * How long a brand-new entry waits before it can enforce anything, counted
   * from the first time a feed listed it (FEED-01). The default is a day;
   * entries a feed already listed join straight away.
   */
  confirmWindowMs?: number;
  /**
   * When the active set grows by more than this share in one promotion, the
   * growth alert is raised on the same channel as a held-back update.
   * 1 means "more than doubled". A source's first fill never alerts.
   */
  maxGrowthRatio?: number;
  /**
   * The user's key for a feed that can take one (FeedSource.auth), read on
   * every run so a key added or removed takes effect at once. Main process only.
   */
  keys?: (name: FeedKeyName) => string | undefined;
}

export interface FeedRunResult {
  sourceId: string;
  /** `needs_key`: refused without a key; kept as it was until the user adds one. Not an error. */
  status: 'updated' | 'not_modified' | 'skipped' | 'needs_key' | 'failed';
  /** Entries this source now contributes. */
  entries: number;
  added?: number;
  removed?: number;
  dropped?: Partial<Record<DropReason, number>>;
  error?: string;
}

export interface FeedStatus {
  sourceId: string;
  name: string;
  list: FeedList;
  entries: number;
  fetchedAt?: number;
  lastError?: string;
  /** The user key this feed can take (FeedSource.auth), if any. */
  keyName?: FeedKeyName;
  /** Refused without a key, so off until the user adds one. Its stored entries still count. */
  needsKey?: boolean;
  /** Its last update was refused for shrinking the list too far; the old list is kept. */
  heldBack?: boolean;
  /** Entries held for the confirm window before they can enforce anything. */
  pending?: number;
  /** The last promotion more than doubled the active set; shown like the shrink hold. */
  growthAlert?: boolean;
  /**
   * No successful fetch for three intervals, or the last update was held back.
   * Never set while the feed needs a key.
   */
  stale: boolean;
  nextDueAt: number;
}

const FEED_LISTS: readonly FeedList[] = ['known_bad_sha256', 'known_bad_domains', 'known_bad_ips'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Redirects followed for a request that carries the user's key. */
const MAX_KEYED_REDIRECTS = 3;

/**
 * Keeps the known-bad lists current. Each source's entries are kept
 * separately, validated, and combined into its list, so one broken feed never
 * empties a list another feed also fills. Feeds can only write the three
 * known_bad_* lists; the user's own blocked-hash list is never touched.
 *
 * A brand-new entry waits out a confirm window in `pending` before it can
 * enforce anything, so a tampered feed cannot steer containment the moment it
 * is compromised; unusually fast growth after promotion raises the growth
 * alert, on the same channel as a held-back update.
 *
 * Nothing here runs on the inline path: the app calls `run()` on a timer, and
 * the engine sees the new lists on its next lookup.
 */
export class FeedImporter {
  private readonly sources: FeedSource[];
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  /** The run in progress, so a run asked for meanwhile joins it instead of fetching twice. */
  private running: Promise<FeedRunResult[]> | undefined;
  private readonly opts: Required<
    Pick<
      FeedImporterOptions,
      | 'timeoutMs'
      | 'maxBytes'
      | 'maxEntries'
      | 'minShrinkRatio'
      | 'confirmWindowMs'
      | 'maxGrowthRatio'
    >
  >;

  constructor(
    sources: readonly FeedSource[],
    private readonly lists: ListStore,
    private readonly state: FeedStateStore,
    private readonly options: FeedImporterOptions = {},
  ) {
    const seen = new Set<string>();
    for (const s of sources) {
      if (!ID_RE.test(s.id))
        throw new Error(`feed id "${s.id}" must be lowercase letters, digits and dashes`);
      if (seen.has(s.id)) throw new Error(`feed id "${s.id}" is used twice`);
      seen.add(s.id);
      if (!FEED_LISTS.includes(s.list))
        throw new Error(`feed ${s.id}: feeds may only fill ${FEED_LISTS.join(', ')}`);
      if (!/^https:\/\//.test(s.url)) throw new Error(`feed ${s.id}: only https URLs are allowed`);
      if (!(s.intervalHours > 0)) throw new Error(`feed ${s.id}: intervalHours must be positive`);
    }
    this.sources = [...sources];
    const f = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('no fetch available');
    this.fetch = f;
    this.now = options.now ?? Date.now;
    this.opts = {
      timeoutMs: options.timeoutMs ?? 60_000,
      maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
      maxEntries: options.maxEntries ?? 1_000_000,
      minShrinkRatio: options.minShrinkRatio ?? 0.5,
      confirmWindowMs: options.confirmWindowMs ?? 86_400_000,
      maxGrowthRatio: options.maxGrowthRatio ?? 1,
    };
  }

  private dueAt(s: FeedSource): number {
    const st = this.state.get(s.id);
    const last = Math.max(st?.fetchedAt ?? 0, st?.lastAttemptAt ?? 0);
    if (!last) return 0;
    // Refused for want of a key and the user has since added one: try it straight away.
    if (st?.needsKey && this.keyFor(s) !== undefined) return 0;
    // After a failure, retry within the hour rather than waiting a full interval.
    const failed = st?.lastError !== undefined && (st.lastAttemptAt ?? 0) >= (st.fetchedAt ?? 0);
    const interval = s.intervalHours * 3_600_000;
    const wait = failed ? Math.min(3_600_000, interval) : interval;
    return last + wait;
  }

  /** The user's key for a source that can take one, if they added it. */
  private keyFor(s: FeedSource): string | undefined {
    return (s.auth && this.options.keys?.(s.auth.key)) || undefined;
  }

  /** Refused without a key on its last try, and still no key. */
  private needsKey(s: FeedSource, st: FeedState | undefined): boolean {
    return !!st?.needsKey && this.keyFor(s) === undefined;
  }

  /**
   * Fetch every source that is due (or all of them with `force`), then rebuild
   * the affected lists. A source refused for want of a key keeps its entries
   * in the list as they were.
   */
  run(opts: { force?: boolean } = {}): Promise<FeedRunResult[]> {
    this.running ??= this.runAll(opts).finally(() => (this.running = undefined));
    return this.running;
  }

  private async runAll(opts: { force?: boolean }): Promise<FeedRunResult[]> {
    const now = this.now();
    const results: FeedRunResult[] = [];
    const touched = new Set<FeedList>();
    for (const s of this.sources) {
      if (!opts.force && this.dueAt(s) > now) {
        results.push({
          sourceId: s.id,
          status: 'skipped',
          entries: Object.keys(this.state.get(s.id)?.entries ?? {}).length,
        });
        continue;
      }
      const r = await this.fetchSource(s, now);
      results.push(r);
      if (r.status === 'updated') touched.add(s.list);
    }
    // Promotions are time-driven, not fetch-driven: an entry whose window has
    // passed joins its list even when today's fetch failed or was not due.
    for (const list of this.sweep(now)) touched.add(list);
    // Results report what the source's stored list holds once the sweep has
    // run — a same-run promotion (a zero confirm window) shows up here too.
    for (const r of results)
      r.entries = Object.keys(this.state.get(r.sourceId)?.entries ?? {}).length;
    for (const list of touched) this.rebuild(list, now);
    return results;
  }

  /**
   * Move every pending entry whose confirm window has passed into its
   * source's active set, and report which lists changed. A promotion that
   * more than doubles a source's active set — the shape of a tampered feed
   * cashing in held entries — raises the growth alert on the same channel as
   * a held-back update; a source's first fill never alerts.
   */
  private sweep(now: number): FeedList[] {
    const changed: FeedList[] = [];
    for (const s of this.sources) {
      const st = this.state.get(s.id);
      if (!st?.pending) continue;
      const matured: Record<string, number> = {};
      let waiting: Record<string, number> | undefined;
      for (const [e, firstSeen] of Object.entries(st.pending)) {
        if (firstSeen + this.opts.confirmWindowMs <= now) matured[e] = now;
        else (waiting ??= {})[e] = firstSeen;
      }
      if (Object.keys(matured).length === 0) continue;
      const prevCount = Object.keys(st.entries).length;
      const next: FeedState = { ...st, entries: { ...st.entries, ...matured } };
      if (prevCount > 0 && Object.keys(matured).length > prevCount * this.opts.maxGrowthRatio)
        next.growthAlert = true;
      if (waiting) next.pending = waiting;
      else delete next.pending;
      this.state.put(next);
      if (!changed.includes(s.list)) changed.push(s.list);
    }
    return changed;
  }

  /** Rebuild every feed list from stored state, e.g. after a source is removed from the config. */
  rebuildAll(): void {
    for (const list of FEED_LISTS) this.rebuild(list, this.now());
  }

  status(): FeedStatus[] {
    const now = this.now();
    return this.sources.map((s) => {
      const st = this.state.get(s.id);
      const needsKey = this.needsKey(s, st);
      const out: FeedStatus = {
        sourceId: s.id,
        name: s.name,
        list: s.list,
        entries: Object.keys(st?.entries ?? {}).length,
        stale:
          !needsKey &&
          (!!st?.heldBack ||
            !st?.fetchedAt ||
            now - st.fetchedAt > 3 * s.intervalHours * 3_600_000),
        nextDueAt: this.dueAt(s),
      };
      if (s.auth) out.keyName = s.auth.key;
      if (needsKey) out.needsKey = true;
      if (st?.heldBack) out.heldBack = true;
      if (st?.growthAlert) out.growthAlert = true;
      const pendingCount = Object.keys(st?.pending ?? {}).length;
      if (pendingCount > 0) out.pending = pendingCount;
      if (st?.fetchedAt !== undefined) out.fetchedAt = st.fetchedAt;
      // An error from before the feed was refused for want of a key is no longer news.
      if (st?.lastError !== undefined && !needsKey) out.lastError = st.lastError;
      return out;
    });
  }

  private rebuild(list: FeedList, now: number): void {
    const union = new Set<string>();
    for (const s of this.sources) {
      if (s.list !== list) continue;
      for (const e of Object.keys(this.state.get(s.id)?.entries ?? {})) union.add(e);
    }
    this.lists.replace(list, union, { source: 'feeds', updatedAt: now });
  }

  /**
   * GET a feed. A request carrying the user's key (`keyed`) does not
   * let fetch follow redirects: it follows up to a few itself, and only while
   * they stay on the same https origin (scheme, host and port), so the key is
   * only ever sent to the site it was meant for. A redirect anywhere else, or
   * to plain http, is an error and is not requested.
   */
  private async get(
    url: string,
    headers: Record<string, string>,
    keyed: boolean,
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    if (!keyed) return this.fetch(url, { headers, signal });
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      const res = await this.fetch(current.href, { headers, signal, redirect: 'manual' });
      // An opaque redirect (status 0) hides where it goes, so it cannot be checked.
      if (res.status === 0) throw new Error('feed redirected somewhere that cannot be checked');
      if (!REDIRECT_STATUSES.has(res.status)) return res;
      if (hop >= MAX_KEYED_REDIRECTS) throw new Error('feed redirected too many times');
      const location = res.headers.get('location');
      if (!location) throw new Error(`HTTP ${res.status} without a redirect location`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('feed redirected to an invalid address');
      }
      if (next.protocol !== 'https:' || next.origin !== current.origin)
        throw new Error('feed redirected to another site; not following it with the key');
      current = next;
    }
  }

  private async fetchSource(s: FeedSource, now: number): Promise<FeedRunResult> {
    const prev: FeedState = this.state.get(s.id) ?? { sourceId: s.id, entries: {} };
    // Any answer other than a keyless refusal settles that the feed doesn't need a key.
    delete prev.needsKey;
    const fail = (error: string): FeedRunResult => {
      this.state.put({ ...prev, lastAttemptAt: now, lastError: error });
      return { sourceId: s.id, status: 'failed', entries: Object.keys(prev.entries).length, error };
    };

    const key = this.keyFor(s);
    const headers: Record<string, string> = { ...(s.headers ?? {}) };
    if (s.auth && key) headers[s.auth.header] = key;
    if (prev.etag) headers['If-None-Match'] = prev.etag;
    if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;

    let text: string;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.get(s.url, headers, !!(s.auth && key));
      if (res.status === 304) {
        const st: FeedState = { ...prev, fetchedAt: now, lastAttemptAt: now };
        delete st.lastError;
        // Unchanged since the list that was accepted, so nothing is held back
        // any more and an old growth alert clears with it.
        delete st.heldBack;
        delete st.growthAlert;
        this.state.put(st);
        return {
          sourceId: s.id,
          status: 'not_modified',
          entries: Object.keys(prev.entries).length,
        };
      }
      if (s.auth && !key && (res.status === 401 || res.status === 403)) {
        // The provider wants a key now. Not a failure: entries, list and fetch times stay put
        // until the user adds one; only the attempt is noted so it is retried at the usual pace.
        const st: FeedState = { ...prev, lastAttemptAt: now, needsKey: true };
        delete st.lastError;
        this.state.put(st);
        return { sourceId: s.id, status: 'needs_key', entries: Object.keys(prev.entries).length };
      }
      if (res.status !== 200) return fail(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > this.opts.maxBytes) return fail(`feed is larger than ${this.opts.maxBytes} bytes`);
      text = await res.text();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (text.length > this.opts.maxBytes)
      return fail(`feed is larger than ${this.opts.maxBytes} bytes`);

    const { entries, dropped } = cleanEntries(s.list, parseFeed(text, s.format), this.options);
    if (entries.length > this.opts.maxEntries)
      return fail(`feed lists more than ${this.opts.maxEntries} entries`);

    // A replace-mode update that would cut the stored list by more than half, or empty it,
    // looks like a broken download rather than real removals, whatever the list's size.
    // An empty stored list is free to fill.
    const prevCount = Object.keys(prev.entries).length;
    if (
      s.retainDays === 0 &&
      prevCount > 0 &&
      (entries.length === 0 || entries.length < prevCount * this.opts.minShrinkRatio)
    ) {
      const error = `feed shrank from ${prevCount} to ${entries.length} entries; keeping the old list`;
      this.state.put({ ...prev, lastAttemptAt: now, lastError: error, heldBack: true });
      return { sourceId: s.id, status: 'failed', entries: prevCount, error };
    }

    const next: Record<string, number> = {};
    // A working copy: prev must stay untouched so `added` below can measure
    // against the state as it was before this import.
    const prevPending = { ...prev.pending };
    if (s.retainDays > 0) {
      const cutoff = now - s.retainDays * 86_400_000;
      for (const [e, seen] of Object.entries(prev.entries)) if (seen >= cutoff) next[e] = seen;
    }
    // Entries the feed already listed stay active and refresh in place; a
    // brand-new one waits out the confirm window in `pending` — keeping its
    // first listing, however often the feed repeats it — and only the sweep
    // promotes it.
    for (const e of entries) {
      if (e in prev.entries) next[e] = now;
      else if (!(e in prevPending)) prevPending[e] = now;
    }
    // A held entry the feed stops listing is retracted before it ever
    // enforced anything: a replace-mode feed says so by leaving it out, and
    // a rolling feed's window bounds how long a one-off listing can wait.
    if (s.retainDays === 0) {
      const listed = new Set(entries);
      for (const e of Object.keys(prevPending)) if (!listed.has(e)) delete prevPending[e];
    } else {
      const pendingCutoff = now - s.retainDays * 86_400_000;
      for (const [e, firstSeen] of Object.entries(prevPending))
        if (firstSeen < pendingCutoff) delete prevPending[e];
    }

    // Counted against the previous state, not the one being built: the loop
    // above has already filed the new listings into `prevPending`.
    const added = entries.filter(
      (e) => !(e in prev.entries) && !(e in (prev.pending ?? {})),
    ).length;
    const removed = Object.keys(prev.entries).filter((e) => !(e in next)).length;
    const st: FeedState = { sourceId: s.id, entries: next, fetchedAt: now, lastAttemptAt: now };
    if (Object.keys(prevPending).length > 0) st.pending = prevPending;
    const etag = res.headers.get('etag');
    const lastModified = res.headers.get('last-modified');
    if (etag) st.etag = etag;
    if (lastModified) st.lastModified = lastModified;
    this.state.put(st);
    return {
      sourceId: s.id,
      status: 'updated',
      entries: Object.keys(next).length,
      added,
      removed,
      dropped,
    };
  }
}
