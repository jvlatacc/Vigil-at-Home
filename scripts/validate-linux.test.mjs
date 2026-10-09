// The routine's contract, checked where CI runs unprivileged: the self-test
// passes, an unknown distro family refuses before anything else, and a known
// family demands root before it runs any check. The checks themselves need a
// real root system — the routine self-tests those on the machine it runs on
// (scripts/validate-linux.sh --self-test), and CI's distro jobs run the real
// thing end to end.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = join(fileURLToPath(new URL('.', import.meta.url)), 'validate-linux.sh');

const run = (args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 120_000 });

describe('validate-linux.sh', () => {
  it('passes its self-test without root and without touching the system', () => {
    const r = run(['--self-test']);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });

  it('refuses a distro family it does not know, before even the root check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vigil-validate-'));
    const osRelease = join(dir, 'os-release');
    writeFileSync(osRelease, 'ID=arch\n');
    const r = run([`--os-release=${osRelease}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('arch');
  });

  const asRoot = process.platform === 'linux' && process.getuid?.() === 0;
  it.skipIf(asRoot)('demands root on a system it knows', () => {
    const r = run(['--family=debian']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/root|sudo/);
  });
});
