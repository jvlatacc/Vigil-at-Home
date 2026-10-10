import { SOC_API_KEY, SOC_URL, log, readState } from './lib.js';

/**
 * The acceptance gate: the demo run passes only if every path left findings
 * in Vigil SOC and at least one case exists. Anything short of that exits
 * non-zero — the same bar the spec's harness row sets.
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
  uploadStats: { imported: number; skipped: number; errors: number };
  caseDocument: { case_id: string; finding_ids: string[] };
}

interface McpState {
  serverInfo: unknown;
  tools: string[];
  listRecent: { lines: number };
  getAlert: { ok: boolean };
  getAlertEvidence: { ok: boolean };
  intake: { findingId: string; accepted: boolean; detail: string };
}

interface FindingRow {
  finding_id?: string;
  data_source?: string;
  status?: string;
  title?: string;
}

/** The findings list, from the frozen /api/v1 contract. Tolerant of the two envelope shapes. */
async function fetchFindings(): Promise<FindingRow[]> {
  const response = await fetch(`${SOC_URL}/api/v1/findings`, {
    headers: { authorization: `Bearer ${SOC_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/findings → HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown>)['items'])
      ? ((body as Record<string, unknown>)['items'] as unknown[])
      : Array.isArray((body as Record<string, unknown>)['findings'])
        ? ((body as Record<string, unknown>)['findings'] as unknown[])
        : [];
  return rows.filter((row): row is FindingRow => typeof row === 'object' && row !== null);
}

async function fetchCases(): Promise<unknown[]> {
  const response = await fetch(`${SOC_URL}/api/v1/cases`, {
    headers: { authorization: `Bearer ${SOC_API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GET /api/v1/cases → HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (Array.isArray(body)) return body;
  const cases = (body as Record<string, unknown>)['cases'];
  if (Array.isArray(cases)) return cases;
  const items = (body as Record<string, unknown>)['items'];
  return Array.isArray(items) ? items : [];
}

async function main(): Promise<number> {
  const produce = readState<ProduceState>('produce.json');
  const bulk = readState<BulkState>('bulk.json');
  const mcp = readState<McpState>('mcp.json');

  const findings = await fetchFindings();
  const cases = await fetchCases();
  const pushFindings = findings.filter((finding) => finding.data_source === 'vstrike');
  const findingIds = new Set(pushFindings.map((finding) => finding.finding_id));
  const resolvedFindings = findings.filter((finding) => finding.status === 'resolved');

  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    {
      name: 'path 1 — live push findings in the SOC',
      pass: pushFindings.length >= produce.alertsRaised,
      detail: `${pushFindings.length} with data_source=vstrike (pushed ${produce.alertsRaised})`,
    },
    {
      name: 'path 1 — resolution PATCH closed a finding',
      pass: resolvedFindings.length >= 1,
      detail: `${resolvedFindings.length} finding(s) resolved in the SOC (produce resolved ${produce.resolutions})`,
    },
    {
      name: 'path 2 — ingest job accounted for every exported row',
      pass:
        bulk.uploadStats.errors === 0 &&
        bulk.uploadStats.imported + bulk.uploadStats.skipped >= bulk.exportedAlerts,
      detail: `${bulk.uploadStats.imported} imported, ${bulk.uploadStats.skipped} skipped-as-duplicate of ${bulk.exportedAlerts} exported (stable finding_ids make a re-import a skip, never a duplicate)`,
    },
    {
      name: 'path 2 — deliberate case imported with links that resolve',
      pass:
        cases.some(
          (row) => (row as Record<string, unknown>)['case_id'] === bulk.caseDocument.case_id,
        ) && bulk.caseDocument.finding_ids.every((id) => findingIds.has(id)),
      detail: `case ${bulk.caseDocument.case_id} links ${bulk.caseDocument.finding_ids.length} finding(s), all present in the SOC`,
    },
    {
      name: 'path 3 — MCP tools answered over stdio',
      pass:
        mcp.tools.length >= 3 &&
        mcp.getAlert.ok &&
        mcp.getAlertEvidence.ok &&
        mcp.listRecent.lines > 0,
      detail: `tools: ${mcp.tools.join(', ')}; list: ${mcp.listRecent.lines} line(s)`,
    },
    {
      name: 'path 3 — finding queued for the agent pipeline',
      pass: mcp.intake.accepted,
      detail: `${mcp.intake.findingId}: ${mcp.intake.detail}`,
    },
    {
      name: 'at least one case exists in the SOC',
      pass: cases.length >= 1,
      detail: `${cases.length} case(s)`,
    },
  ];

  let failed = 0;
  for (const check of checks) {
    log('verify', `${check.pass ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
    if (!check.pass) failed++;
  }
  log(
    'verify',
    `${findings.length} finding(s) total in the SOC (${pushFindings.length} via the push receiver), ${cases.length} case(s)`,
  );
  if (failed > 0) {
    log('verify', `${failed} check(s) failed`);
    return 1;
  }
  log('verify', 'all checks passed');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[verify] failed:', error);
    process.exitCode = 1;
  });
