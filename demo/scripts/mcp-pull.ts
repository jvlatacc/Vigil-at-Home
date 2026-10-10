import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, SOC_API_KEY, log, readState, statePath, writeState } from './lib.js';

/**
 * Path 3 — MCP pull. Vigil SOC's own `mcp_config.json` would spawn this
 * server over stdio beside itself; the demo drives the same server the same
 * way a SOC agent would: a stdio client connects to the process, lists the
 * three tools, and calls them against the demo database. It then queues one
 * finding for the agent pipeline (VS-11), so Triage and Investigator visibly
 * take over — the pull surface exists to feed exactly that investigation.
 */

interface ProduceState {
  socUrl: string;
  machineId: string;
  attacksFired: string[];
  eventsIngested: number;
  alertsRaised: number;
  alertIds: string[];
  resolutions: number;
}

interface McpState {
  serverInfo: unknown;
  tools: string[];
  listRecent: { lines: number; firstAlertId?: string };
  getAlert: { ok: boolean };
  getAlertEvidence: { ok: boolean };
  intake: { findingId: string; accepted: boolean; detail: string };
}

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A minimal stdio MCP client: ndjson JSON-RPC, initialize, tools/list, tools/call. */
class StdioMcpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private buffer = '';
  private stderrTail: string[] = [];

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      // The server logs to stderr; keep a tail so a failure explains itself.
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') this.onMessage(JSON.parse(line) as RpcResponse);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onMessage(message: RpcResponse): void {
    if (typeof message.id !== 'number' || !this.pending.has(message.id)) return;
    const { resolve, reject } = this.pending.get(message.id)!;
    this.pending.delete(message.id);
    if (message.error)
      reject(new Error(`rpc error ${message.error.code}: ${message.error.message}`));
    else resolve(message.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin!.write(frame);
    });
  }

  /** The handshake every MCP session starts with. */
  async initialize(): Promise<unknown> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vah-demo-client', version: '0.0.0' },
    });
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    return result;
  }

  async listTools(): Promise<string[]> {
    const result = (await this.request('tools/list', {})) as { tools: Array<{ name: string }> };
    return result.tools.map((tool) => tool.name).sort();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
    };
    if (!Array.isArray(result.content) || result.content.length === 0) {
      throw new Error(`tool ${name} returned no content`);
    }
    return result.content
      .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
      .join('\n');
  }

  failLog(): string {
    return this.stderrTail.join('');
  }

  stop(): void {
    this.child.stdin!.end();
    this.child.kill('SIGTERM');
  }
}

async function main(): Promise<number> {
  const produce = readState<ProduceState>('produce.json');
  if (produce.alertsRaised < 1) {
    log('mcp', 'no alerts were raised by the producer — nothing to pull');
    return 1;
  }

  // The same command line Vigil SOC would run (mcp_config.json): the server
  // over stdio, pointed at the read-only database. --username/--hostname pin
  // the redactor's names, as a deployment beside a containerized consumer
  // would.
  const serverPath = join(REPO_ROOT, 'packages', 'soc-export', 'src', 'mcp', 'main.ts');
  const client = new StdioMcpClient(process.execPath, [
    '--import',
    'tsx',
    serverPath,
    `--db=${statePath('vigil.db')}`,
    '--username=vah-demo-user',
    '--hostname=vah-demo-host',
  ]);
  try {
    const serverInfo = await client.initialize();
    log('mcp', `connected: ${JSON.stringify(serverInfo)}`);

    const toolNames = await client.listTools();
    log('mcp', `tools: ${toolNames.join(', ')}`);
    const required = ['get_alert', 'get_alert_evidence', 'list_recent_alerts'];
    const missing = required.filter((name) => !toolNames.includes(name));
    if (missing.length > 0) {
      log('mcp', `missing tools: ${missing.join(', ')}`);
      return 1;
    }

    const listText = await client.callTool('list_recent_alerts', {});
    log('mcp', `list_recent_alerts → ${listText.split('\n').length} line(s) of redacted summaries`);
    const alertId = produce.alertIds[0]!;

    const getText = await client.callTool('get_alert', { id: alertId });
    log('mcp', `get_alert ${alertId} → ${getText.length} byte(s)`);

    const evidenceText = await client.callTool('get_alert_evidence', { id: alertId });
    log('mcp', `get_alert_evidence ${alertId} → ${evidenceText.length} byte(s)`);

    // The pinned names must never cross: the server derives the machine id
    // from them and scrubs them from every response.
    const leaks = [listText, getText, evidenceText].some((text) =>
      ['vah-demo-user', 'vah-demo-host'].some((name) => text.includes(name)),
    );
    if (leaks) {
      log('mcp', 'local names appeared in a tool response — refusing to pass');
      return 1;
    }

    // Queue the finding for the agent pipeline: the SOC's own Triage →
    // Investigator → Responder → Reporter workflows pick it up from here.
    const findingId = `vah-${alertId}`;
    const response = await fetch(`${produce.socUrl}/api/findings/${findingId}/intake`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SOC_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    const detail = (await response.text()).slice(0, 300);
    log('mcp', `intake ${findingId}: HTTP ${response.status} ${detail}`);

    writeState<McpState>('mcp.json', {
      serverInfo,
      tools: toolNames,
      listRecent: { lines: listText.split('\n').length, firstAlertId: alertId },
      getAlert: { ok: getText.length > 0 },
      getAlertEvidence: { ok: evidenceText.length > 0 },
      intake: {
        findingId,
        accepted: response.ok,
        detail: `HTTP ${response.status}`,
      },
    });
    return 0;
  } catch (error) {
    const tail = client.failLog().trim();
    if (tail !== '') console.error(`[mcp] server stderr tail:\n${tail}`);
    throw error;
  } finally {
    client.stop();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[mcp] failed:', error);
    process.exitCode = 1;
  });
