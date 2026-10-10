import type { Alert } from '@vigil/core';

/** Local names the redactor replaces before anything leaves the machine. */
export interface RedactionNames {
  username?: string;
  hostname?: string;
}

/**
 * How much of entity_context may leave the machine, serialized, in bytes.
 * Generous for an allowlisted object; the cap exists so a hostile label can
 * never balloon a finding, not to ration context.
 */
export const DEFAULT_MAX_ENTITY_BYTES = 8 * 1024;

/**
 * Everything the mapping needs from the caller, injected so the core stays
 * pure: no rule store, no os calls, no clock of its own.
 */
export interface ExportContext {
  /** Stable per-machine pseudonym, derived at export time (the model has no host field). */
  readonly machineId: string;
  /** The rule an alert came from — its tags carry the MITRE ATT&CK ids. */
  readonly ruleOf: (alert: Alert) => { readonly tags: readonly string[] } | undefined;
  /** Local names for the redactor. Empty in tests; the machine's own in the app. */
  readonly names: RedactionNames;
  /** Byte cap on the serialized entity_context. */
  readonly maxEntityBytes: number;
}

// The wire types below follow upstream Vigil: core/integrations/vstrike/
// schemas.py for the push, core/api/v1/findings_router.py for the frozen
// /api/v1 update (both fetched 2026-10-09).

/** Per-host context the receiver requires on every pushed finding. */
export interface VStrikeEnrichment {
  asset_id: string;
  segment: string;
  criticality: 'low' | 'medium' | 'high' | 'critical';
  enriched_at: string;
}

/**
 * One finding in a push. `finding_id` the SOC has not seen, plus `timestamp`
 * and `anomaly_score`, creates a finding; a known id updates it.
 */
export interface VStrikeFinding {
  finding_id: string;
  vstrike_enrichment: VStrikeEnrichment;
  timestamp?: string;
  anomaly_score?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  mitre_predictions?: Record<string, number>;
  description?: string;
  /** Merged into entity_context by the receiver, alongside its own vstrike sub-dict. */
  entity_context_extra?: Record<string, unknown>;
}

export interface VStrikePushRequest {
  batch_id: string;
  source: string;
  findings: VStrikeFinding[];
  auto_cluster_cases: boolean;
}

export type VStrikeFindingResultStatus = 'created' | 'updated' | 'failed';

export interface VStrikeFindingResult {
  finding_id: string;
  status: VStrikeFindingResultStatus;
  error?: string;
}

export interface VStrikePushResponse {
  batch_id: string;
  received: number;
  created: number;
  updated: number;
  failed: number;
  results: VStrikeFindingResult[];
  case_ids: string[];
}

/** Fields the frozen /api/v1/findings/{finding_id} PATCH accepts. */
export interface FindingUpdate {
  mitre_predictions?: Record<string, number>;
  predicted_techniques?: Array<Record<string, unknown>>;
  severity?: string;
  status?: string;
  anomaly_score?: number;
  entity_context?: Record<string, unknown>;
  cluster_id?: string;
  evidence_links?: string[];
}

export interface FindingUpdateResponse {
  success: boolean;
  finding: Record<string, unknown>;
  updated_fields: string[];
}

/** One queued resolution: a finding id and the update for it. */
export interface ResolutionUpdate {
  findingId: string;
  update: FindingUpdate;
}
