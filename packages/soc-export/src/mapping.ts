import { redactAndSerialize, redactString, redactValue, WITHHELD } from '@vigil/ai/redact';
import type { Alert } from '@vigil/core';
import type { ExportContext, RedactionNames, VStrikeEnrichment, VStrikeFinding } from './types.js';

/**
 * anomaly_score from severity alone: deterministic and monotonic, no model
 * involved. The advisory AI confidence is context, never a score input.
 */
const SEVERITY_ANOMALY_SCORE: Record<Alert['severity'], number> = {
  info: 0.2,
  low: 0.4,
  medium: 0.6,
  high: 0.8,
  critical: 1.0,
};

/** A MITRE ATT&CK technique id, e.g. T1059 or T1059.001. Rule.tags carry these among free tags. */
const MITRE_TAG = /^T\d{4}(?:\.\d{3})?$/;

/** The receiver requires a segment; a desktop endpoint is its own. */
const ENDPOINT_SEGMENT = 'endpoint';

/** Asset criticality is unknowable from an alert; the field is required, so a constant. */
const ENDPOINT_CRITICALITY: VStrikeEnrichment['criticality'] = 'medium';

/** The finding id for an alert: stable, so a re-push updates instead of duplicating. */
export function findingIdFor(alert: Alert): string {
  return `vah-${alert.id}`;
}

/** Vigil SOC has no info severity: info maps to low, the rest pass through. */
export function findingSeverity(alert: Alert): 'low' | 'medium' | 'high' | 'critical' {
  return alert.severity === 'info' ? 'low' : alert.severity;
}

export function anomalyScore(alert: Alert): number {
  return SEVERITY_ANOMALY_SCORE[alert.severity];
}

/** MITRE ids lifted from the rule's tags, weighted by the alert's fidelity. */
export function mitrePredictions(
  alert: Alert,
  tags: readonly string[] | undefined,
): Record<string, number> {
  const weight = alert.fidelity === 'high' ? 0.9 : 0.6;
  const out: Record<string, number> = {};
  for (const tag of tags ?? []) {
    if (MITRE_TAG.test(tag)) out[tag] = weight;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
}

/**
 * The redactor's word-boundary pass keeps the machine's own names intact
 * inside hyphenated compounds (`agent-<user>.plist`); the exporter knows
 * those names exactly — it derives the machine id from one of them — so it
 * scrubs them verbatim after the redactor has run. Exported because the MCP
 * pull surface scrubs its serialized answers the same way. The bulk path
 * reuses it on the one field it redacts outside the shared mapping (the
 * finding title).
 */
export function scrubLocalNamesText(text: string, names: RedactionNames): string {
  let scrubbed = text;
  if (names.username) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(names.username), 'gi'), '<user>');
  }
  if (names.hostname) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(names.hostname), 'gi'), '<host>');
  }
  return scrubbed;
}

function scrubLocalNamesDeep(value: unknown, names: RedactionNames): unknown {
  if (typeof value === 'string') return scrubLocalNamesText(value, names);
  if (Array.isArray(value)) return value.map((item) => scrubLocalNamesDeep(item, names));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubLocalNamesDeep(item, names)]),
    );
  }
  return value;
}

/**
 * entity_context, evidenceOf-style: every field picked on purpose, so a field
 * added to Alert later stays out until someone names it here; the whole
 * object redacted; then the byte cap, met by dropping whole fields — never by
 * cutting a string, which could leave part of a secret behind.
 */
function buildEntityContext(alert: Alert, ctx: ExportContext): Record<string, unknown> {
  const allowed = {
    host: ctx.machineId,
    alert_id: alert.id,
    rule: `${alert.ruleId}@${alert.ruleVersion}`,
    fidelity: alert.fidelity,
    status: alert.status,
    containment: alert.containment,
    subject: alert.subject && {
      kind: alert.subject.kind,
      label: alert.subject.label,
      path: alert.subject.path,
    },
    ai_verdict: alert.ai?.verdict,
    ai_confidence: alert.ai?.confidence,
    decision: alert.decision?.verdict,
    repeats: alert.repeats?.count,
  };
  const redacted = asRecord(
    scrubLocalNamesDeep(asRecord(redactValue(allowed, ctx.names)), ctx.names),
  );
  if (Buffer.byteLength(JSON.stringify(redacted)) <= ctx.maxEntityBytes) return redacted;
  // Over the cap: let the redactor's fitter drop whole fields to fit, and
  // parse back so entity_context stays an object on the wire.
  const fitted = redactAndSerialize(redacted, { ...ctx.names, maxBytes: ctx.maxEntityBytes });
  try {
    const parsed: unknown = JSON.parse(fitted.text);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fell through to the fallback below.
  }
  return { host: ctx.machineId, alert_id: alert.id, note: WITHHELD };
}

/**
 * The one place an Alert becomes a Vigil SOC finding. Pure in (alert, ctx):
 * the caller injects the rule store, machine id, local names and the byte
 * cap, so the mapping is unit-testable without an app.
 */
export function alertToFinding(alert: Alert, ctx: ExportContext): VStrikeFinding {
  const timestamp = new Date(alert.createdAt).toISOString();
  return {
    finding_id: findingIdFor(alert),
    vstrike_enrichment: {
      asset_id: ctx.machineId,
      segment: ENDPOINT_SEGMENT,
      criticality: ENDPOINT_CRITICALITY,
      enriched_at: timestamp,
    },
    timestamp,
    anomaly_score: anomalyScore(alert),
    severity: findingSeverity(alert),
    mitre_predictions: mitrePredictions(alert, ctx.ruleOf(alert)?.tags),
    // The receiver has no title field: the alert's title leads the description.
    description: scrubLocalNamesText(
      redactString(`${alert.title}\n${alert.summary}`, ctx.names),
      ctx.names,
    ),
    entity_context_extra: buildEntityContext(alert, ctx),
  };
}
