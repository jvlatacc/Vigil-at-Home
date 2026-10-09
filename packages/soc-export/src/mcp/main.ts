import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { localNames } from '@vigil/ai/redact';
import { deriveMachineId } from '../machine.js';
import type { RedactionNames } from '../types.js';
import { AlertStore } from './alert-store.js';
import { buildSocMcpServer, SOC_MCP_NAME, SOC_MCP_VERSION } from './server.js';

/**
 * The stdio entry Vigil SOC's `mcp_config.json` spawns. The command line is
 * just the database path:
 *
 *   mcp-main --db=<path to vigil.db>
 *
 * stdout is the MCP protocol channel — every diagnostic goes to stderr.
 */

/** The `--db` path from argv, or a usage error naming what was missing. */
export function dbPathFromArgv(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (next !== undefined && next !== '') return next;
    } else if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length);
      if (value !== '') return value;
    }
  }
  throw new Error('Usage: mcp-main --db=<path to vigil.db> — the database is opened read-only.');
}

/** The value of `--flag=value` (or `--flag value`) from argv, if given. */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === `--${flag}`) {
      const next = argv[i + 1];
      if (next !== undefined && next !== '') return next;
    } else if (arg.startsWith(`--${flag}=`)) {
      const value = arg.slice(flag.length + 3);
      if (value !== '') return value;
    }
  }
  return undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const dbPath = dbPathFromArgv(argv);
  // The redactor scrubs the machine's own names before anything leaves.
  // localNames() discovers them; a deployment may pin them (containers do
  // not always know the user's real names), and tests pin the fixtures'.
  const discovered = localNames();
  const username = flagValue(argv, 'username') ?? discovered.username;
  const hostname = flagValue(argv, 'hostname') ?? discovered.hostname;
  const names: RedactionNames = {
    ...(username !== undefined ? { username } : {}),
    ...(hostname !== undefined ? { hostname } : {}),
  };
  const store = AlertStore.openReadOnly(dbPath);
  const server = buildSocMcpServer(store, { names, machineId: deriveMachineId(names) });
  await server.connect(new StdioServerTransport());
  console.error(
    `[${SOC_MCP_NAME}] ${SOC_MCP_VERSION}: three read-only tools over stdio, db=${dbPath}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `[${SOC_MCP_NAME}] failed to start:`,
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 2;
});
