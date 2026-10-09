import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { localNames } from '@vigil/ai/redact';
import { IngestCase, redactCaseDocument, serializeCase } from './case-import.js';
import { readAlertWindow } from './db-source.js';
import { IngestClient, type IngestJobSnapshot } from './ingest-client.js';
import { alertsToIngestJsonl } from './jsonl.js';
import { deriveMachineId } from './machine.js';
import { DEFAULT_MAX_ENTITY_BYTES, type ExportContext } from './types.js';
import { TransportError } from './transport.js';

const USAGE = `soc-export — feed Vigil SOC the bulk way

Commands:
  export --db <vigil.db> --out <file.jsonl> [--since <iso|ms>] [--until <iso|ms>]
      Export a window of local alerts to redacted ingest JSONL.
  upload --url <soc-base-url> --key-env <VAR> <file.jsonl>
      Upload findings JSONL via POST /api/ingest/upload and wait for the job.
  case --url <soc-base-url> --key-env <VAR> <case.json>
      Import a case document linking finding_ids — a deliberate case, the
      construction the auto-clustering push path cannot show.

The API key is read from the environment variable named by --key-env,
never passed on the command line. The SOC address must use https, or
http only for localhost.`;

export class CliUsageError extends Error {}

export interface CliInvocation {
  command: string;
  flags: Record<string, string>;
  positional: string[];
}

export function parseInvocation(argv: readonly string[]): CliInvocation {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('-')) throw new CliUsageError(USAGE);
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] ?? '';
    if (token.startsWith('--')) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`Flag ${token} needs a value.\n\n${USAGE}`);
      }
      flags[token.slice(2)] = value;
      index++;
    } else {
      positional.push(token);
    }
  }
  return { command, flags, positional };
}

/** Epoch milliseconds, or an ISO date the platform can parse. */
function parseTime(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new CliUsageError(`${flag}: not a timestamp (epoch ms or ISO date): ${raw}`);
  }
  return ms;
}

function windowBounds(flags: Record<string, string>): { sinceMs?: number; untilMs?: number } {
  return {
    ...(flags['since'] === undefined ? {} : { sinceMs: parseTime(flags['since'], '--since') }),
    ...(flags['until'] === undefined ? {} : { untilMs: parseTime(flags['until'], '--until') }),
  };
}

function summarizeJob(job: IngestJobSnapshot): string {
  const stats = job.stats;
  return [
    `findings: ${stats['findings_imported'] ?? 0} imported, ${stats['findings_skipped'] ?? 0} skipped, ${stats['findings_errors'] ?? 0} errors`,
    `cases: ${stats['cases_imported'] ?? 0} imported, ${stats['cases_skipped'] ?? 0} skipped, ${stats['cases_errors'] ?? 0} errors`,
  ].join(' — ');
}

async function runExport(inv: CliInvocation): Promise<number> {
  const dbPath = inv.flags['db'];
  const outPath = inv.flags['out'];
  if (!dbPath || !outPath) throw new CliUsageError(`export needs --db and --out.\n\n${USAGE}`);

  const names = localNames();
  const window = await readAlertWindow(dbPath, windowBounds(inv.flags));
  if (window.unreadable) {
    process.stderr.write(`warning: skipped ${window.unreadable} unreadable alert row(s)\n`);
  }
  const ctx: ExportContext = {
    machineId: deriveMachineId(names),
    ruleOf: (alert) => window.ruleTags(alert.ruleId),
    names,
    maxEntityBytes: DEFAULT_MAX_ENTITY_BYTES,
  };
  const jsonl = alertsToIngestJsonl(window.alerts, ctx);
  if (!jsonl) {
    process.stdout.write('No alerts in the window; nothing to upload.\n');
    return 0;
  }
  writeFileSync(outPath, jsonl, 'utf8');
  process.stdout.write(`Exported ${window.alerts.length} alert(s) to ${outPath}\n`);
  return 0;
}

function ingestClientFor(inv: CliInvocation, deps: { fetch?: typeof fetch } = {}): IngestClient {
  const url = inv.flags['url'];
  const keyEnv = inv.flags['key-env'];
  if (!url || !keyEnv) {
    throw new CliUsageError(`upload and case need --url and --key-env.\n\n${USAGE}`);
  }
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    throw new CliUsageError(`--key-env: environment variable ${keyEnv} is not set.`);
  }
  return new IngestClient({
    baseUrl: url,
    apiKey,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
}

async function runUpload(inv: CliInvocation, deps: { fetch?: typeof fetch }): Promise<number> {
  const file = inv.positional[0];
  if (!file) throw new CliUsageError(`upload needs a JSONL file.\n\n${USAGE}`);
  // Validate the endpoint configuration before touching the disk.
  const client = ingestClientFor(inv, deps);
  const jsonl = readFileSync(file, 'utf8');
  const job = await client.uploadFindings(jsonl);
  process.stdout.write(`${job.job_id}: ${job.message || 'ingest succeeded'}\n${summarizeJob(job)}\n`);
  return 0;
}

function parseCaseDocument(raw: string): IngestCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CliUsageError('case: the document is not valid JSON.', { cause });
  }
  const result = IngestCase.safeParse(parsed);
  if (!result.success) {
    throw new CliUsageError(
      `case: the document is not a valid case row:\n${result.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')}`,
    );
  }
  return result.data;
}

async function runCase(inv: CliInvocation, deps: { fetch?: typeof fetch }): Promise<number> {
  const file = inv.positional[0];
  if (!file) throw new CliUsageError(`case needs a case document.\n\n${USAGE}`);
  const client = ingestClientFor(inv, deps);
  const doc = redactCaseDocument(parseCaseDocument(readFileSync(file, 'utf8')), localNames());
  const job = await client.uploadCase(serializeCase(doc));
  process.stdout.write(
    `${job.job_id}: ${job.message || 'case ingest succeeded'}\n${summarizeJob(job)}\n`,
  );
  return 0;
}

/**
 * The bulk path's command line. Returns the exit code: 0 exported/imported,
 * 2 usage, 1 anything that went wrong talking to the SOC or the disk.
 */
export async function main(
  argv: readonly string[],
  deps: { fetch?: typeof fetch } = {},
): Promise<number> {
  let inv: CliInvocation;
  try {
    inv = parseInvocation(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    switch (inv.command) {
      case 'export':
        return await runExport(inv);
      case 'upload':
        return await runUpload(inv, deps);
      case 'case':
        return await runCase(inv, deps);
      default: {
        process.stderr.write(`Unknown command: ${inv.command}\n\n${USAGE}`);
        return 2;
      }
    }
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 2;
    }
    if (error instanceof TransportError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    // Anything else is a bug or a broken environment: show it whole.
    process.stderr.write(
      `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  }
}
