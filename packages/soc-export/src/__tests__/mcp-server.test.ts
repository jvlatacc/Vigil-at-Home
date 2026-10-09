import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AlertStore } from '../mcp/alert-store.js';
import {
  MAX_RESULT_BYTES,
  SOC_MCP_NAME,
  SOC_MCP_VERSION,
  buildSocMcpServer,
} from '../mcp/server.js';
import { FIXTURE_MACHINE_ID, TEST_NAMES } from './fixtures.js';
import {
  BIG_ALERT_ID,
  CALM_ALERT_ID,
  FIXTURE_TOKEN,
  HOSTILE_ALERT_ID,
  MISSING_ID,
  NOW,
  OVERSIZE_MARKER,
  RESOLVED_ALERT_ID,
  fixtureFileDb,
  fixtureMemoryDb,
  removeFixtureDb,
} from './mcp-fixture-db.js';

/** Nothing personal may survive into a tool answer. */
const FORBIDDEN = [TEST_NAMES.username, TEST_NAMES.hostname, FIXTURE_TOKEN, 'hunter2'] as const;

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function expectClean(text: string): void {
  for (const token of FORBIDDEN) expect(text).not.toContain(token);
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  // The JSON answer is the first block; send()'s counts-only note is a second.
  const first = (result.content ?? [])[0] as { type: 'text'; text: string } | undefined;
  expect(first?.type).toBe('text');
  expect(() => JSON.parse(first!.text)).not.toThrow(); // a reply cut mid-string would not parse
  return JSON.parse(first!.text) as Record<string, unknown>;
}

