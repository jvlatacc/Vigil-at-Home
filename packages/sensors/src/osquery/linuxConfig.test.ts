import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OSQUERYD_CANDIDATES, resolveOsqueryd } from './linuxConfig.js';

describe('osqueryd candidates on Linux', () => {
  it('covers osquery’s own layout, the distribution paths and a hand install', () => {
    expect(OSQUERYD_CANDIDATES).toEqual([
      '/opt/osquery/bin/osqueryd',
      '/usr/bin/osqueryd',
      '/usr/local/bin/osqueryd',
    ]);
  });

  it('picks the first candidate that exists', () => {
    const exists = (p: string) => p === '/usr/bin/osqueryd';
    expect(resolveOsqueryd(OSQUERYD_CANDIDATES, exists)).toBe('/usr/bin/osqueryd');
  });

  it('prefers osquery’s own /opt layout when both exist', () => {
    const exists = (p: string) => p === OSQUERYD_CANDIDATES[0] || p === '/usr/bin/osqueryd';
    expect(resolveOsqueryd(OSQUERYD_CANDIDATES, exists)).toBe('/opt/osquery/bin/osqueryd');
  });

  it('finds a distribution-packaged osqueryd the helper used to miss', () => {
    // Arch's extra/osquery installs to /usr/bin — the old hard-code never saw it.
    const exists = (p: string) => p === '/usr/bin/osqueryd';
    expect(resolveOsqueryd(['/opt/osquery/bin/osqueryd'], exists)).toBeUndefined();
    expect(resolveOsqueryd(OSQUERYD_CANDIDATES, exists)).toBe('/usr/bin/osqueryd');
  });

  it('answers undefined when no candidate exists', () => {
    expect(resolveOsqueryd(OSQUERYD_CANDIDATES, () => false)).toBeUndefined();
  });

  it('falls back to the real filesystem probe', () => {
    // Probe a file the test creates itself, with the real existsSync — no
    // assumption about what the host filesystem happens to contain (macOS
    // has no /usr/bin/ls, and runners differ).
    const dir = mkdtempSync(join(tmpdir(), 'vigil-osqueryd-'));
    const probe = join(dir, 'osqueryd');
    writeFileSync(probe, '#!/bin/sh\n');
    try {
      expect(resolveOsqueryd([probe, '/nowhere/osqueryd'])).toBe(probe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(resolveOsqueryd(['/nowhere/osqueryd'])).toBeUndefined();
  });
});
