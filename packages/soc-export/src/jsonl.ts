import { redactString } from '@vigil/ai/redact';
import type { Alert } from '@vigil/core';
import { alertToFinding, scrubLocalNamesText } from './mapping.js';
import type { ExportContext } from './types.js';

/**
 * The source identity stamped on every bulk-ingested row. The ingest router's
 * `data_source` is a free string (String(50)), matching the push path's
 * `source` field — same value, so the SOC can group both feeding paths.
 */
export const INGEST_DATA_SOURCE = 'vigil-at-home';

/**
 * One findings row in the /api/ingest JSONL dialect: one JSON object per
 * line, `data_type=finding`. Same alert, different router — the VStrike
 * receiver wraps host context in `vstrike_enrichment`, while the ingest
 * router takes `title`, `description`, and a free `entity_context` directly.
 */
export interface IngestFinding {
  finding_id: string;
  timestamp?: string | undefined;
  anomaly_score?: number | undefined;
  severity?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  status?: string | undefined;
  data_source: string;
  title: string;
  description?: string | undefined;
  mitre_predictions?: Record<string, number> | undefined;
  entity_context?: Record<string, unknown> | undefined;
}

/**
 * The bulk row for one alert: the shared mapping (stable finding id,
 * deterministic anomaly score, severity, MITRE from rule tags, redacted
 * allowlisted context) re-mapped onto the ingest router's field names.
 * A resolved alert imports as a resolved finding; an open one omits status,
 * letting the SOC apply its own default.
 */
export function ingestFindingFromAlert(alert: Alert, ctx: ExportContext): IngestFinding {
  const finding = alertToFinding(alert, ctx);
  return {
    finding_id: finding.finding_id,
    timestamp: finding.timestamp,
    anomaly_score: finding.anomaly_score,
    severity: finding.severity,
    ...(alert.status === 'resolved' ? { status: 'resolved' } : {}),
    data_source: INGEST_DATA_SOURCE,
    title: scrubLocalNamesText(redactString(alert.title, ctx.names), ctx.names),
    description: finding.description,
    mitre_predictions: finding.mitre_predictions,
    entity_context: finding.entity_context_extra,
  };
}

/** One JSON object per line — the ingest router's `jsonl` format. */
export function alertToIngestLine(alert: Alert, ctx: ExportContext): string {
  return JSON.stringify(ingestFindingFromAlert(alert, ctx));
}

/**
 * A whole window as JSONL: one finding per line, newline-terminated so the
 * router's line reader sees complete rows. Empty input produces an empty
 * file — uploading it is a no-op the SOC reports as "no data imported".
 */
export function alertsToIngestJsonl(alerts: readonly Alert[], ctx: ExportContext): string {
  if (!alerts.length) return '';
  return alerts.map((alert) => alertToIngestLine(alert, ctx)).join('\n') + '\n';
}
