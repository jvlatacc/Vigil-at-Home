import { z } from 'zod';
import { isSafeBaseUrl } from './safe-url.js';

export const SocBatchSettings = z.object({
  /** Flush when this many findings are pending. */
  maxItems: z.number().int().min(1).max(500).default(50),
  /** …or this long after the first pending item, whichever comes first. */
  flushAfterMs: z.number().int().min(100).max(3_600_000).default(5_000),
  /** The queue is bounded: beyond this, the oldest pending item is dropped. */
  maxQueueItems: z.number().int().min(10).max(100_000).default(500),
});

export const SocBackoffSettings = z.object({
  initialMs: z.number().int().min(50).max(60_000).default(1_000),
  maxMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  multiplier: z.number().min(1).max(10).default(2),
});

export const SocSettings = z.object({
  /**
   * Opt-in, off by default: until the user enables SOC export, no setting
   * combination makes a network call. The local-first promise — no server,
   * no account — is why this switch exists at all.
   */
  enabled: z.boolean().default(false),
  /** Vigil SOC base URL, e.g. https://soc.example.com — https, or http for localhost only. */
  socBaseUrl: z.string().default(''),
  /**
   * Bearer key for the SOC API. The desktop settings store keeps it
   * safeStorage-encrypted at rest, like the AI provider keys.
   */
  socApiKey: z.string().default(''),
  batch: SocBatchSettings.default({ maxItems: 50, flushAfterMs: 5_000, maxQueueItems: 500 }),
  backoff: SocBackoffSettings.default({ initialMs: 1_000, maxMs: 60_000, multiplier: 2 }),
});
export type SocSettings = z.infer<typeof SocSettings>;

/**
 * What must be fixed before export can be switched on: an endpoint and a
 * key, and an endpoint that is https or localhost.
 */
export function enablementErrors(settings: SocSettings): string[] {
  if (!settings.enabled) return [];
  const errors: string[] = [];
  if (!settings.socBaseUrl) errors.push('A Vigil SOC address is required to enable export.');
  else if (!isSafeBaseUrl(settings.socBaseUrl)) {
    errors.push('The Vigil SOC address must use https, or http only for localhost.');
  }
  if (!settings.socApiKey) errors.push('An API key is required to enable export.');
  return errors;
}