function inMemoryClient(): { client: Client; close: () => void } {
  const store = new AlertStore(fixtureMemoryDb());
  const server = buildSocMcpServer(store, {
    names: TEST_NAMES,
    machineId: FIXTURE_MACHINE_ID,
    now: () => NOW,
  });
  const client = new Client({ name: 'soc-mcp-test', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  void client.connect(clientTransport);
  return {
    client,
    close: () => {
      void client.close();
      void server.close();
      store.close();
    },
  };
}

describe('SocMcpTools (in-process over InMemoryTransport)', () => {
  let harness: ReturnType<typeof inMemoryClient> | undefined;

  afterAll(() => harness?.close());

  it('exposes exactly the three read-only tools', async () => {
    harness = inMemoryClient();
    const { tools } = await harness.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_alert',
      'get_alert_evidence',
      'list_recent_alerts',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('lists alerts in the window, newest first, redacted', async () => {
    const result = (await harness!.client.callTool({
      name: 'list_recent_alerts',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expectClean(text);
    const body = jsonOf(result);
    expect(body.count).toBe(4); // all four fixtures are inside the 24 h default window
    const alerts = body.alerts as Array<Record<string, unknown>>;
    expect(alerts.map((a) => a.id)).toEqual([
      BIG_ALERT_ID,
      HOSTILE_ALERT_ID,
      CALM_ALERT_ID,
      RESOLVED_ALERT_ID,
    ]);
  });

  it('narrows by since_min, severity, and limit', async () => {
    const narrow = (await harness!.client.callTool({
      name: 'list_recent_alerts',
      arguments: { since_min: 2 },
    })) as CallToolResult;
    const narrowAlerts = jsonOf(narrow).alerts as Array<Record<string, unknown>>;
    expect(narrowAlerts.map((a) => a.id)).toEqual([BIG_ALERT_ID]);

    const high = (await harness!.client.callTool({
      name: 'list_recent_alerts',
      arguments: { severity: 'high' },
    })) as CallToolResult;
    const highBody = jsonOf(high);
    expect((highBody.alerts as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([
      HOSTILE_ALERT_ID,
    ]);
    expectClean(textOf(high));

    const limited = (await harness!.client.callTool({
      name: 'list_recent_alerts',
      arguments: { limit: 1 },
    })) as CallToolResult;
    const limitedBody = jsonOf(limited);
    expect(limitedBody.count).toBe(1);
    expect(limitedBody.more).toBe(true);
  });

  it('returns one alert in full, redacted, with its machine id', async () => {
    const result = (await harness!.client.callTool({
      name: 'get_alert',
      arguments: { id: HOSTILE_ALERT_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expectClean(text);
    const body = jsonOf(result);
    expect(body.host).toBe(FIXTURE_MACHINE_ID);
    const alert = body.alert as Record<string, unknown>;
    expect(alert.id).toBe(HOSTILE_ALERT_ID);
    expect(alert.rule).toBe('persistence.unsigned-launch-agent@3');
    expect(alert.severity).toBe('high');
    // The subject path kept its shape but lost the username, even in the
    // hyphenated file name the word-boundary redactor would keep.
    const subject = alert.subject as Record<string, unknown>;
    expect(subject.path).toContain('/Users/<user>/');
  });

  it('answers an unknown id with an error that points back at the list tool', async () => {
    const result = (await harness!.client.callTool({
      name: 'get_alert',
      arguments: { id: MISSING_ID },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('list_recent_alerts');
  });

  it('serves evidence oldest first, redacted', async () => {
    const result = (await harness!.client.callTool({
      name: 'get_alert_evidence',
      arguments: { id: HOSTILE_ALERT_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expectClean(text);
    const body = jsonOf(result);
    expect((body.alert as Record<string, unknown>).id).toBe(HOSTILE_ALERT_ID);
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.id)).toEqual(['evt-hostile-1']);
    // The recorded argv held a bearer token; the answer must not. The redactor
    // either token-replaces (<redacted>) or withholds the whole field.
    expect(text).toMatch(/<redacted>|withheld/);
    expect(text).not.toContain(FIXTURE_TOKEN);
  });

  it('withholds oversize evidence whole — no fragment, never truncated mid-secret', async () => {
    const result = (await harness!.client.callTool({
      name: 'get_alert_evidence',
      arguments: { id: BIG_ALERT_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain(OVERSIZE_MARKER); // not even a fragment
    expect(text).not.toContain('更多信息');
    expectClean(text);
    const body = jsonOf(result); // parses whole ⇒ no mid-string cut
    const events = body.events as Array<Record<string, unknown>>;
    // The oversize field is withheld WHOLE — no fragment of it may appear —
    // while the event's small skeleton (id, kind, ts) may remain readable.
    const raw = events.find((e) => e.id === 'evt-big-1')?.raw;
    expect(raw === undefined || (typeof raw === 'string' && raw.startsWith('[withheld'))).toBe(
      true,
    );
    expect(result.content!.length).toBe(2); // the answer, then the counts-only note
    expect((result.content![1] as { text: string }).text).toMatch(/left out whole|withheld unread/);
    expect(
      Buffer.byteLength((result.content![0] as { text: string }).text, 'utf8'),
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('reports the window it searched', async () => {
    const result = (await harness!.client.callTool({
      name: 'list_recent_alerts',
      arguments: {},
    })) as CallToolResult;
    const body = jsonOf(result);
    const window = body.window as { since: string; until: string };
    expect(Date.parse(window.until)).toBe(NOW);
    expect(Date.parse(window.since)).toBe(NOW - 24 * 60 * 60_000);
  });
});

describe('soc MCP server over stdio (spawned like Vigil SOC runs it)', () => {
  let dir: string | undefined;
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;

  afterAll(async () => {
    await client?.close();
    if (dir) removeFixtureDb(dir);
  });

  function startStdio(dbPath: string): Client {
    const mainTs = fileURLToPath(new URL('../mcp/main.ts', import.meta.url));
    const env = { ...process.env } as Record<string, string | undefined>;
    delete env.NODE_OPTIONS; // vitest's options must not leak into the server
    transport = new StdioClientTransport({
      command: process.execPath,
      // Pin the fixture's local names: production derives them from the
      // machine; the test proves the spawned server scrubs what it is told.
      args: [
        '--import',
        'tsx',
        mainTs,
        `--db=${dbPath}`,
        `--username=${TEST_NAMES.username}`,
        `--hostname=${TEST_NAMES.hostname}`,
      ],
      env: env as Record<string, string>,
    });
    client = new Client({ name: 'soc-mcp-test', version: '0.0.1' });
    return client;
  }

  it(
    'initializes, names itself, and lists its tools over a real pipe',
    { timeout: 60_000 },
    async () => {
      const file = fixtureFileDb();
      dir = file.dir;
      const c = startStdio(file.path);
      await c.connect(transport!);
      expect(c.getServerVersion()).toMatchObject({
        name: SOC_MCP_NAME,
        version: SOC_MCP_VERSION,
      });
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'get_alert',
        'get_alert_evidence',
        'list_recent_alerts',
      ]);
    },
  );

  it(
    'answers list_recent_alerts from the fixture database, redacted',
    { timeout: 30_000 },
    async () => {
      const result = (await client!.callTool({
        name: 'list_recent_alerts',
        arguments: { since_min: 60 },
      })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expectClean(text);
      const body = jsonOf(result);
      expect((body.alerts as Array<Record<string, unknown>>).map((a) => a.id)).toEqual([
        BIG_ALERT_ID,
        HOSTILE_ALERT_ID,
      ]);
    },
  );

  it('withholds the oversize evidence whole across the pipe', { timeout: 30_000 }, async () => {
    const result = (await client!.callTool({
      name: 'get_alert_evidence',
      arguments: { id: BIG_ALERT_ID },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain(OVERSIZE_MARKER);
    expectClean(text);
    jsonOf(result); // parses whole ⇒ no mid-string cut
  });

  it('serves evidence and rejects unknown ids across the pipe', { timeout: 30_000 }, async () => {
    const ok = (await client!.callTool({
      name: 'get_alert_evidence',
      arguments: { id: CALM_ALERT_ID },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expectClean(textOf(ok));

    const missing = (await client!.callTool({
      name: 'get_alert',
      arguments: { id: MISSING_ID },
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
  });
});
