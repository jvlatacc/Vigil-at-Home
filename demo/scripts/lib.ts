import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo root, derived from this file's location so any cwd works. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The demo's scratch area: gitignored, safe to delete between runs. */
export const RUN_DIR = join(REPO_ROOT, 'demo', '.run');
export const STATE_DIR = process.env['VAH_DEMO_STATE']
  ? join(REPO_ROOT, process.env['VAH_DEMO_STATE'])
  : join(RUN_DIR, 'state');

export function ensureStateDir(): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

export function statePath(name: string): string {
  return join(STATE_DIR, name);
}

export function writeState(name: string, data: unknown): void {
  ensureStateDir();
  writeFileSync(statePath(name), JSON.stringify(data, null, 2), 'utf8');
}

export function readState<T>(name: string): T {
  return JSON.parse(readFileSync(statePath(name), 'utf8')) as T;
}

/** The demo SOC. DEV_MODE bypasses auth; the key is still sent, as a user would send theirs. */
export const SOC_URL = process.env['SOC_URL'] ?? 'http://127.0.0.1:6987';
export const SOC_API_KEY = process.env['SOC_API_KEY'] ?? 'vah-demo';

/** Health check for the Vigil SOC API: any settled answer counts; nothing listening does not. */
export async function socHealthy(
  url: string = SOC_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  for (const path of ['/api/health', '/docs', '/']) {
    try {
      const response = await fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return true;
    } catch {
      // not up yet — try the next probe / poll round
    }
  }
  return false;
}

/** Wait for the SOC API to answer, up to `timeoutMs`. */
export async function waitForSoc(timeoutMs = 180_000, url: string = SOC_URL): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socHealthy(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

export function log(tag: string, message: string): void {
  process.stdout.write(`[${tag}] ${message}\n`);
}
