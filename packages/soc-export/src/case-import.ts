import { z } from 'zod';
import { redactString } from '@vigil/ai/redact';
import { scrubLocalNamesText } from './mapping.js';
import type { RedactionNames } from './types.js';

/**
 * One case row for the ingest router (`data_type=case`): a deliberate,
 * human-authored cluster of imported findings — the construction the push
 * path's auto-clustering cannot show. Field names follow the router's case
 * schema (VS-5: case_id, title, description, finding_ids, status, priority,
 * assignee, tags).
 */
export const IngestCase = z.object({
  /**
   * Required on purpose: a fixed id makes a re-import a duplicate-skip on
   * the SOC, not a second case — the idempotency the demo re-runs need.
   */
  case_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  finding_ids: z.array(z.string().min(1)).min(1),
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type IngestCase = z.infer<typeof IngestCase>;

/**
 * Redact the free-text fields before the document leaves the machine — the
 * same treatment every exported row gets. Identifiers and tags pass
 * untouched: they are keys, not prose.
 */
export function redactCaseDocument(doc: IngestCase, names: RedactionNames): IngestCase {
  return {
    ...doc,
    title: scrubLocalNamesText(redactString(doc.title, names), names),
    ...(doc.description === undefined
      ? {}
      : { description: scrubLocalNamesText(redactString(doc.description, names), names) }),
  };
}

/** The exact bytes the case upload sends: one JSON object. */
export function serializeCase(doc: IngestCase): string {
  return JSON.stringify(doc);
}
