import { createHash } from 'node:crypto';
import { localNames } from '@vigil/ai/redact';
import type { RedactionNames } from './types.js';

/**
 * A stable per-machine id, derived at export time: alerts and events carry no
 * host identity (the osquery uuid never reaches the model), and a multi-host
 * SOC view needs one. The hostname is hashed, not sent — the redactor
 * replaces local names in anything it touches, so a raw hostname would not
 * survive our own redaction pass, and the SOC needs a stable grouping key,
 * not the name.
 */
export function deriveMachineId(names: RedactionNames = localNames()): string {
  if (!names.hostname) return 'vah-host-unknown';
  const hash = createHash('sha256').update(names.hostname, 'utf8').digest('hex');
  return `vah-host-${hash.slice(0, 16)}`;
}
