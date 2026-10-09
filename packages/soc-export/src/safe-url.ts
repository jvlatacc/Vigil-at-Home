// Mirrors packages/ai/src/providers/openaiCompatible.ts isSafeBaseUrl: a key
// goes only to an https endpoint, or to one on this machine. Kept local so
// the export core does not import the AI provider module.

/** A key goes only to an https endpoint, or to one on this Mac. */
export function isSafeBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
