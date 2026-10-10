import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SOC_API_KEY, log, readState, statePath, writeState } from './lib.js';

/**
 * Path 2 — bulk ingest, driven through the shipped soc-export CLI: export a
 * window of the demo database to redacted JSONL, upload it through the
 * authenticated ingest router, then import a deliberate case that links two
 * of the imported findings — the case construction auto-clustering cannot
 * show. Every CLI call is a subprocess of the real bin, not an import.
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

interface BulkState {
  exportedAlerts: number;
  jsonl: string;
  /** What the ingest job reported for the findings file: every exported row is either imported or skipped-as-duplicate. */
  uploadStats: { imported: number; skipped: number };
  caseDocument: { case_id: string; finding_ids: string[] };
}

function socExportCli(args: string[]): string {
  const bin = join(REPO_ROOT, 'packages', 'soc-export', 'bin', 'soc-export.js');
  const result = execFileSync(process.execPath, [bin, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, VAH_DEMO_SOC_KEY: SOC_API_KEY },
    encoding: 'utf8',
    timeout: 120_000,
  });
  process.stdout.write(result.trimStart());
  return result;
}

function main(): number {
  const produce = readState<ProduceState>('produce.json');
  if (produce.alertsRaised < 1) {
    log('bulk', 'no alerts were raised by the producer — nothing to export');
    return 1;
  }

  const jsonlPath = statePath('bulk.jsonl');
  socExportCli(['export', '--db', statePath('vigil.db'), '--out', jsonlPath]);
  const jsonl = readFileSync(jsonlPath, 'utf8');
  const rows = jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { finding_id: string });
  log('bulk', `exported ${rows.length} finding row(s) to ${jsonlPath}`);
  if (rows.length < 2) {
    log('bulk', 'need at least two findings to build the linked case');
    return 1;
  }

  // A deliberate case: two related findings from the export, linked the way
  // an analyst would cluster them.
  const caseDocument = {
    case_id: 'vah-demo-linked-case',
    title: 'Credential theft cluster (Vigil at Home demo)',
    description:
      'Two alerts from the same demo host, linked deliberately on import: the ingest path can ' +
      'build cases by hand, which the auto-clustering push path does not show.',
    finding_ids: [rows[0]!.finding_id, rows[1]!.finding_id],
    priority: 'high',
    tags: ['vigil-at-home', 'demo'],
  };
  const casePath = statePath('case.json');
  writeFileSync(casePath, JSON.stringify(caseDocument, null, 2), 'utf8');

  const uploadOutput = socExportCli([
    'upload',
    '--url',
    produce.socUrl,
    '--key-env',
    'VAH_DEMO_SOC_KEY',
    jsonlPath,
  ]);
  log('bulk', `uploaded ${rows.length} finding row(s) through the ingest router`);

  // The CLI summarizes the polled job as "findings: N imported, M skipped, K errors".
  const statsLine = /findings: (\d+) imported, (\d+) skipped, (\d+) errors/.exec(uploadOutput);
  if (!statsLine) {
    log('bulk', 'could not read the ingest job stats from the CLI output');
    return 1;
  }
  const uploadStats = {
    imported: Number(statsLine[1]),
    skipped: Number(statsLine[2]),
    errors: Number(statsLine[3]),
  };

  socExportCli(['case', '--url', produce.socUrl, '--key-env', 'VAH_DEMO_SOC_KEY', casePath]);
  log(
    'bulk',
    `imported case ${caseDocument.case_id} linking ${caseDocument.finding_ids.length} findings`,
  );

  writeState<BulkState>('bulk.json', {
    exportedAlerts: rows.length,
    jsonl: jsonlPath,
    uploadStats,
    caseDocument,
  });
  return 0;
}

process.exitCode = main();
