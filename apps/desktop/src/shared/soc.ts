import { z } from 'zod';

/**
 * What the renderer may change about SOC export. The key rides along here so
 * it can be pasted once; it never comes back — the view says only whether a
 * key is saved, and its last four characters.
 */
export const SocSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  socBaseUrl: z.string().max(2048).optional(),
  socApiKey: z.string().max(4096).optional(),
});
export type SocSettingsPatch = z.infer<typeof SocSettingsPatch>;

/** What Settings shows about SOC export. Never carries the key itself. */
export interface SocView {
  /** Opt-in, off by default: nothing leaves the machine until this is true. */
  enabled: boolean;
  /** The Vigil SOC address, e.g. https://soc.example.com — https, or localhost http. */
  socBaseUrl: string;
  /** Whether an API key is saved (safeStorage-encrypted at rest). */
  keySaved: boolean;
  keyLast4?: string;
  /** Whether a key can be saved at all (the Keychain may be unavailable). */
  canSave: boolean;
  /** What stands between the user and switching export on, one string each. */
  errors: string[];
}
